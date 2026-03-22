"""Viz Agent — selects chart type and outputs structured data for frontend rendering."""

import json
import logging
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)

VIZ_SYSTEM = """You are a data visualization specialist. Based on the SQL query results,
choose the best chart type and output structured data for rendering.

Available chart types: line, area, bar, pie, scatter

Data from SQL query:
Columns: {columns}
Data (first 30 rows):
{data_preview}
Total rows: {row_count}

User's original question: {user_query}

Rules:
- Choose the chart type that best communicates the data story
- Output alt_types: 2-3 alternative types that also make sense (table is always added by frontend)
- For time series → prefer line, alt: [area, bar]
- For categories (≤7) → prefer bar, alt: [pie]
- For categories (>7) → prefer bar, alt: []
- For two continuous variables → prefer scatter
- For composition/proportion → prefer pie, alt: [bar]
- x values should be the dimension (categories, dates), y values should be measures (numbers)
- If multiple series, output one series per group
- Keep series names short and clear

Respond with JSON only (no markdown fences):
{{
  "type": "line",
  "alt_types": ["area", "bar"],
  "title": "Monthly Revenue by Region",
  "x_label": "Month",
  "y_label": "Revenue",
  "series": [
    {{"name": "East", "x": ["Jan", "Feb"], "y": [124800, 138200]}}
  ]
}}"""


async def viz_agent(state: AgentState) -> dict:
    """Generate structured chart data from SQL results."""

    sql_result = state.get("sql_result", {})
    final_columns = sql_result.get("final_columns", [])
    final_rows = sql_result.get("final_rows", [])
    error = sql_result.get("error")

    # Skip if SQL failed or no data
    if error or not final_rows:
        logger.info("Viz Agent skipped — no data to visualize")
        return {
            "viz_result": None,
            "stream_events": [],
        }

    # Build data preview
    header = " | ".join(str(c) for c in final_columns)
    rows_text = "\n".join(
        " | ".join(str(v) for v in row)
        for row in final_rows[:30]
    )
    data_preview = f"{header}\n{rows_text}"

    prompt = VIZ_SYSTEM.format(
        columns=", ".join(final_columns),
        data_preview=data_preview,
        row_count=len(final_rows),
        user_query=state["user_query"],
    )

    # Progress: generating chart
    start_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {len(sql_result.get('steps', []))} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart", "status": "active"},
                {"agent": "analyst", "label": "writing conclusion", "status": "waiting"},
            ]
        }
    }

    llm = get_llm(temperature=0)
    response = await llm.ainvoke([
        SystemMessage(content=prompt),
        HumanMessage(content="Generate the chart data now."),
    ])

    text = response.content.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    try:
        chart_data = json.loads(text)
    except json.JSONDecodeError:
        logger.warning(f"Failed to parse viz output: {text[:200]}")
        chart_data = None

    if not chart_data:
        return {
            "viz_result": None,
            "stream_events": [start_event],
        }

    # Validate and normalize
    viz_result = {
        "type": chart_data.get("type", "bar"),
        "alt_types": chart_data.get("alt_types", []),
        "title": chart_data.get("title", ""),
        "x_label": chart_data.get("x_label", ""),
        "y_label": chart_data.get("y_label", ""),
        "series": chart_data.get("series", []),
    }

    # Also build table_data for the table view
    viz_result["table_data"] = {
        "headers": final_columns,
        "rows": final_rows[:100],
    }

    logger.info(f"Viz Agent: type={viz_result['type']}, series={len(viz_result['series'])}, alt_types={viz_result['alt_types']}")

    # Done event
    done_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {len(sql_result.get('steps', []))} queries", "status": "done"},
                {"agent": "analyst", "label": "generating chart", "status": "done"},
                {"agent": "analyst", "label": "writing conclusion", "status": "waiting"},
            ]
        }
    }

    # Result event for frontend
    result_event = {
        "type": "result",
        "data": {
            "type": "viz",
            "chart_type": viz_result["type"],
            "alt_types": viz_result["alt_types"],
            "title": viz_result["title"],
            "x_label": viz_result["x_label"],
            "y_label": viz_result["y_label"],
            "series": viz_result["series"],
            "table_data": viz_result["table_data"],
        }
    }

    return {
        "viz_result": viz_result,
        "stream_events": [start_event, result_event, done_event],
    }