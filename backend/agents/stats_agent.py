"""Stats Agent — runs statistical tests and detects anomalies on SQL results."""

import json
import logging
import numpy as np
from scipy import stats as sp_stats
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm
from backend.config.prompts import STATS_SYSTEM
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)

# Sampling thresholds for Pearson computation.
#   n ≤ MAX_FULL  → full calculation, no sampling   (scipy < 100ms)
#   n ≤ MAX_WARN  → random sample MAX_SAMPLE rows   (stat error < 0.005)
#   n > MAX_WARN  → refuse, ask user to add filters
MAX_FULL   = 100_000
MAX_SAMPLE = 100_000
MAX_WARN   = 5_000_000

# Keywords that trigger auto-Pearson as a fallback when intent_pattern != "P-G".
# Keep ONLY unambiguously correlation-specific terms.
# EXCLUDED intentionally:
#   "significant" / "significance" (zh: 显著性) → also used in trend/group-comparison queries
#   "outlier" (zh: 异常值)                       → standalone outlier detection, not correlation
_PG_CORRELATION_KEYWORDS = {
    "相关性",
    "correlation",
    "pearson",
    "p值", "p-value", "p value",
    "线性相关", "是否相关", "有无相关",
}


def _detect_outliers(arr: np.ndarray) -> tuple[np.ndarray, str]:
    """Adaptive outlier detection based on distribution skewness.

    - |skewness| > 1  → right/left-skewed (e.g. sales, revenue):
        log-transform then IQR, avoids flagging the natural long tail
    - |skewness| <= 1 → approximately normal:
        Z-score with threshold 3σ

    Returns (outlier_indices, method_name).
    """
    skewness = float(sp_stats.skew(arr))

    if abs(skewness) > 1:
        # Log-transform to compress the tail before IQR
        arr_log = np.log1p(arr - arr.min() + 1)
        q1, q3 = np.percentile(arr_log, [25, 75])
        iqr = q3 - q1
        lower = q1 - 1.5 * iqr
        upper = q3 + 1.5 * iqr
        idx = np.where((arr_log < lower) | (arr_log > upper))[0]
        return idx, "log+IQR"
    else:
        z_scores = np.abs(sp_stats.zscore(arr))
        idx = np.where(z_scores > 3)[0]
        return idx, "Z-score"


def run_pearson_test(x: list, y: list) -> dict:
    """Compute Pearson r, p-value, and adaptive outlier detection.

    Entry-point sampling / protection rules (applied before any computation):
      n ≤ MAX_FULL (100000)  → full calculation, no sampling  (scipy < 100ms)
      n ≤ MAX_WARN (5000000) → random sample MAX_SAMPLE rows  (stat error < 0.005)
      n > MAX_WARN           → return error dict; ask user to add filters

    Outlier method is chosen per-column based on skewness:
      |skew| > 1  → log+IQR  (right/left-skewed distributions)
      |skew| <= 1 → Z-score  (approximately normal)

    Returns dict with: pearson_r, p_value, p_display, significant,
                       total_size, sample_size, sampled, sample_note,
                       skewness_x, skewness_y, outlier_method,
                       outlier_count, outlier_indices
    """
    x_arr = np.array(x, dtype=float)
    y_arr = np.array(y, dtype=float)
    total_size = int(len(x_arr))

    # ── 1. Hard upper bound: refuse computation for extremely large datasets ──
    if total_size > MAX_WARN:
        return {
            "error":   True,
            "message": (
                f"Dataset too large ({total_size} rows). "
                "Please add filter conditions and retry, "
                "e.g. limit by year or another dimension."
            ),
        }

    # ── 2. Random sampling only when dataset exceeds MAX_FULL ──
    sample_note: str | None = None
    sampled = False
    if total_size > MAX_FULL:
        idx = np.random.choice(total_size, MAX_SAMPLE, replace=False)
        x_arr = x_arr[idx]
        y_arr = y_arr[idx]
        sampled = True
        sample_note = (
            f"Large dataset ({total_size} rows): "
            f"randomly sampled {MAX_SAMPLE} rows for computation. "
            "Statistical conclusions are unaffected."
        )
        logger.info(
            "run_pearson_test: sampled %d → %d rows", total_size, MAX_SAMPLE
        )

    # ── 3. Compute Pearson r ──
    r, p_value = sp_stats.pearsonr(x_arr, y_arr)

    # ── 4. p-value display (handle underflow to 0.0) ──
    p_display = (
        "< 0.000001"
        if float(p_value) < 0.000001
        else f"{float(p_value):.6f}"
    )

    skew_x = float(sp_stats.skew(x_arr))
    skew_y = float(sp_stats.skew(y_arr))

    idx_x, method_x = _detect_outliers(x_arr)
    idx_y, method_y = _detect_outliers(y_arr)
    outlier_idx = np.union1d(idx_x, idx_y)

    # Report the method used for the more skewed column (y is typically the metric)
    outlier_method = method_y if abs(skew_y) >= abs(skew_x) else method_x

    logger.info(
        "run_pearson_test: total=%d sample=%d sampled=%s "
        "skew_x=%.3f(%s) skew_y=%.3f(%s) outliers=%d",
        total_size, int(len(x_arr)), sampled,
        skew_x, method_x, skew_y, method_y, len(outlier_idx),
    )

    return {
        "pearson_r":       round(float(r), 4),
        "p_value":         round(float(p_value), 6),
        "p_display":       p_display,
        "significant":     bool(p_value < 0.05),
        "total_size":      total_size,
        "sample_size":     int(len(x_arr)),
        "sampled":         sampled,
        "sample_note":     sample_note,
        "skewness_x":      round(skew_x, 4),
        "skewness_y":      round(skew_y, 4),
        "outlier_method":  outlier_method,
        "outlier_count":   int(len(outlier_idx)),
        "outlier_indices": outlier_idx.tolist(),
    }


async def stats_agent(state: AgentState) -> dict:
    """Run statistical analyses on SQL results."""

    sql_result = state.get("sql_result", {})
    final_columns = sql_result.get("final_columns", [])
    final_rows = sql_result.get("final_rows", [])

    if not final_rows or sql_result.get("error"):
        return {"stats_result": {"tests": [], "outliers": [], "summary": {}}, "stream_events": []}

    # Build preview
    header = " | ".join(str(c) for c in final_columns)
    rows_text = "\n".join(" | ".join(str(v) for v in row) for row in final_rows[:20])

    sql_steps = sql_result.get("steps", [])
    num_queries = len(sql_steps)

    # Progress: running stats
    plan = state.get("plan", [])
    _start_steps = [
        {"agent": "analyst", "label": "planning analysis",          "status": "done"},
        {"agent": "analyst", "label": f"querying data · {num_queries} queries", "status": "done"},
    ]
    if "viz" in plan:
        _start_steps.append({"agent": "analyst", "label": "generating chart", "status": "done"})
    _start_steps.append({"agent": "analyst", "label": "statistical analysis", "status": "active"})
    _start_steps.append({"agent": "analyst", "label": "writing conclusion",    "status": "waiting"})
    start_event = {"type": "progress", "data": {"steps": _start_steps}}

    # ── Build numeric column lookup ──
    col_data: dict[str, np.ndarray] = {}
    for ci, col in enumerate(final_columns):
        values: list[float] = []
        for row in final_rows:
            try:
                values.append(float(row[ci]))
            except (ValueError, TypeError, IndexError):
                pass
        if values:
            col_data[col] = np.array(values)

    # ── Auto Pearson: trigger on P-G intent pattern OR correlation keywords ──
    pearson_result: dict | None = None
    intent_pattern = (state.get("intent_pattern") or "").upper()
    user_query_lower = (state.get("user_query") or "").lower()
    is_correlation_query = (
        intent_pattern == "P-G"
        or any(kw in user_query_lower for kw in _PG_CORRELATION_KEYWORDS)
    )

    if is_correlation_query and len(final_columns) >= 2:
        numeric_cols = [(col, col_data[col]) for col in final_columns if col in col_data]
        if len(numeric_cols) >= 2:
            col_x_name, x_vals = numeric_cols[0]
            col_y_name, y_vals = numeric_cols[1]
            min_len = min(len(x_vals), len(y_vals))
            if min_len >= 3:
                logger.info(
                    "Stats Agent: auto-running Pearson on %s × %s (n=%d)",
                    col_x_name, col_y_name, min_len,
                )
                try:
                    pearson_result = run_pearson_test(
                        x_vals[:min_len].tolist(),
                        y_vals[:min_len].tolist(),
                    )
                    pearson_result["col_x"] = col_x_name
                    pearson_result["col_y"] = col_y_name
                    if pearson_result.get("error"):
                        logger.warning(
                            "Stats Agent: auto-Pearson refused (n=%d): %s",
                            min_len, pearson_result.get("message"),
                        )
                except Exception as exc:
                    logger.warning("Stats Agent: auto-Pearson failed: %s", exc)

    # ── Ask LLM what additional tests to run ──
    prompt = STATS_SYSTEM.format(
        user_lang=state.get("user_lang", "en"),
        columns=", ".join(final_columns),
        data_preview=f"{header}\n{rows_text}",
        row_count=len(final_rows),
        user_query=state["user_query"],
    )

    llm = get_llm(temperature=0)
    response = await llm.ainvoke([
        SystemMessage(content=prompt),
        HumanMessage(content="Decide which statistical tests to run."),
    ])

    text = response.content.strip()
    if text.startswith("```"):
        lines = [l for l in text.split("\n") if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    try:
        plan = json.loads(text)
    except json.JSONDecodeError:
        plan = {"analyses": []}

    analyses = plan.get("analyses", [])
    logger.info("Stats Agent: %d analyses planned", len(analyses))

    # ── Execute LLM-planned analyses ──
    tests: list[dict] = []
    outliers: list[dict] = []
    summary: dict = {}

    for analysis in analyses:
        atype = analysis.get("type", "")

        if atype == "trend_test":
            col_y = analysis.get("column_y", "")
            if col_y in col_data and len(col_data[col_y]) > 3:
                y = col_data[col_y]
                x = np.arange(len(y))
                slope, _intercept, r, p, _se = sp_stats.linregress(x, y)
                tests.append({"key": f"{col_y} trend significance", "value": f"p = {p:.4f}", "significant": p < 0.05})
                tests.append({"key": "trend r² (linear fit)",         "value": f"{r**2:.3f}"})
                if p < 0.05:
                    direction = "increasing" if slope > 0 else "decreasing"
                    tests.append({"key": "trend direction", "value": f"{direction} ({slope:.2f}/step)"})

        elif atype == "compare_groups":
            col_y = analysis.get("column_y", "")
            if col_y in col_data and len(col_data[col_y]) > 5:
                y = col_data[col_y]
                mid = len(y) // 2
                _t, p = sp_stats.ttest_ind(y[:mid], y[mid:])
                tests.append({"key": f"{col_y} group comparison", "value": f"p = {p:.4f}", "significant": p < 0.05})

        elif atype == "detect_outliers":
            for col_name, values in col_data.items():
                if len(values) > 5:
                    mean, std = values.mean(), values.std()
                    if std > 0:
                        z_scores = np.abs((values - mean) / std)
                        for i, is_out in enumerate(z_scores > 2):
                            if is_out:
                                label = str(final_rows[i][0]) if i < len(final_rows) else f"row {i}"
                                outliers.append({
                                    "icon": "△",
                                    "text": f"{col_name}: {label} = {values[i]:,.0f} (z = {z_scores[i]:.1f})"
                                })

        elif atype in ("correlation", "pearson_correlation"):
            col_x = analysis.get("column_x", "")
            col_y = analysis.get("column_y", "")
            if col_x in col_data and col_y in col_data:
                min_len = min(len(col_data[col_x]), len(col_data[col_y]))
                if min_len >= 3:
                    try:
                        result = run_pearson_test(
                            col_data[col_x][:min_len].tolist(),
                            col_data[col_y][:min_len].tolist(),
                        )
                        result["col_x"] = col_x
                        result["col_y"] = col_y
                        if result.get("error"):
                            logger.warning(
                                "Stats Agent: correlation refused: %s",
                                result.get("message"),
                            )
                        else:
                            # Use as primary pearson result if not already set
                            if pearson_result is None:
                                pearson_result = result
                            r_val   = result["pearson_r"]
                            p_disp  = result.get("p_display", f"{result['p_value']:.6f}")
                            tests.append({
                                "key":         f"{col_x} ↔ {col_y} Pearson r",
                                "value":       f"r = {r_val:.4f}, p = {p_disp}",
                                "significant": result["significant"],
                            })
                    except Exception as exc:
                        logger.warning("Stats Agent: correlation test failed: %s", exc)

    # If auto-pearson ran but correlation wasn't in LLM plan, add it to tests
    if pearson_result and not pearson_result.get("error") and not any(
        "pearson" in t.get("key", "").lower() or "correlation" in t.get("key", "").lower()
        for t in tests
    ):
        r_val  = pearson_result["pearson_r"]
        p_disp = pearson_result.get("p_display", f"{pearson_result['p_value']:.6f}")
        col_x  = pearson_result.get("col_x", "x")
        col_y  = pearson_result.get("col_y", "y")
        tests.append({
            "key":         f"{col_x} ↔ {col_y} Pearson r",
            "value":       f"r = {r_val:.4f}, p = {p_disp}",
            "significant": pearson_result["significant"],
        })

    # ── Build summary stats for numeric columns ──
    for col_name, values in col_data.items():
        summary[col_name] = {
            "mean":   float(values.mean()),
            "median": float(np.median(values)),
            "std":    float(values.std()),
            "min":    float(values.min()),
            "max":    float(values.max()),
        }

    # ── Done event ──
    pearson_label = f" · r={pearson_result['pearson_r']}" if pearson_result else ""
    _done_steps = [
        {"agent": "analyst", "label": "planning analysis",          "status": "done"},
        {"agent": "analyst", "label": f"querying data · {num_queries} queries", "status": "done"},
    ]
    if "viz" in plan:
        _done_steps.append({"agent": "analyst", "label": "generating chart", "status": "done"})
    _done_steps.append({"agent": "analyst", "label": f"statistical analysis · {len(tests)} tests{pearson_label}", "status": "done"})
    _done_steps.append({"agent": "analyst", "label": "writing conclusion",    "status": "waiting"})
    done_event = {"type": "progress", "data": {"steps": _done_steps}}

    stats_result: dict = {
        "tests":    tests,
        "outliers": outliers[:10],
        "summary":  summary,
    }
    if pearson_result is not None:
        stats_result["pearson"] = pearson_result

    logger.info(
        "Stats Agent: %d tests, %d outliers, pearson=%s",
        len(tests), len(outliers), "yes" if pearson_result else "no",
    )

    return {
        "stats_result":  stats_result,
        "stream_events": [start_event, done_event],
    }
