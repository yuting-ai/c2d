"""Report Agent — synthesizes analysis results into a structured conclusion."""

import json
import logging
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)

REPORT_SYSTEM = """You are a data analyst writing a conclusion for your team. 
You receive a user's question and the SQL query results. Write a clear, concise answer.

Rules:
- Answer the user's question directly in 2-4 sentences
- Highlight key numbers and trends
- If the data shows something surprising or noteworthy, mention it
- Use natural language, not bullet points
- If the query returned no results or errored, explain what happened
- Reply in the same language as the user's question

User's question:
{user_query}

Table context:
{active_tables}

SQL results:
{sql_summary}
"""


async def report_agent(state: AgentState) -> dict:
    """Generate a natural language conclusion from SQL results."""

    sql_result = state.get("sql_result", {})
    
    # Build SQL summary for the prompt
    steps = sql_result.get("steps", [])
    final_columns = sql_result.get("final_columns", [])
    final_rows = sql_result.get("final_rows", [])
    error = sql_result.get("error")

    if error:
        sql_summary = f"Error: {error}"
    elif not final_rows:
        sql_summary = "Query returned 0 rows."
    else:
        # Format as readable text table (first 30 rows)
        header = " | ".join(str(c) for c in final_columns)
        rows_text = "\n".join(
            " | ".join(str(v) for v in row)
            for row in final_rows[:30]
        )
        sql_summary = f"Columns: {', '.join(final_columns)}\n{header}\n{rows_text}"
        if len(final_rows) > 30:
            sql_summary += f"\n... ({len(final_rows)} total rows, showing first 30)"

        # Add SQL queries for context
        for step in steps:
            sql_text = step.get("sql", "")
            if sql_text:
                sql_summary += f"\n\nSQL used:\n{sql_text}"

    # Build table context
    tables_text = ""
    for t in state.get("active_tables", []):
        tables_text += f"Table: {t['name']} ({t.get('row_count', '?')} rows) — columns: {', '.join(t.get('columns', []))}\n"

    prompt = REPORT_SYSTEM.format(
        user_query=state["user_query"],
        active_tables=tables_text.strip() or "No tables",
        sql_summary=sql_summary,
    )

    llm = get_llm(temperature=0.1)  # slight temperature for natural writing
    response = await llm.ainvoke([
        SystemMessage(content=prompt),
        HumanMessage(content="Write your conclusion now."),
    ])

    conclusion = response.content.strip()
    logger.info(f"Report Agent conclusion: {conclusion[:100]}...")

    # Progress event
    progress_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {len(steps)} {'query' if len(steps) == 1 else 'queries'}", "status": "done"},
                {"agent": "analyst", "label": "writing conclusion", "status": "done"},
            ]
        }
    }

    # Update sql_result with the proper answer
    updated_sql_result = {**sql_result, "answer": conclusion}

    return {
        "sql_result": updated_sql_result,
        "report": {
            "conclusion": conclusion,
            "should_record": bool(final_rows),
            "strategy_version": 1,
        },
        "should_record": bool(final_rows),
        "stream_events": [progress_event],
    }