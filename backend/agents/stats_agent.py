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

# Keywords that trigger auto-Pearson as a fallback when intent_pattern != "P-G".
# Keep ONLY unambiguously correlation-specific terms.
# EXCLUDED intentionally:
#   "significant" / "significance" / "显著性" → also used in trend/group-comparison queries
#   "outlier" / "异常值"                       → standalone outlier detection, not correlation
_PG_CORRELATION_KEYWORDS = {
    "相关性",
    "correlation",
    "pearson",
    "p值", "p-value", "p value",
    "线性相关", "是否相关", "有无相关",
}


def run_pearson_test(x: list, y: list) -> dict:
    """Compute Pearson r, p-value, and IQR-based outliers for two numeric series.

    Args:
        x: first numeric series (already cleaned of NaN/None at call site)
        y: second numeric series of equal length

    Returns:
        dict with keys: pearson_r, p_value, significant, sample_size,
                        outlier_count, outlier_indices
    """
    x_arr = np.array(x, dtype=float)
    y_arr = np.array(y, dtype=float)

    r, p_value = sp_stats.pearsonr(x_arr, y_arr)

    def _iqr_outliers(arr: np.ndarray) -> np.ndarray:
        q1, q3 = np.percentile(arr, [25, 75])
        iqr = q3 - q1
        lower = q1 - 1.5 * iqr
        upper = q3 + 1.5 * iqr
        return np.where((arr < lower) | (arr > upper))[0]

    outlier_idx = np.union1d(_iqr_outliers(x_arr), _iqr_outliers(y_arr))

    return {
        "pearson_r":       round(float(r), 4),
        "p_value":         round(float(p_value), 6),
        "significant":     bool(p_value < 0.05),
        "sample_size":     int(len(x_arr)),
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
    start_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis",          "status": "done"},
                {"agent": "analyst", "label": f"querying data · {num_queries} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart",            "status": "done"},
                {"agent": "analyst", "label": "statistical analysis",        "status": "active"},
                {"agent": "analyst", "label": "writing conclusion",          "status": "waiting"},
            ]
        }
    }

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
                        # Use as primary pearson result if not already set
                        if pearson_result is None:
                            pearson_result = result
                        r_val = result["pearson_r"]
                        p_val = result["p_value"]
                        tests.append({
                            "key":         f"{col_x} ↔ {col_y} Pearson r",
                            "value":       f"r = {r_val:.4f}, p = {p_val:.6f}",
                            "significant": result["significant"],
                        })
                    except Exception as exc:
                        logger.warning("Stats Agent: correlation test failed: %s", exc)

    # If auto-pearson ran but correlation wasn't in LLM plan, add it to tests
    if pearson_result and not any(
        "pearson" in t.get("key", "").lower() or "correlation" in t.get("key", "").lower()
        for t in tests
    ):
        r_val  = pearson_result["pearson_r"]
        p_val  = pearson_result["p_value"]
        col_x  = pearson_result.get("col_x", "x")
        col_y  = pearson_result.get("col_y", "y")
        tests.append({
            "key":         f"{col_x} ↔ {col_y} Pearson r",
            "value":       f"r = {r_val:.4f}, p = {p_val:.6f}",
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
    done_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis",          "status": "done"},
                {"agent": "analyst", "label": f"querying data · {num_queries} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart",            "status": "done"},
                {"agent": "analyst", "label": f"statistical analysis · {len(tests)} tests{pearson_label}", "status": "done"},
                {"agent": "analyst", "label": "writing conclusion",          "status": "waiting"},
            ]
        }
    }

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
