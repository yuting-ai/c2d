"""SQL Agent — generates and executes SQL queries with self-correction."""

import json
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage
from backend.agents.base import get_llm
from backend.config.prompts import SQL_AGENT_SYSTEM, TABLE_SCHEMA_TEMPLATE
from backend.graph.state import AgentState
from backend.tools.sql_tools import create_sql_tools
from backend.db.engine import engine


MAX_ITERATIONS = 3


async def sql_agent(state: AgentState) -> dict:
    """Execute SQL queries to answer the planner's task."""

    project_id = state["project_id"]

    # Get read-only connection for sandbox
    try:
        conn = engine.get_connection(project_id)
    except FileNotFoundError:
        return {
            "sql_result": {"steps": [], "final_rows": [], "final_columns": [], "error": "No database found"},
            "stream_events": [_error_event("No database found for this project")],
        }

    # Create tools bound to this connection
    tools = create_sql_tools(conn)
    tool_map = {t.name: t for t in tools}

    # Build prompt
    tables_text = ""
    for t in state.get("active_tables", []):
        tables_text += TABLE_SCHEMA_TEMPLATE.format(
            name=t["name"],
            row_count=t.get("row_count", "?"),
            columns=", ".join(t.get("columns", [])),
        ) + "\n"

    quality_notes = "\n".join(state.get("quality_notes", [])) or "None"

    system = SQL_AGENT_SYSTEM.format(
        active_tables=tables_text.strip() or "No tables loaded",
        quality_notes=quality_notes,
    )

    llm = get_llm(temperature=0)
    llm_with_tools = llm.bind_tools(tools)

    messages = [
        SystemMessage(content=system),
        HumanMessage(content=state.get("sql_task", state["user_query"])),
    ]

    collected_steps = []
    events = []

    for iteration in range(MAX_ITERATIONS):
        # Call LLM
        response = await llm_with_tools.ainvoke(messages)
        messages.append(response)

        # Check if LLM wants to call tools
        if not response.tool_calls:
            # No more tool calls — SQL Agent is done
            break

        # Execute each tool call
        for tc in response.tool_calls:
            tool_name = tc["name"]
            tool_args = tc["args"]

            if tool_name in tool_map:
                result = await tool_map[tool_name].ainvoke(tool_args)
            else:
                result = f"Unknown tool: {tool_name}"

            # Record step
            sql_text = tool_args.get("sql", "")
            is_error = isinstance(result, str) and result.startswith("ERROR:")

            collected_steps.append({
                "title": f"query · step {len(collected_steps) + 1}",
                "sql": sql_text,
                "result_preview": str(result)[:500],
                "tag": "SQL Agent",
                "is_error": is_error,
            })

            # Emit progress
            step_label = f"querying data · step {len(collected_steps)}"
            if is_error:
                step_label += " · error, retrying"
            events.append({
                "type": "progress",
                "data": {
                    "steps": [
                        {"agent": "analyst", "label": "planning analysis", "status": "done"},
                        {"agent": "analyst", "label": step_label, "status": "active"},
                    ]
                }
            })

            # Feed result back to LLM
            messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))

    # Extract final results from the last successful step
    final_rows = []
    final_columns = []
    error = None

    # Find last non-error step
    for step in reversed(collected_steps):
        if not step.get("is_error"):
            # Parse the result preview to extract structured data
            # The actual structured data is from the sandbox, but we stored text preview
            # Re-execute the last successful query to get structured results
            from backend.db.sandbox import execute_sandboxed
            last_result = execute_sandboxed(conn, step["sql"])
            if not last_result.get("error"):
                final_rows = last_result["rows"]
                final_columns = last_result["columns"]
            break

    if not final_columns and collected_steps:
        error = "All SQL attempts failed"

    # Final progress event
    total_steps = len(collected_steps)
    events.append({
        "type": "progress",
        "data": {
            "steps": [
                {"agent": "analyst", "label": "planning analysis", "status": "done"},
                {"agent": "analyst", "label": f"querying data · {total_steps} {'query' if total_steps == 1 else 'queries'}", "status": "done"},
                {"agent": "analyst", "label": "writing conclusion", "status": "waiting"},
            ]
        }
    })

    # Build result event
    result_event = {
        "type": "result",
        "data": {
            "type": "sql",
            "steps": [
                {
                    "title": s["title"],
                    "sql": s["sql"],
                    "tag": s["tag"],
                    "row_count": len(final_rows) if s == collected_steps[-1] else None,
                }
                for s in collected_steps
            ],
        }
    }
    events.append(result_event)

    return {
        "sql_result": {
            "steps": collected_steps,
            "final_rows": final_rows[:100],  # Cap for SSE payload size
            "final_columns": final_columns,
            "error": error,
        },
        "stream_events": events,
    }


def _error_event(msg: str) -> dict:
    return {
        "type": "error",
        "data": {"code": "PIPELINE_ERROR", "message": msg, "agent": "analyst"},
    }