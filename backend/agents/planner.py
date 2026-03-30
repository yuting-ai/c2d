"""Planner Agent — understands user intent, decides which workers to activate or answers directly."""

import json
import re
import logging
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm, no_think
from backend.agents.json_utils import extract_json
from backend.config.prompts import PLANNER_SYSTEM, TABLE_SCHEMA_TEMPLATE
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)

# User-facing chart intent in Latin script (non-Latin queries rely on the planner model).
_VIZ_KEYWORDS = re.compile(
    r"\b(?:chart|graph|plot|visual(?:ization)?|figure|diagram|histogram|"
    r"bar\s*chart|pie\s*chart|scatter(?:plot)?|line\s*chart|trend)\b",
    re.IGNORECASE,
)

# Queries that ALWAYS require data — never answer directly from schema.
# Covers English + Chinese ranking/aggregation keywords.
_REQUIRES_DATA_KEYWORDS = re.compile(
    r"\b(?:top|bottom|rank(?:ing)?|most|least|best|worst|popular|"
    r"how\s+many|count|total|sum|average|avg|median|"
    r"compar(?:e|ison)|distribut(?:e|ion)|trend|percent(?:age)?|"
    r"more\s+than|less\s+than|greater|highest|lowest|largest|smallest)\b"
    r"|(?:最多|最少|最高|最低|最大|最小|排名|排行|总计|总数|"
    r"平均|趋势|比较|对比|分布|占比|百分比|多少|数量|销量|销售额|"
    r"top\s*\d+|前\s*\d+|增长|下降|受欢迎|热门|畅销)",  
    re.IGNORECASE,
)


def _needs_viz(query: str) -> bool:
    """Detect if user's query explicitly asks for a chart."""
    return bool(_VIZ_KEYWORDS.search(query))


def _requires_data(query: str) -> bool:
    """Detect if the query needs actual data retrieval (must not use direct_answer)."""
    return bool(_REQUIRES_DATA_KEYWORDS.search(query))


async def planner_agent(state: AgentState) -> dict:
    """Plan analysis: decide which agents to activate, or answer directly."""

    # Build table context — include column types when available
    tables_text = ""
    for t in state.get("active_tables", []):
        col_dicts = t.get("col_dicts")
        if col_dicts:
            col_str = ", ".join(f"{c['name']} ({c['type']})" for c in col_dicts)
        else:
            col_str = ", ".join(t.get("columns", []))
        tables_text += TABLE_SCHEMA_TEMPLATE.format(
            name=t["name"],
            row_count=t.get("row_count", "?"),
            columns=col_str,
        ) + "\n"

    quality_notes = "\n".join(state.get("quality_notes", [])) or "None"

    # Build prompt
    system = PLANNER_SYSTEM.format(
        user_lang=state.get("user_lang", "en"),
        active_tables=tables_text.strip() or "No tables loaded",
        quality_notes=quality_notes,
    )

    retry_count = state.get("retry_count", 0)
    retry_target = state.get("retry_target")
    critic_feedback = state.get("critic_feedback", "")
    if retry_count > 0 and retry_target in {"planner", "both"} and critic_feedback:
        system += (
            "\n\n[!] PREVIOUS PLAN FAILED REVIEW.\n"
            f"Reviewer feedback:\n{critic_feedback}\n"
            "Revise the plan and SQL task so it addresses the original user intent exactly."
        )
        logger.info(f"Planner retry #{retry_count}, critic feedback: {critic_feedback[:200]}")

    llm = get_llm(temperature=0)
    response = await llm.ainvoke([
        SystemMessage(content=no_think(system)),
        HumanMessage(content=state["user_query"]),
    ])

    text = response.content.strip()
    logger.info(f"Planner raw output: {text[:300]}")

    # Robust JSON extraction (handles fences, <think> tags, messy output)
    parsed = extract_json(text)

    if parsed is None:
        logger.warning(f"Failed to parse planner output, falling back to default plan")
        parsed = {
            "plan": ["sql"],
            "sql_task": state["user_query"],
            "involved_columns": [],
            "reasoning": "Failed to parse planner output, falling back to SQL",
        }

    plan = parsed.get("plan", [])
    direct_answer = parsed.get("direct_answer")
    reasoning = parsed.get("reasoning", "")

    # ── Safety net: if query requires data, never allow direct_answer ──
    user_needs_data = _requires_data(state["user_query"])
    if user_needs_data and not plan and direct_answer:
        plan = ["sql", "viz"]
        direct_answer = None
        parsed["sql_task"] = parsed.get("sql_task") or state["user_query"]
        logger.info("Planner override: query requires data but model gave direct_answer → forcing sql+viz")

    # ── Safety net: if user explicitly asks for a chart, ensure "viz" is in plan ──
    user_wants_viz = _needs_viz(state["user_query"])
    if user_wants_viz:
        if not plan:
            # Model gave direct_answer but user wants a chart — override to agent mode
            plan = ["sql", "viz"]
            direct_answer = None
            parsed["sql_task"] = parsed.get("sql_task") or state["user_query"]
            logger.info("Planner override: user wants viz but model gave direct answer → forcing sql+viz")
        elif "viz" not in plan:
            plan.append("viz")
            logger.info("Planner override: appended 'viz' to plan because user query implies chart")

    # Also make sure "sql" is always present when plan is non-empty
    if plan and "sql" not in plan:
        plan.insert(0, "sql")

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
    intent_pattern = parsed.get("intent_pattern", "")
    logger.info(f"Planner intent_pattern: {intent_pattern!r}")

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
        "intent_pattern": intent_pattern,
        "sql_task": sql_task,
        "viz_task": parsed.get("viz_task"),
        "stats_task": parsed.get("stats_task"),
        "involved_columns": parsed.get("involved_columns", []),
        "stream_events": [progress_event],
    }
