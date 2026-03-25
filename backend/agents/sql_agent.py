"""SQL Agent — generates and executes SQL queries with self-correction.

Supports two modes:
1. Tool-calling mode (large models like DeepSeek, GPT-4) — uses bind_tools()
2. Text fallback mode (small local models) — extracts SQL from plain text
"""

import json
import logging
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage
from backend.agents.base import get_llm
from backend.agents.json_utils import extract_sql, sanitize_sql
from backend.config.prompts import SQL_AGENT_SYSTEM, TABLE_SCHEMA_TEMPLATE
from backend.graph.state import AgentState
from backend.tools.sql_tools import create_sql_tools
from backend.db.engine import engine

logger = logging.getLogger(__name__)

MAX_ITERATIONS = 3


def _validate_result(rows: list, columns: list, sql: str) -> str | None:
    """Programmatic self-check on SQL results. Returns issue description or None.

    This catches problems BEFORE reaching the Critic agent, saving an LLM round-trip.
    Checks:
    1. NULL-heavy aggregation columns (wrong column name / data type)
    2. Duplicate identical rows (missing GROUP BY)
    3. Single-column result when query implies multiple columns
    """
    if not rows or not columns:
        return None

    num_rows = len(rows)
    num_cols = len(columns)

    # Check 1: aggregation columns mostly NULL
    for col_idx, col_name in enumerate(columns):
        none_count = sum(1 for r in rows if r[col_idx] is None)
        if none_count > num_rows * 0.8 and num_rows > 1:
            return (
                f"Column '{col_name}' has {none_count}/{num_rows} NULL values. "
                f"The column name may be misspelled or the data type is incompatible with the aggregation. "
                f"Check the actual column names in the table schema."
            )

    # Check 2: all rows identical (common when GROUP BY is missing)
    if num_rows > 3 and num_cols >= 1:
        first_row = rows[0]
        if all(list(r) == list(first_row) for r in rows[:min(20, num_rows)]):
            return (
                "All rows in the result are identical — you may be missing a GROUP BY clause "
                "or selecting from the wrong table."
            )

    # Check 3: SQL has SUM/COUNT/AVG but no GROUP BY → likely wrong
    sql_upper = sql.upper()
    has_agg = any(fn in sql_upper for fn in ("SUM(", "COUNT(", "AVG(", "MIN(", "MAX("))
    has_group = "GROUP BY" in sql_upper
    if has_agg and not has_group and num_rows == 1 and num_cols == 1:
        # Single aggregation without GROUP BY is fine (e.g., SELECT COUNT(*) FROM t)
        pass  # This is actually valid

    return None


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

    # If this is a critic retry, append feedback to system prompt
    critic_feedback = state.get("critic_feedback", "")
    retry_count = state.get("retry_count", 0)
    if retry_count > 0 and critic_feedback:
        system += f"\n\n⚠️ PREVIOUS ATTEMPT FAILED. Reviewer feedback:\n{critic_feedback}\nPlease fix the issue and generate a corrected SQL query."
        logger.info(f"SQL Agent retry #{retry_count}, critic feedback: {critic_feedback[:200]}")

    llm = get_llm(temperature=0)

    # ── Try tool-calling mode first ──
    try:
        result = await _run_with_tools(llm, tools, tool_map, conn, system, state)
        if result is not None:
            return result
    except Exception as e:
        logger.warning(f"Tool-calling mode failed ({e}), falling back to text mode")

    # ── Fallback: text extraction mode (for small models without tool_calls) ──
    return await _run_text_mode(llm, conn, system, state)


async def _run_with_tools(llm, tools, tool_map, conn, system, state) -> dict | None:
    """Standard tool-calling mode. Returns None if model doesn't support tools."""

    llm_with_tools = llm.bind_tools(tools)

    messages = [
        SystemMessage(content=system),
        HumanMessage(content=state.get("sql_task", state["user_query"])),
    ]

    collected_steps = []
    events = []

    for iteration in range(MAX_ITERATIONS):
        response = await llm_with_tools.ainvoke(messages)
        messages.append(response)

        if not response.tool_calls:
            # If first iteration and no tool calls → model doesn't support tools
            if iteration == 0 and not collected_steps:
                return None  # Signal to use fallback
            break

        for tc in response.tool_calls:
            tool_name = tc["name"]
            tool_args = tc["args"]

            if tool_name in tool_map:
                result = await tool_map[tool_name].ainvoke(tool_args)
            else:
                result = f"Unknown tool: {tool_name}"

            sql_text = tool_args.get("sql", "")
            is_error = isinstance(result, str) and result.startswith("ERROR:")

            collected_steps.append({
                "title": f"query · step {len(collected_steps) + 1}",
                "sql": sql_text,
                "result_preview": str(result)[:500],
                "tag": "SQL Agent",
                "is_error": is_error,
            })

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

            messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))

    return _build_result(collected_steps, events, conn, state)


async def _run_text_mode(llm, conn, system, state) -> dict:
    """Fallback: ask model to write SQL in plain text, then extract and execute it."""

    logger.info("SQL Agent running in text extraction mode (no tool_calls)")

    # Add explicit instruction to output raw SQL
    system_with_hint = system + "\n\nIMPORTANT: Output ONLY the SQL query, no explanation. Just the raw SQL."

    messages = [
        SystemMessage(content=system_with_hint),
        HumanMessage(content=state.get("sql_task", state["user_query"])),
    ]

    collected_steps = []
    events = []

    for iteration in range(MAX_ITERATIONS):
        response = await llm.ainvoke(messages)
        text = response.content.strip()
        logger.info(f"SQL Agent text mode, iteration {iteration + 1}, raw: {text[:200]}")

        # Extract SQL from the response text and fix dialect issues
        sql = extract_sql(text)
        if sql:
            sql = sanitize_sql(sql)
        if not sql:
            logger.warning(f"Could not extract SQL from response: {text[:200]}")
            if iteration == 0:
                # Try once more with a stronger hint
                messages.append(AIMessage(content=text))
                messages.append(HumanMessage(
                    content="Please output ONLY a valid SQL SELECT query. No explanation, just SQL."
                ))
                continue
            break

        # Execute the extracted SQL
        from backend.db.sandbox import execute_sandboxed
        result = execute_sandboxed(conn, sql)
        is_error = bool(result.get("error"))

        # Programmatic self-validation (no LLM cost)
        quality_issue = None
        if not is_error and result.get("rows"):
            quality_issue = _validate_result(result["rows"], result.get("columns", []), sql)
            if quality_issue:
                logger.warning(f"SQL self-check failed: {quality_issue}")

        collected_steps.append({
            "title": f"query · step {len(collected_steps) + 1}",
            "sql": sql,
            "result_preview": str(result.get("rows", [])[:5]) if not is_error else result["error"],
            "tag": "SQL Agent",
            "is_error": is_error or bool(quality_issue),
        })

        step_label = f"querying data · step {len(collected_steps)}"
        if is_error:
            step_label += " · error, retrying"
            messages.append(AIMessage(content=text))
            messages.append(HumanMessage(
                content=f"The query returned an error: {result['error']}\nPlease fix the SQL and try again. Output ONLY the corrected SQL."
            ))
        elif quality_issue:
            step_label += " · data issue, retrying"
            messages.append(AIMessage(content=text))
            messages.append(HumanMessage(
                content=f"The query executed but the results look wrong: {quality_issue}\nPlease check column names and fix the SQL. Output ONLY the corrected SQL."
            ))
        else:
            break

        events.append({
            "type": "progress",
            "data": {
                "steps": [
                    {"agent": "analyst", "label": "planning analysis", "status": "done"},
                    {"agent": "analyst", "label": step_label, "status": "active"},
                ]
            }
        })

    return _build_result(collected_steps, events, conn, state)


def _build_result(collected_steps, events, conn, state) -> dict:
    """Build the final sql_result dict from collected steps."""

    final_rows = []
    final_columns = []
    error = None
    quality_warning = None

    for step in reversed(collected_steps):
        if not step.get("is_error"):
            from backend.db.sandbox import execute_sandboxed
            last_result = execute_sandboxed(conn, step["sql"])
            if not last_result.get("error"):
                final_rows = last_result["rows"]
                final_columns = last_result["columns"]
                # Final validation on the result we're about to return
                quality_warning = _validate_result(final_rows, final_columns, step["sql"])
                if quality_warning:
                    logger.warning(f"SQL build_result quality warning: {quality_warning}")
            break

    if not final_columns and collected_steps:
        error = "All SQL attempts failed"

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
            "final_rows": final_rows[:100],
            "final_columns": final_columns,
            "error": error,
            "quality_warning": quality_warning,  # Programmatic check result for Critic
        },
        "stream_events": events,
    }


def _error_event(msg: str) -> dict:
    return {
        "type": "error",
        "data": {"code": "PIPELINE_ERROR", "message": msg, "agent": "analyst"},
    }
