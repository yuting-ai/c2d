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

# Keywords that strongly imply the user wants a chart / visualization
_VIZ_KEYWORDS = re.compile(
    r"绘制|图形|图表|可视化|画图|折线图|柱状图|饼图|散点图|趋势图|chart|graph|plot|visual|histogram|bar\s*chart|pie\s*chart|scatter|line\s*chart|trend",
    re.IGNORECASE,
)

# Pattern: "top N per [dimension]" — requires window function, NOT just LIMIT
_TOP_N_PER_GROUP = re.compile(
    r"(?:每|per\s+|each\s+)"   # 每年 / per year / each year
    r".{0,10}"
    r"(?:top|前|排名前|最.{0,4}的前)\s*\d+",
    re.IGNORECASE,
)


def _needs_viz(query: str) -> bool:
    """Detect if user's query explicitly asks for a chart."""
    return bool(_VIZ_KEYWORDS.search(query))


def _is_top_n_per_group(query: str) -> bool:
    """Detect 'top N per [dimension]' pattern — needs window function."""
    return bool(_TOP_N_PER_GROUP.search(query))


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

    # ── Inject window-function hint for "top N per group" queries ──
    if _is_top_n_per_group(state["user_query"]):
        hint = (
            " [IMPORTANT: This requires a window function. "
            "Use ROW_NUMBER() OVER (PARTITION BY <dimension> ORDER BY <metric> DESC) "
            "inside a subquery, then filter WHERE rn <= N. "
            "Do NOT use GROUP BY + LIMIT alone — that only gives overall top N, not per-group top N.]"
        )
        current_task = parsed.get("sql_task", state["user_query"])
        parsed["sql_task"] = current_task + hint
        logger.info("Planner: detected top-N-per-group pattern, injected window function hint")

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
