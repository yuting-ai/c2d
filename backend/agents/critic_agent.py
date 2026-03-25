"""Critic Agent — reviews analysis results for logical consistency and data quality."""

import json
import logging
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm, no_think
from backend.agents.json_utils import extract_json
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)

CRITIC_SYSTEM = """You are a data analysis critic. Review the analysis results and check for quality.

User's original question:
{user_query}

SQL query used:
{sql_summary}

SQL result summary:
{result_summary}

Statistical tests (if any):
{stats_summary}

Data quality context:
{quality_notes}

Retry attempt: {retry_count} of 2

Check the following:
1. Does the SQL query correctly answer the user's question?
2. Are the numbers reasonable (no obvious calculation errors)?
3. If statistical claims are made, are they supported by test results?

Respond with JSON only (no markdown fences):
{{
  "verdict": "pass",
  "feedback": "Analysis looks correct. Revenue comparison is well-supported by the data.",
  "transparency_notes": []
}}

Or if there's an issue:
{{
  "verdict": "retry",
  "target": "sql",
  "feedback": "The query uses AVG but the question asks for total. Should use SUM instead.",
  "transparency_notes": []
}}"""


async def critic_agent(state: AgentState) -> dict:
    """Review analysis results, decide pass or retry."""

    retry_count = state.get("retry_count", 0)

    # Force pass after max retries (1 retry max — small models rarely self-correct beyond that)
    if retry_count >= 1:
        logger.info("Critic: max retries reached, forcing pass")
        return {
            "critic_verdict": "pass",
            "critic_feedback": "Passed after max retries — results may need manual verification",
            "stream_events": [_progress_event(state, "reviewing results", "done")],
        }

    sql_result = state.get("sql_result", {})
    stats_result = state.get("stats_result") or {}

    # Build context
    sql_steps = sql_result.get("steps", [])
    sql_summary = "\n".join(s.get("sql", "") for s in sql_steps) or "No SQL executed"

    final_cols = sql_result.get("final_columns", [])
    final_rows = sql_result.get("final_rows", [])
    result_preview = ""
    if final_cols and final_rows:
        header = " | ".join(str(c) for c in final_cols)
        rows = "\n".join(" | ".join(str(v) for v in row) for row in final_rows[:10])
        result_preview = f"{header}\n{rows}\n({len(final_rows)} total rows)"

    stats_summary = "None"
    tests = stats_result.get("tests", [])
    if tests:
        stats_summary = "\n".join(f"- {t['key']}: {t['value']}" for t in tests)

    quality_notes = "\n".join(state.get("quality_notes", [])) or "None"

    # Include programmatic quality warnings from SQL agent
    sql_quality_warning = sql_result.get("quality_warning")
    if sql_quality_warning:
        quality_notes += f"\n⚠️ SQL self-check warning: {sql_quality_warning}"

    prompt = CRITIC_SYSTEM.format(
        user_query=state["user_query"],
        sql_summary=sql_summary,
        result_summary=result_preview or "No results",
        stats_summary=stats_summary,
        quality_notes=quality_notes,
        retry_count=retry_count,
    )

    # Progress
    start_event = _progress_event(state, "reviewing results", "active")

    llm = get_llm(temperature=0)
    response = await llm.ainvoke([
        SystemMessage(content=prompt),   # Critic keeps thinking — needs to reason about SQL correctness
        HumanMessage(content="Review the analysis now."),
    ])

    text = response.content.strip()
    logger.info(f"Critic raw output: {text[:300]}")

    parsed = extract_json(text)
    if parsed is None:
        logger.warning(f"Failed to parse critic output, defaulting to pass: {text[:200]}")
        parsed = {"verdict": "pass", "feedback": "Could not parse review, passing by default"}

    verdict = parsed.get("verdict", "pass")
    feedback = parsed.get("feedback", "")
    target = parsed.get("target", "sql")
    notes = parsed.get("transparency_notes", [])

    logger.info(f"Critic: verdict={verdict}, feedback={feedback[:300]}")

    done_event = _progress_event(state, "reviewing results", "done")

    result = {
        "critic_verdict": verdict,
        "critic_feedback": feedback,
        "stream_events": [start_event, done_event],
    }

    if verdict == "retry":
        result["retry_count"] = retry_count + 1
        result["retry_target"] = target

    return result


def _progress_event(state: AgentState, label: str, status: str) -> dict:
    sql_result = state.get("sql_result", {})
    num_queries = len(sql_result.get("steps", []))
    plan = state.get("plan", [])
    stats_result = state.get("stats_result")

    steps = [
        {"agent": "analyst", "label": "planning analysis", "status": "done"},
        {"agent": "analyst", "label": f"querying data · {num_queries} queries", "status": "done"},
    ]
    if "viz" in plan:
        steps.append({"agent": "analyst", "label": "generating chart", "status": "done"})
    if "stats" in plan and stats_result:
        num_tests = len(stats_result.get("tests", []))
        steps.append({"agent": "analyst", "label": f"statistical analysis · {num_tests} tests", "status": "done"})
    steps.append({"agent": "analyst", "label": label, "status": status})
    if status != "done":
        steps.append({"agent": "analyst", "label": "writing conclusion", "status": "waiting"})
    else:
        steps.append({"agent": "analyst", "label": "writing conclusion", "status": "waiting"})

    return {"type": "progress", "data": {"steps": steps}}