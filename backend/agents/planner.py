"""Planner Agent — understands user intent, decides which workers to activate or answers directly."""

import json
import logging
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm
from backend.config.prompts import PLANNER_SYSTEM, TABLE_SCHEMA_TEMPLATE
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)


async def planner_agent(state: AgentState) -> dict:
    """Plan analysis: decide which agents to activate, or answer directly."""

    # Build table context
    tables_text = ""
    for t in state.get("active_tables", []):
        tables_text += TABLE_SCHEMA_TEMPLATE.format(
            name=t["name"],
            row_count=t.get("row_count", "?"),
            columns=", ".join(t.get("columns", [])),
        ) + "\n"

    quality_notes = "\n".join(state.get("quality_notes", [])) or "None"

    # Build prompt
    system = PLANNER_SYSTEM.format(
        active_tables=tables_text.strip() or "No tables loaded",
        quality_notes=quality_notes,
    )

    llm = get_llm(temperature=0)
    response = await llm.ainvoke([
        SystemMessage(content=system),
        HumanMessage(content=state["user_query"]),
    ])

    # Parse JSON response
    text = response.content.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        logger.warning(f"Failed to parse planner output: {text[:200]}")
        parsed = {
            "plan": ["sql"],
            "sql_task": state["user_query"],
            "involved_columns": [],
            "reasoning": "Failed to parse planner output, falling back to SQL",
        }

    plan = parsed.get("plan", [])
    direct_answer = parsed.get("direct_answer")
    reasoning = parsed.get("reasoning", "")

    logger.info(f"Planner decision: plan={plan}, direct={'yes' if direct_answer else 'no'}, reason={reasoning[:80]}")

    # ── Direct answer path: no workers needed ──
    if not plan and direct_answer:
        progress_event = {
            "type": "progress",
            "data": {
                "steps": [
                    {"agent": "analyst", "label": "answering from schema context", "status": "done"},
                ]
            }
        }

        return {
            "plan": [],
            "sql_task": "",
            "viz_task": None,
            "stats_task": None,
            "involved_columns": parsed.get("involved_columns", []),
            # Store direct answer in sql_result so SSE can pick it up
            "sql_result": {
                "steps": [],
                "final_rows": [],
                "final_columns": [],
                "error": None,
                "answer": direct_answer,
            },
            "stream_events": [progress_event],
        }

    # ── Worker activation path ──
    sql_task = parsed.get("sql_task", state["user_query"])
    progress_event = {
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": sql_task[:60], "status": "waiting"},
            ]
        }
    }

    return {
        "plan": plan if plan else ["sql"],
        "sql_task": parsed.get("sql_task", state["user_query"]),
        "viz_task": parsed.get("viz_task"),
        "stats_task": parsed.get("stats_task"),
        "involved_columns": parsed.get("involved_columns", []),
        "stream_events": [progress_event],
    }