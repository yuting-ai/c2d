"""Stats Agent — runs statistical tests and detects anomalies on SQL results."""

import json
import logging
import numpy as np
from scipy import stats as sp_stats
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)

STATS_SYSTEM = """You are a statistical analyst. Based on the SQL query results and the user's question,
decide which statistical tests to run and what to check.

Data columns: {columns}
Data preview (first 20 rows):
{data_preview}
Total rows: {row_count}

User's question: {user_query}

Available analyses:
- trend_test: Test if a numeric series has a significant trend (linear regression p-value, r²)
- compare_groups: Compare two or more groups (t-test or ANOVA)
- detect_outliers: Find values beyond 2σ from mean
- correlation: Test correlation between two numeric columns

Rules:
- Only run tests that are relevant to the user's question
- If no statistical test makes sense, return empty analyses
- Focus on answering "is this significant?" not just "what are the numbers?"

Respond with JSON only (no markdown fences):
{{
  "analyses": [
    {{
      "type": "trend_test",
      "column_x": "year",
      "column_y": "count",
      "description": "Test if game releases trend over time"
    }}
  ]
}}

If no tests needed:
{{
  "analyses": []
}}"""


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
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {num_queries} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart", "status": "done"},
                {"agent": "analyst", "label": "statistical analysis", "status": "active"},
                {"agent": "analyst", "label": "writing conclusion", "status": "waiting"},
            ]
        }
    }

    # Ask LLM what tests to run
    prompt = STATS_SYSTEM.format(
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
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    try:
        plan = json.loads(text)
    except json.JSONDecodeError:
        plan = {"analyses": []}

    analyses = plan.get("analyses", [])
    logger.info(f"Stats Agent: {len(analyses)} analyses planned")

    # Execute analyses
    tests = []
    outliers = []
    summary = {}

    # Build column data lookup
    col_data = {}
    for ci, col in enumerate(final_columns):
        values = []
        for row in final_rows:
            try:
                v = float(row[ci])
                values.append(v)
            except (ValueError, TypeError, IndexError):
                pass
        if values:
            col_data[col] = np.array(values)

    for analysis in analyses:
        atype = analysis.get("type", "")

        if atype == "trend_test":
            col_y = analysis.get("column_y", "")
            if col_y in col_data and len(col_data[col_y]) > 3:
                y = col_data[col_y]
                x = np.arange(len(y))
                slope, intercept, r, p, se = sp_stats.linregress(x, y)
                tests.append({"key": f"{col_y} trend significance", "value": f"p = {p:.4f}", "significant": p < 0.05})
                tests.append({"key": f"trend r² (linear fit)", "value": f"{r**2:.3f}"})
                if p < 0.05:
                    direction = "increasing" if slope > 0 else "decreasing"
                    tests.append({"key": "trend direction", "value": f"{direction} ({slope:.2f}/step)"})

        elif atype == "compare_groups":
            col_y = analysis.get("column_y", "")
            if col_y in col_data and len(col_data[col_y]) > 5:
                # Simple split: first half vs second half
                y = col_data[col_y]
                mid = len(y) // 2
                t_stat, p = sp_stats.ttest_ind(y[:mid], y[mid:])
                tests.append({"key": f"{col_y} group comparison", "value": f"p = {p:.4f}", "significant": p < 0.05})

        elif atype == "detect_outliers":
            for col_name, values in col_data.items():
                if len(values) > 5:
                    mean, std = values.mean(), values.std()
                    if std > 0:
                        z_scores = np.abs((values - mean) / std)
                        outlier_mask = z_scores > 2
                        for i, is_outlier in enumerate(outlier_mask):
                            if is_outlier:
                                # Try to get a label
                                label = str(final_rows[i][0]) if i < len(final_rows) else f"row {i}"
                                outliers.append({
                                    "icon": "△",
                                    "text": f"{col_name}: {label} = {values[i]:,.0f} (z = {z_scores[i]:.1f})"
                                })

        elif atype == "correlation":
            col_x = analysis.get("column_x", "")
            col_y = analysis.get("column_y", "")
            if col_x in col_data and col_y in col_data:
                min_len = min(len(col_data[col_x]), len(col_data[col_y]))
                if min_len > 3:
                    r, p = sp_stats.pearsonr(col_data[col_x][:min_len], col_data[col_y][:min_len])
                    tests.append({"key": f"{col_x} ↔ {col_y} correlation", "value": f"r = {r:.3f}, p = {p:.4f}", "significant": p < 0.05})

    # Build summary stats for numeric columns
    for col_name, values in col_data.items():
        summary[col_name] = {
            "mean": float(values.mean()),
            "median": float(np.median(values)),
            "std": float(values.std()),
            "min": float(values.min()),
            "max": float(values.max()),
        }

    # Done event
    done_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {num_queries} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart", "status": "done"},
                {"agent": "analyst", "label": f"statistical analysis · {len(tests)} tests", "status": "done"},
                {"agent": "analyst", "label": "writing conclusion", "status": "waiting"},
            ]
        }
    }

    stats_result = {
        "tests": tests,
        "outliers": outliers[:10],  # cap outliers
        "summary": summary,
    }

    logger.info(f"Stats Agent: {len(tests)} tests, {len(outliers)} outliers")

    return {
        "stats_result": stats_result,
        "stream_events": [start_event, done_event],
    }