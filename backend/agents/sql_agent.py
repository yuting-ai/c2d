"""SQL Agent — generates and executes SQL queries with self-correction.

Supports two modes:
1. Tool-calling mode (large models like DeepSeek, GPT-4) — uses bind_tools()
2. Text fallback mode (small local models) — extracts SQL from plain text
"""

import logging
import re
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage
from backend.agents.base import get_llm
from backend.agents.json_utils import extract_sql, sanitize_sql
from backend.config.prompts import SQL_AGENT_SYSTEM, TABLE_SCHEMA_TEMPLATE
from backend.knowledge.duckdb_retriever import retrieve_duckdb_refs
from backend.graph.state import AgentState
from backend.tools.sql_tools import create_sql_tools
from backend.db.engine import engine
from backend.db.sandbox import execute_sandboxed

logger = logging.getLogger(__name__)

MAX_ITERATIONS = 3


def _build_null_handling_text(config: dict) -> str:
    """Build a prompt section describing how to handle NULL values per column.

    Each entry tells the SQL Agent what to do when it encounters a specific
    column that the user flagged as sparse.  The agent applies these rules
    only for columns it actually references in the query.
    """
    if not config:
        return ""

    _METHOD_INSTRUCTIONS = {
        "mean": (
            "replace NULL with the column mean — "
            "use COALESCE({col}, AVG({col}) OVER ()) in the SELECT expression"
        ),
        "median": (
            "replace NULL with the column median — "
            "use COALESCE({col}, MEDIAN({col}) OVER ()) in the SELECT expression"
        ),
        "keep_null": (
            "keep NULL as-is — standard SQL aggregates (AVG, SUM) skip NULLs automatically, "
            "no special handling needed"
        ),
        "exclude": (
            "EXCLUDE this column entirely — do not reference it in SELECT, WHERE, or GROUP BY"
        ),
    }

    lines = [
        "═══════════════════════════════════════════",
        "NULL HANDLING (user-confirmed per column)",
        "═══════════════════════════════════════════",
        "Apply these rules ONLY for columns you actually reference in the query:",
    ]
    for col, method in config.items():
        template = _METHOD_INSTRUCTIONS.get(method)
        if template:
            lines.append(f"  • {col}: {template.format(col=col)}")
        else:
            lines.append(f"  • {col}: {method}")

    return "\n".join(lines)


def _normalize_sql_fingerprint(sql: str) -> str:
    """Stable whitespace-normalized form for duplicate-SQL detection."""
    return " ".join((sql or "").split()).lower()


def _top_level_root_tokens(sql: str) -> list[tuple[str, int]]:
    """Return top-level SELECT/WITH token positions (outside quotes/parens)."""
    tokens: list[tuple[str, int]] = []
    n = len(sql or "")
    i = 0
    depth = 0
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue
        if not in_single and not in_double:
            if ch == "-" and nxt == "-":
                in_line_comment = True
                i += 2
                continue
            if ch == "/" and nxt == "*":
                in_block_comment = True
                i += 2
                continue
        if not in_double and ch == "'" and not in_line_comment and not in_block_comment:
            in_single = not in_single
            i += 1
            continue
        if not in_single and ch == '"' and not in_line_comment and not in_block_comment:
            in_double = not in_double
            i += 1
            continue
        if in_single or in_double:
            i += 1
            continue

        if ch == "(":
            depth += 1
            i += 1
            continue
        if ch == ")":
            depth = max(0, depth - 1)
            i += 1
            continue

        if depth == 0:
            rem = sql[i:].upper()
            for kw in ("SELECT", "WITH"):
                if rem.startswith(kw):
                    prev_ok = i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == "_")
                    end = i + len(kw)
                    next_ok = end >= n or not (sql[end].isalnum() or sql[end] == "_")
                    if prev_ok and next_ok:
                        tokens.append((kw, i))
                        i = end
                        break
            else:
                i += 1
            continue

        i += 1

    return tokens


def _detect_multi_root_statement(sql: str) -> str | None:
    """Detect accidental SQL concatenation (multiple root statements in one string)."""
    s = (sql or "").strip()
    if not s:
        return None
    roots = _top_level_root_tokens(s)
    if not roots:
        return None

    # Valid single statement shapes:
    # - SELECT ...
    # - WITH ... SELECT ...
    first_kw = roots[0][0]
    if first_kw == "SELECT":
        expected_max = 1
    elif first_kw == "WITH":
        expected_max = 2  # WITH CTE ... SELECT main
    else:
        expected_max = 1

    if len(roots) <= expected_max:
        return None

    # Allow set-operation queries like: SELECT ... UNION SELECT ...
    if first_kw == "SELECT":
        for idx in range(1, len(roots)):
            pos = roots[idx][1]
            left = s[:pos].upper().rstrip()
            tail = left[-40:]
            if not any(op in tail for op in (" UNION ", " INTERSECT ", " EXCEPT ")):
                return "Only one root SQL statement is allowed; detected concatenated queries in one attempt"
        return None

    return "Only one root SQL statement is allowed; detected concatenated queries in one attempt"


def _validate_sql_candidate(
    sql: str,
    active_tables: list[dict],
) -> str | None:
    """Preflight SQL validation before execution.

    Keeps output deterministic by rejecting multi-statement SQL and unknown table usage.
    Semantic correctness is delegated to the Critic agent.
    """
    s = (sql or "").strip()
    if not s:
        return "Empty SQL query"

    # Enforce single root statement to avoid accidental exploratory queries.
    statements = [part.strip() for part in s.split(";") if part.strip()]
    if len(statements) > 1:
        return "Only one SQL statement is allowed per attempt"
    multi_root_issue = _detect_multi_root_statement(s)
    if multi_root_issue:
        return multi_root_issue

    head = statements[0].lstrip().upper() if statements else ""
    if not (head.startswith("SELECT") or head.startswith("WITH")):
        return "SQL must start with SELECT or WITH"

    allowed_tables = {str(t.get("name", "")).lower() for t in active_tables if t.get("name")}
    if not allowed_tables:
        return None

    # Extract CTE names defined in WITH ... AS (...) clauses and add them to the
    # whitelist so that `FROM cte_name` references are not flagged as unknown tables.
    #
    # Handles:
    #   WITH ranked AS (...)                       → "ranked"
    #   WITH RECURSIVE ranked AS (...)             → "ranked"  (RECURSIVE keyword skipped)
    #   WITH base AS (...), ranked AS (...)        → "base", "ranked"
    #
    # The pattern anchors on the opening paren `\(` which is exclusive to CTE definitions
    # (not to column aliases like `SUM(x) AS alias`) making false positives very unlikely.
    cte_names: set[str] = set()
    # First CTE after WITH (optional RECURSIVE keyword)
    for m in re.finditer(
        r"\bWITH\s+(?:RECURSIVE\s+)?(\w+)\s+AS\s*\(",
        s,
        re.IGNORECASE,
    ):
        cte_names.add(m.group(1).lower())
    # Additional CTEs separated by commas: ), name AS (
    for m in re.finditer(r"\)\s*,\s*(\w+)\s+AS\s*\(", s, re.IGNORECASE):
        cte_names.add(m.group(1).lower())

    allowed = allowed_tables | cte_names

    # Basic table reference extraction from FROM/JOIN clauses.
    # Note: EXTRACT(YEAR FROM col) contains FROM inside an expression — the (?=\s) guard
    # ensures we only match real table tokens followed by whitespace.
    refs = re.findall(
        r"\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_\".]*)(?=\s)",
        s,
        flags=re.IGNORECASE,
    )
    for ref in refs:
        token = ref.strip().strip('"')
        table_name = token.split(".")[-1].strip('"').lower()
        if table_name and table_name not in allowed:
            logger.warning(
                "SQL validation rejected: unknown table '%s'. "
                "Allowed: %s | CTE names found: %s",
                table_name,
                ", ".join(sorted(allowed_tables)),
                ", ".join(sorted(cte_names)) or "(none)",
            )
            return (
                f"Unknown table '{table_name}'. "
                f"Use only tables from active schema: {', '.join(sorted(allowed_tables))}"
            )

    return None


def _validate_result(rows: list, columns: list, sql: str) -> str | None:
    """Light programmatic self-check on SQL results (hints only; not a full semantic validator).

    Kept intentionally soft: false positives caused bad retries on valid DuckDB/SQL.
    """
    if not rows or not columns:
        return None

    num_rows = len(rows)
    num_cols = len(columns)

    # Check 1: aggregation columns mostly NULL
    for col_idx, col_name in enumerate(columns):
        none_count = sum(1 for r in rows if r[col_idx] is None)
        # Lenient: sparse facts are common; only flag extreme NULL dominance on non-trivial result sets.
        if none_count > num_rows * 0.95 and num_rows > 5:
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
                "All rows in the result are identical - you may be missing a GROUP BY clause "
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

    # Build prompt — include column types when available so the LLM can
    # write correct CAST() expressions and avoid type-mismatch errors.
    tables_text = ""
    for t in state.get("active_tables", []):
        col_dicts = t.get("col_dicts")
        if col_dicts:
            # Format as "col_name (TYPE), ..." so the LLM sees the type
            col_str = ", ".join(f"{c['name']} ({c['type']})" for c in col_dicts)
        else:
            # Fallback: plain name list (backward compat for bootstrapped projects)
            col_str = ", ".join(t.get("columns", []))

        tables_text += TABLE_SCHEMA_TEMPLATE.format(
            name=t["name"],
            row_count=t.get("row_count", "?"),
            columns=col_str,
        ) + "\n"

    quality_notes = "\n".join(state.get("quality_notes", [])) or "None"
    intent_pattern = state.get("intent_pattern", "")
    duckdb_refs = retrieve_duckdb_refs(state.get("user_query", ""), state.get("sql_task", ""))
    logger.info(f"SQL Agent intent_pattern={intent_pattern!r}, duckdb_refs preview: {duckdb_refs[:220].replace(chr(10), ' ')}")

    # Build NULL-handling instruction block from user-confirmed config
    null_handling_config: dict = state.get("null_handling_config") or {}
    null_handling_text = _build_null_handling_text(null_handling_config)

    system = SQL_AGENT_SYSTEM.format(
        user_lang=state.get("user_lang", "en"),
        active_tables=tables_text.strip() or "No tables loaded",
        quality_notes=quality_notes,
        intent_pattern=intent_pattern or "(not classified)",
        duckdb_refs=duckdb_refs,
    )
    if null_handling_text:
        system += f"\n\n{null_handling_text}"

    # If this is a critic retry, append feedback + structured hint to system prompt
    critic_feedback = state.get("critic_feedback", "")
    critic_hint = state.get("critic_hint", "")
    retry_count = state.get("retry_count", 0)
    if retry_count > 0 and critic_feedback:
        _hint_guidance = {
            "requires_window_function": (
                "Use ROW_NUMBER() OVER (PARTITION BY <group_key> ORDER BY <metric> DESC) "
                "with QUALIFY rn <= N, or a CTE with WHERE rn <= N. "
                "Do NOT use GROUP BY + LIMIT alone for per-group ranking."
            ),
            "wrong_aggregation": "Re-check which aggregate function (SUM/COUNT/AVG/MAX/MIN) the task requires.",
            "missing_filter": "Add the missing WHERE or HAVING clause to restrict rows as the task specifies.",
            "wrong_sort_direction": "Flip the ORDER BY direction (ASC ↔ DESC) to match the user's intent.",
            "missing_group_by": "Add GROUP BY on the dimension column the task groups by.",
        }.get(critic_hint, "")
        system += (
            "\n\n[!] PREVIOUS ATTEMPT FAILED REVIEW. Critic feedback:\n"
            f"{critic_feedback}\n"
        )
        if _hint_guidance:
            system += f"Fix guidance ({critic_hint}): {_hint_guidance}\n"
        system += "Generate a corrected SQL query that addresses the feedback above."
        logger.info(f"SQL Agent retry #{retry_count}, hint={critic_hint!r}, feedback: {critic_feedback[:200]}")

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
    last_sql_fp: str | None = None
    original_task = state.get("sql_task") or state.get("user_query", "")
    # Set when a SQL executes without error — exits the loop immediately.
    # Semantic validation (does the result answer the question?) is the Critic's job.
    _sql_succeeded = False

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
            sql_text = tool_args.get("sql", "")
            if sql_text.strip():
                logger.info("SQL Agent tool-call SQL (full):\n%s", sql_text.strip())

            executed = False
            if tool_name in tool_map:
                fp_tool = _normalize_sql_fingerprint(sql_text) if sql_text.strip() else ""
                is_duplicate_sql = bool(fp_tool and fp_tool == last_sql_fp and collected_steps)
                if fp_tool:
                    last_sql_fp = fp_tool
                if is_duplicate_sql:
                    logger.warning(
                        "SQL Agent tool-mode: LLM submitted identical SQL again (fp=%s)", fp_tool[:60]
                    )
                    result = (
                        "ERROR: You submitted the exact same SQL that already failed on a previous step. "
                        "Do NOT repeat it. Use a completely different query structure — for example, "
                        "switch between CTE and QUALIFY, add explicit CAST() for type issues, "
                        "or re-check column names in the schema above."
                    )
                else:
                    validation_issue = _validate_sql_candidate(
                        sql_text,
                        state.get("active_tables", []),
                    )
                    if validation_issue:
                        result = f"ERROR: {validation_issue}\nSQL: {sql_text}"
                    else:
                        result = await tool_map[tool_name].ainvoke(tool_args)
                        executed = True
            else:
                result = f"Unknown tool: {tool_name}"
            is_error = isinstance(result, str) and result.startswith("ERROR:")
            if is_error:
                logger.warning(f"SQL Agent tool step error preview: {str(result)[:200].replace(chr(10), ' ')}")

            if executed and not is_error:
                raw_check = execute_sandboxed(conn, sql_text)
                if not raw_check.get("error") and raw_check.get("rows"):
                    q_issue = _validate_result(
                        raw_check["rows"], raw_check.get("columns", []), sql_text
                    )
                    if q_issue:
                        logger.warning(
                            "SQL Agent tool step quality note (non-blocking): %s",
                            q_issue[:200],
                        )

            collected_steps.append({
                "title": f"query · step {len(collected_steps) + 1}",
                "sql": sql_text,
                "result_preview": str(result)[:500],
                "tag": "SQL Agent",
                "is_error": is_error,
                "executed": executed,
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

            # ── Stop as soon as SQL executes successfully ──
            # SQL Agent's job is syntax correctness only.
            # Whether the result answers the user's question is Critic's responsibility.
            if executed and not is_error:
                logger.info("SQL Agent tool-mode: SQL succeeded at iteration %d — stopping loop", iteration + 1)
                _sql_succeeded = True
                break  # exit inner for-loop

        if _sql_succeeded:
            break  # exit outer iteration loop

    return _build_result(collected_steps, events, conn, state)


async def _run_text_mode(llm, conn, system, state) -> dict:
    """Fallback: ask model to write SQL in plain text, then extract and execute it."""

    logger.info("SQL Agent running in text extraction mode (no tool_calls)")

    original_task = state.get("sql_task") or state.get("user_query", "")

    # Add explicit instruction to output raw SQL
    system_with_hint = system + "\n\nIMPORTANT: Output ONLY the SQL query, no explanation. Just the raw SQL."

    messages = [
        SystemMessage(content=system_with_hint),
        HumanMessage(content=original_task),
    ]

    collected_steps = []
    events = []
    last_sql_fp: str | None = None

    for iteration in range(MAX_ITERATIONS):
        response = await llm.ainvoke(messages)
        text = response.content.strip()
        logger.info(f"SQL Agent text mode, iteration {iteration + 1}, raw preview: {text[:200]!r}...")

        # Extract SQL from the response text and fix dialect issues
        sql = extract_sql(text)
        if sql:
            sql = sanitize_sql(sql)
            logger.info("SQL Agent extracted SQL (full):\n%s", sql)
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

        fp = _normalize_sql_fingerprint(sql)
        is_duplicate_fp = (fp == last_sql_fp) and last_sql_fp is not None
        last_sql_fp = fp

        validation_issue = _validate_sql_candidate(
            sql,
            state.get("active_tables", []),
        )
        if validation_issue:
            logger.warning(
                "SQL Agent text-mode iteration %d validation failed: %s",
                iteration + 1,
                validation_issue,
            )
            collected_steps.append({
                "title": f"query · step {len(collected_steps) + 1}",
                "sql": sql,
                "result_preview": validation_issue,
                "tag": "SQL Agent",
                "is_error": True,
                "executed": False,
            })
            messages.append(AIMessage(content=text))
            messages.append(HumanMessage(
                content=(
                    f"Your SQL is invalid: {validation_issue}.\n"
                    f"Original task: {original_task}\n"
                    "Generate a corrected SINGLE SELECT/WITH query using only the tables and columns listed in the schema."
                )
            ))
            continue

        # Execute the extracted SQL
        result = execute_sandboxed(conn, sql)
        is_error = bool(result.get("error"))
        if is_error:
            logger.warning(
                "SQL Agent text-mode iteration %d DuckDB error: %s",
                iteration + 1,
                result["error"][:300],
            )

        # Programmatic self-validation (no LLM cost)
        quality_issue = None
        if not is_error and result.get("rows"):
            quality_issue = _validate_result(result["rows"], result.get("columns", []), sql)
            if quality_issue:
                logger.warning(f"SQL self-check failed: {quality_issue}")

        # quality_issue is non-blocking in text mode (same as tool mode).
        # Sparse columns (e.g. legitimately high-NULL metrics) should not
        # cause a retry loop — the Critic is better placed to decide.
        collected_steps.append({
            "title": f"query · step {len(collected_steps) + 1}",
            "sql": sql,
            "result_preview": str(result.get("rows", [])[:5]) if not is_error else result["error"],
            "tag": "SQL Agent",
            "is_error": is_error,   # quality_issue is a warning, NOT an error
            "executed": True,
        })

        step_label = f"querying data · step {len(collected_steps)}"
        if is_error:
            step_label += " · error, retrying"
            messages.append(AIMessage(content=text))

            # ── Duplicate-SQL detection ──────────────────────────────────────
            # If the LLM is regenerating the exact same SQL that already failed,
            # the standard retry message won't help — escalate with an explicit
            # "you MUST change your approach" instruction.
            duplicate_warning = ""
            if is_duplicate_fp:
                duplicate_warning = (
                    "\n\n[!] CRITICAL: You just generated the EXACT SAME SQL that already failed "
                    "on the previous attempt. Do NOT repeat it. You MUST use a fundamentally "
                    "different query structure. Consider:\n"
                    "  • Using CAST() or TRY_CAST() if you suspect a type mismatch\n"
                    "  • Using a CTE (WITH ... AS) instead of inline subqueries\n"
                    "  • Using QUALIFY instead of a CTE for window-function filtering\n"
                    "  • Verifying the exact column names and types shown in the schema above\n"
                )
                logger.warning(
                    "SQL Agent text-mode: LLM regenerated identical SQL (fp=%s), escalating retry prompt",
                    fp[:60],
                )

            messages.append(HumanMessage(
                content=(
                    f"The query returned an error: {result['error']}\n"
                    f"Failed SQL:\n{sql}\n"
                    f"Original task: {original_task}\n"
                    f"Please fix the SQL and try again. Output ONLY the corrected SQL."
                    f"{duplicate_warning}"
                )
            ))
        else:
            # Success (quality_issue logged but not retried)
            if quality_issue:
                logger.info(
                    "SQL text-mode quality note (non-blocking, forwarded to Critic): %s",
                    quality_issue[:200],
                )
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

    def _apply_sandbox_result(step: dict) -> bool:
        nonlocal final_rows, final_columns, quality_warning
        sql_t = (step.get("sql") or "").strip()
        if not sql_t:
            return False
        last_result = execute_sandboxed(conn, sql_t)
        if last_result.get("error"):
            logger.warning(
                "SQL build_result: re-exec failed for %s: %s",
                step.get("title"),
                last_result.get("error"),
            )
            return False
        final_rows = last_result["rows"]
        final_columns = last_result["columns"]
        quality_warning = _validate_result(final_rows, final_columns, sql_t)
        if quality_warning:
            logger.warning(f"SQL build_result quality warning: {quality_warning}")
        return True

    for step in reversed(collected_steps):
        if step.get("is_error"):
            continue
        if _apply_sandbox_result(step):
            break

    if not final_columns and collected_steps:
        for step in reversed(collected_steps):
            if not step.get("executed"):
                continue
            if _apply_sandbox_result(step):
                logger.warning(
                    "SQL Agent: using last sandbox-successful attempt as final output "
                    "(a later step failed validation, quality self-check, or hit the iteration limit)."
                )
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

    # Build a human-readable annotation about any applied NULL handling
    null_handling_config: dict = state.get("null_handling_config") or {}
    null_handling_note: str | None = None
    if null_handling_config:
        used = {col: m for col, m in null_handling_config.items() if m != "keep_null"}
        if used:
            parts = [f"{col} ({m})" for col, m in used.items()]
            null_handling_note = (
                f"Note: NULL values in {', '.join(parts)} were handled "
                "according to your data quality preferences."
            )

    return {
        "sql_result": {
            "steps": collected_steps,
            "final_rows": final_rows,
            "final_columns": final_columns,
            "error": error,
            "quality_warning": quality_warning,  # Programmatic check result for Critic
            "null_handling_note": null_handling_note,
        },
        "stream_events": events,
    }


def _error_event(msg: str) -> dict:
    return {
        "type": "error",
        "data": {"code": "PIPELINE_ERROR", "message": msg, "agent": "analyst"},
    }
