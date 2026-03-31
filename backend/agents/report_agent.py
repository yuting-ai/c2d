"""Report Agent - synthesizes all analysis results into a structured conclusion."""

import logging
from collections import defaultdict

from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm
from backend.config.prompts import REPORT_SYSTEM
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)

# Ranks embedded in DATA_FACTS per group (and expected table row count when data has that many rows).
DATA_FACTS_TOP_RANKS = 3


def _format_pearson_block(pearson: dict, user_lang: str) -> str:
    """Programmatically format a Pearson correlation result block for the report.

    This is injected *after* the LLM conclusion so the statistical numbers are
    always precise and machine-verified, not paraphrased by the LLM.
    """
    r               = pearson.get("pearson_r", "—")
    _p_raw          = pearson.get("p_value", None)
    p_value         = (
        "< 0.000001" if isinstance(_p_raw, (int, float)) and _p_raw < 0.000001
        else (f"{_p_raw:.6f}" if isinstance(_p_raw, (int, float)) else "—")
    )
    significant     = pearson.get("significant", False)
    sample_size     = pearson.get("sample_size", "—")
    outlier_count   = pearson.get("outlier_count", 0)
    outlier_method  = pearson.get("outlier_method", "IQR")
    skewness_x      = pearson.get("skewness_x")
    skewness_y      = pearson.get("skewness_y")
    col_x           = pearson.get("col_x", "x")
    col_y           = pearson.get("col_y", "y")

    abs_r = abs(float(r)) if isinstance(r, (int, float)) else 0.0
    is_zh = user_lang.startswith("zh")

    # Skewness note for whichever column triggered the adaptive method
    skew_note = ""
    if skewness_y is not None and outlier_method == "log+IQR":
        if is_zh:
            skew_note = f"{col_y} 呈右偏分布（偏度 = {skewness_y}），已自动切换为对数变换 + IQR 方法识别异常值。"
        else:
            skew_note = f"{col_y} is right-skewed (skewness = {skewness_y}); automatically switched to log+IQR for outlier detection."
    elif skewness_y is not None and outlier_method == "Z-score":
        if is_zh:
            skew_note = f"数据分布接近正态（{col_y} 偏度 = {skewness_y}），使用 Z-score 方法（阈值 = 3σ）识别异常值。"
        else:
            skew_note = f"Distribution is approximately normal ({col_y} skewness = {skewness_y}); using Z-score method (threshold = 3σ)."

    if is_zh:
        strength  = "强相关" if abs_r >= 0.7 else ("中等相关" if abs_r >= 0.3 else "弱相关")
        direction = "正" if float(r) > 0 else "负"
        sig_text  = "两变量存在统计显著相关性（p < 0.05）" if significant else "两变量无统计显著相关性（p ≥ 0.05）"
        skew_x_str = f"{skewness_x}" if skewness_x is not None else "—"
        skew_y_str = f"{skewness_y}" if skewness_y is not None else "—"
        lines = [
            f"**Pearson 相关性分析 — {col_x} × {col_y}**",
            "",
            f"- Pearson 相关系数 (r)：**{r}**",
            f"- p 值：**{p_value}**",
            f"- 显著性 (α = 0.05)：**{'显著' if significant else '不显著'}**",
            f"- 样本量：{sample_size}",
            f"- {col_x} 偏度：{skew_x_str}",
            f"- {col_y} 偏度：{skew_y_str}",
            f"- 异常值检测方法：{outlier_method}",
            f"- 异常值数量：{outlier_count}",
            "",
            f"**结论**：{sig_text}，{direction}向{strength}（|r| = {abs_r:.4f}）。",
        ]
        if skew_note:
            lines.append(f"*{skew_note}*")
    else:
        strength  = "strong" if abs_r >= 0.7 else ("moderate" if abs_r >= 0.3 else "weak")
        direction = "positive" if float(r) > 0 else "negative"
        sig_text  = "statistically significant (p < 0.05)" if significant else "not statistically significant (p ≥ 0.05)"
        skew_x_str = f"{skewness_x}" if skewness_x is not None else "—"
        skew_y_str = f"{skewness_y}" if skewness_y is not None else "—"
        lines = [
            f"**Pearson Correlation — {col_x} × {col_y}**",
            "",
            f"- Pearson r: **{r}**",
            f"- p-value: **{p_value}**",
            f"- Significant (α = 0.05): **{'Yes' if significant else 'No'}**",
            f"- Sample size: {sample_size}",
            f"- {col_x} skewness: {skew_x_str}",
            f"- {col_y} skewness: {skew_y_str}",
            f"- Outlier method: {outlier_method}",
            f"- Outlier count: {outlier_count}",
            "",
            f"**Conclusion**: {sig_text} — {direction} {strength} correlation (|r| = {abs_r:.4f}).",
        ]
        if skew_note:
            lines.append(f"*{skew_note}*")

    return "\n".join(lines)


def _float_cell(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip().replace(",", "")
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _format_fact_cell(value) -> str:
    """Format measure cells in DATA_FACTS: two decimal places when numeric."""
    f = _float_cell(value)
    if f is not None:
        return f"{round(f, 2):.2f}"
    return str(value)


def _dominant_numeric_measure_index(columns: list, rows: list, skip: set[int]) -> int | None:
    """When named measure heuristics miss, pick the column with the most parseable numeric cells."""
    if not rows:
        return None
    best_i: int | None = None
    best_n = -1
    for i in range(len(columns)):
        if i in skip:
            continue
        n = sum(1 for r in rows if len(r) > i and _float_cell(r[i]) is not None)
        if n > best_n:
            best_n = n
            best_i = i
    return best_i if best_n > 0 else None


def _infer_fallback_label_index(columns: list, rows: list, skip: set[int]) -> int | None:
    """Prefer a mostly non-numeric column with several distinct values (category / label)."""
    best_i: int | None = None
    best_u = 0
    for i in range(len(columns)):
        if i in skip:
            continue
        vals = [r[i] for r in rows if len(r) > i]
        if not vals:
            continue
        num_ratio = sum(1 for v in vals if _float_cell(v) is not None) / max(len(vals), 1)
        if num_ratio > 0.85:
            continue
        u = len({str(v) for v in vals if v is not None and v != ""})
        if u >= 2 and u > best_u:
            best_u = u
            best_i = i
    if best_i is not None:
        return best_i
    for i in range(len(columns)):
        if i not in skip:
            return i
    return None


def _serialize_raw_data_facts(columns: list, rows: list, max_rows: int = 3) -> str:
    """Last-resort factual block: first rows verbatim (never empty when rows exist)."""
    parts: list[str] = []
    for idx, r in enumerate(rows[:max_rows], start=1):
        pairs = [
            f"{columns[j]}={_format_fact_cell(r[j])}"
            for j in range(min(len(columns), len(r)))
        ]
        parts.append(f"#{idx} " + " | ".join(pairs))
    return " / ".join(parts) if parts else "(structure unresolved)"


def _find_year_and_measure_columns(columns: list) -> tuple[int | None, int | None]:
    """Pick a time bucket column and a primary additive/scalar measure column (any typical BI fact)."""
    norm = [str(c).lower().strip() for c in columns]
    yi = None
    for i, n in enumerate(norm):
        if n in ("year", "grp_year", "yr", "period", "month"):
            yi = i
            break
        if n.endswith("_year") and "month" not in n:
            yi = i
            break
    mi = None
    candidates: list[tuple[int, int]] = []
    for i, n in enumerate(norm):
        if "score" in n:
            continue
        cl = n.replace(" ", "").replace("_", "")
        # Lower score = stronger match for common fact/measure column names (domain-agnostic).
        score = 9
        if "total" in n and ("sales" in n or "revenue" in n or "amount" in n):
            score = 0
        elif cl.endswith("sales") or n in ("sales", "revenue", "turnover"):
            score = 1
        elif n in ("amount", "total_amount", "net_amount", "quantity", "qty", "volume", "units"):
            score = 2
        elif n.startswith("total_") or n.endswith("_total"):
            score = 3
        elif n in ("cnt", "count", "n", "num") or cl.endswith("count"):
            score = 4
        elif "value" in n or "volume" in n:
            score = 5
        else:
            continue
        candidates.append((score, i))
    if candidates:
        candidates.sort(key=lambda t: (t[0], t[1]))
        mi = candidates[0][1]
    return yi, mi


_GROUP_DIM_HINTS = (
    "region",
    "country",
    "state",
    "city",
    "province",
    "area",
    "zone",
    "district",
    "category",
    "segment",
    "genre",
    "channel",
    "department",
    "territory",
    "product",
    "sku",
    "brand",
    "type",
    "quarter",
    "week",
    "day",
)


def _infer_group_column_index(
    columns: list, rows: list, mi: int, ri: int | None
) -> int | None:
    """Pick a grouping dimension when no year-like column exists."""
    norm = [str(c).lower().strip() for c in columns]
    n_rows = len(rows)
    for i, n in enumerate(norm):
        if i == mi or (ri is not None and i == ri):
            continue
        if any(h in n for h in _GROUP_DIM_HINTS):
            vals = [r[i] for r in rows if len(r) > i]
            u = len({str(v) for v in vals if v is not None and v != ""})
            # Almost one distinct value per row => ranked entity / label, not a partition bucket (e.g. genre in top-N-by-genre).
            if n_rows and u >= max(2, n_rows - 1):
                continue
            return i
    best_i = None
    best_u: int | None = None
    for i in range(len(columns)):
        if i == mi or (ri is not None and i == ri):
            continue
        vals = [r[i] for r in rows if len(r) > i]
        if not vals:
            continue
        u = len({str(v) for v in vals if v is not None and v != ""})
        if u < 2:
            continue
        if u > len(rows) * 0.95:
            continue
        if best_u is None or u < best_u:
            best_u = u
            best_i = i
    return best_i


def _find_group_and_measure(columns: list, rows: list) -> tuple[int | None, int | None]:
    """Time/year column wins as group key; else heuristic dimension + measure."""
    yi, mi = _find_year_and_measure_columns(columns)
    ri = _rank_column_index(columns)
    if mi is None and rows:
        sk = {x for x in (ri,) if x is not None}
        mi = _dominant_numeric_measure_index(columns, rows, sk)
    if not rows:
        return yi, mi
    if mi is None:
        return yi, None
    gi = yi
    if gi is None:
        gi = _infer_group_column_index(columns, rows, mi, ri)
    return gi, mi


def _sort_rows_for_group_measure(columns: list, rows: list) -> list:
    """Within each group bucket (if any), order rows by primary measure descending."""
    if not rows:
        return []
    gi, mi = _find_group_and_measure(columns, rows)
    if mi is None:
        return list(rows)

    def measure_key(row: list) -> float:
        if len(row) <= mi:
            return float("-inf")
        v = _float_cell(row[mi])
        return v if v is not None else float("-inf")

    if gi is None:
        return sorted(list(rows), key=measure_key, reverse=True)

    max_idx = max(gi, mi)
    by_g: dict = defaultdict(list)
    order: list = []
    for r in rows:
        if len(r) <= max_idx:
            continue
        g = r[gi]
        if g not in by_g:
            order.append(g)
        by_g[g].append(r)
    out: list = []
    for g in order:
        grp = sorted(by_g[g], key=measure_key, reverse=True)
        out.extend(grp)
    return out if out else list(rows)


def _rank_column_index(columns: list) -> int | None:
    for i, c in enumerate(columns):
        n = str(c).lower().strip()
        if n in ("rn", "rank", "row_number", "row_num"):
            return i
    return None


def _label_column_index(columns: list, group_idx: int | None, mi: int) -> int | None:
    ri = _rank_column_index(columns)
    skip = {mi}
    if group_idx is not None:
        skip.add(group_idx)
    if ri is not None:
        skip.add(ri)
    norm = [str(c).lower().strip() for c in columns]
    for i, n in enumerate(norm):
        if i in skip:
            continue
        if any(
            k in n
            for k in (
                "category",
                "segment",
                "type",
                "region",
                "channel",
                "product",
                "name",
                "genre",
                "sku",
                "label",
            )
        ):
            return i
    for i in range(len(columns)):
        if i not in skip:
            return i
    return None


def _build_ranked_data_facts(columns: list, rows: list) -> str:
    """Compact #1/#2/#3 per group (or overall) from sorted rows; ground truth for the model."""
    if not columns or not rows:
        return "(No rows - DATA_FACTS empty.)"
    rows_sorted = _sort_rows_for_group_measure(columns, rows)
    gi, mi = _find_group_and_measure(columns, rows)
    ri = _rank_column_index(columns)
    raw_fallback = "Overall: " + _serialize_raw_data_facts(columns, rows_sorted)

    if mi is None:
        return raw_fallback

    li = _label_column_index(columns, gi, mi)
    if li is None:
        skip_lbl = {i for i in (gi, mi, ri) if i is not None}
        li = _infer_fallback_label_index(columns, rows_sorted, skip_lbl)
    if li is None:
        return raw_fallback

    if gi is None:
        parts: list[str] = []
        max_idx = max(mi, li)
        shown = 0
        for r in rows_sorted:
            if shown >= DATA_FACTS_TOP_RANKS:
                break
            if len(r) <= max_idx:
                continue
            shown += 1
            parts.append(f"#{shown} {r[li]} = {_format_fact_cell(r[mi])}")
        if not parts:
            return raw_fallback
        return "Overall: " + " | ".join(parts)

    max_idx = max(gi, mi, li)
    by_g: dict = defaultdict(list)
    order: list = []
    for r in rows_sorted:
        if len(r) <= max_idx:
            continue
        g = r[gi]
        if g not in by_g:
            order.append(g)
        by_g[g].append(r)
    if not order:
        return raw_fallback
    gcol = str(columns[gi])
    lines = []
    for g in order:
        grp = by_g[g]
        parts = []
        rank = 0
        for r in grp:
            if rank >= DATA_FACTS_TOP_RANKS:
                break
            if len(r) <= max_idx:
                continue
            rank += 1
            parts.append(f"#{rank} {r[li]} = {_format_fact_cell(r[mi])}")
        line_body = " | ".join(parts)
        if line_body:
            lines.append(f"{gcol} {g}: " + line_body)
    if not lines:
        return raw_fallback
    return "\n".join(lines)


async def report_agent(state: AgentState) -> dict:
    """Generate a natural language conclusion from all analysis results."""

    sql_result = state.get("sql_result", {})
    stats_result = state.get("stats_result") or {}
    critic_feedback = state.get("critic_feedback", "")

    # Build SQL summary
    steps = sql_result.get("steps", [])
    final_columns = sql_result.get("final_columns", [])
    final_rows = sql_result.get("final_rows", [])
    error = sql_result.get("error")

    if error:
        sql_summary = f"Error: {error}"
    elif not final_rows:
        sql_summary = "Query returned 0 rows."
    else:
        rows_for_preview = _sort_rows_for_group_measure(final_columns, final_rows)
        g_idx, m_idx = _find_group_and_measure(final_columns, final_rows)
        if g_idx is not None and m_idx is not None:
            sort_desc = (
                f"Rows are grouped by `{final_columns[g_idx]}`; within each group, sorted by "
                "the primary numeric measure (highest first). The first row in each block is #1 for that group."
            )
        elif m_idx is not None:
            sort_desc = (
                "Rows are sorted by the primary numeric measure (highest first) for reading."
            )
        else:
            sort_desc = "Row order as returned (no group/measure heuristic applied)."
        # Format as readable text table (first 30 rows)
        header = " | ".join(str(c) for c in final_columns)
        rows_text = "\n".join(
            " | ".join(str(v) for v in row) for row in rows_for_preview[:30]
        )
        sql_summary = (
            f"{sort_desc}\n"
            f"Columns: {', '.join(str(c) for c in final_columns)}\n{header}\n{rows_text}"
        )
        if len(rows_for_preview) > 30:
            sql_summary += f"\n... ({len(rows_for_preview)} total rows; preview shows first 30 only.)"

        # Add SQL queries for context
        for step in steps:
            sql_text = step.get("sql", "")
            if sql_text:
                sql_summary += f"\n\nSQL used:\n{sql_text}"

    # Build table context
    tables_text = ""
    for t in state.get("active_tables", []):
        tables_text += f"Table: {t['name']} ({t.get('row_count', '?')} rows) - columns: {', '.join(t.get('columns', []))}\n"

    # Build stats summary
    stats_tests = stats_result.get("tests", [])
    stats_summary = "None"
    if stats_tests:
        stats_summary = "\n".join(f"- {t['key']}: {t['value']}" for t in stats_tests)
        outliers = stats_result.get("outliers", [])
        if outliers:
            stats_summary += "\nOutliers:\n" + "\n".join(f"- {o['text']}" for o in outliers)

    ranked_facts = ""
    if not error and final_rows and final_columns:
        ranked_facts = _build_ranked_data_facts(final_columns, final_rows)

    prompt = REPORT_SYSTEM.format(
        user_lang=state.get("user_lang", "en"),
        ranked_data_facts=ranked_facts,
        user_query=state["user_query"],
        active_tables=tables_text.strip() or "No tables",
        sql_summary=sql_summary,
        stats_summary=stats_summary,
        critic_feedback=critic_feedback or "No issues found",
    )

    logger.info(
        "Report Agent prompt: ranked_data_facts block length=%s, preview=%r",
        len(ranked_facts),
        ranked_facts[:280] + ("..." if len(ranked_facts) > 280 else ""),
    )

    llm = get_llm(temperature=0)
    response = await llm.ainvoke(
        [
            SystemMessage(content=prompt),
            HumanMessage(
                content=(
                    "Write the report (Parts 1-4): two-line title+scope; Part 2 = **prose/bullets only** - "
                    "**no** pipe Markdown tables, **no** ``` fences around data. Cover every rank DATA_FACTS gives per group "
                    f"(up to {DATA_FACTS_TOP_RANKS}) with correct two-decimal values; single-year/single-slice -> one list, not many fragments. "
                    "Then at most 3-sentence trend (Part 3 rules), optional footnote. Honor DATA_FACTS; no false 'always #1'."
                )
            ),
        ]
    )

    conclusion = response.content.strip()
    logger.info(f"Report Agent conclusion: {conclusion[:100]}...")

    # Inject Pearson block at the top when stats_agent produced one.
    # Done programmatically so numbers are always exact, not LLM-paraphrased.
    pearson = stats_result.get("pearson") if stats_result else None
    if pearson:
        user_lang = state.get("user_lang", "en")
        pearson_block = _format_pearson_block(pearson, user_lang)
        conclusion = pearson_block + "\n\n---\n\n" + conclusion
        logger.info("Report Agent: prepended Pearson block (r=%s, p=%s)", pearson.get("pearson_r"), pearson.get("p_value"))

    # Build progress event with all completed steps
    plan = state.get("plan", [])
    progress_steps = [
        {"agent": "analyst", "label": "planning analysis", "status": "done"},
        {"agent": "analyst", "label": f"querying data · {len(steps)} {'query' if len(steps) == 1 else 'queries'}", "status": "done"},
    ]
    if "viz" in plan:
        progress_steps.append({"agent": "analyst", "label": "generating chart", "status": "done"})
    if "stats" in plan and stats_tests:
        progress_steps.append({"agent": "analyst", "label": f"statistical analysis · {len(stats_tests)} tests", "status": "done"})
    if state.get("critic_verdict"):
        progress_steps.append({"agent": "analyst", "label": "reviewing results", "status": "done"})
    progress_steps.append({"agent": "analyst", "label": "writing conclusion", "status": "done"})

    done_event = {"type": "progress", "data": {"steps": progress_steps}}

    return {
        "report": {
            "conclusion": conclusion,
            "should_record": bool(final_rows) and not error,
            "strategy_version": 1,
            "evidence": None,
        },
        "stream_events": [done_event],
    }
