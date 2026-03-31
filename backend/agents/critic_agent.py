"""Critic Agent — reviews analysis results for logical consistency and data quality."""

import logging
import re
from langchain_core.messages import SystemMessage, HumanMessage
from backend.agents.base import get_llm
from backend.agents.json_utils import extract_json
from backend.config.prompts import CRITIC_SYSTEM
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)


async def critic_agent(state: AgentState) -> dict:
    """Review analysis results, decide pass or retry."""

    retry_count = state.get("retry_count", 0)

    # Allow up to 2 retry hops before forcing pass.
    if retry_count >= 2:
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
        quality_notes += f"\n[!] SQL self-check warning: {sql_quality_warning}"

    prompt = CRITIC_SYSTEM.format(
        user_lang=state.get("user_lang", "en"),
        user_query=state.get("user_query", ""),
        sql_summary=sql_summary,
        result_summary=result_preview or "No results",
        stats_summary=stats_summary,
        quality_notes=quality_notes,
        retry_count=retry_count,
    )
    prompt += (
        "\n\nRetry target policy:\n"
        "- target='sql': intent is correct, SQL implementation is wrong.\n"
        "- target='planner': intent decomposition is wrong (grouping/scope/metric misunderstood).\n"
        "- target='both': both intent decomposition and SQL are wrong; rerun planning first.\n"
        "Only use one of: sql, planner, both."
    )

    # Progress
    start_event = _progress_event(state, "reviewing results", "active")

    llm = get_llm(temperature=0)
    response = await llm.ainvoke([
        SystemMessage(content=prompt),   # Critic keeps thinking — needs to reason about SQL correctness
        HumanMessage(content="Review the analysis now."),
    ])

    content = response.content
    if isinstance(content, str):
        text = content.strip()
    else:
        text = str(content).strip()
    logger.info(f"Critic raw output: {text[:300]}")

    parsed = extract_json(text)
    if parsed is None:
        logger.warning(f"Failed to parse critic output, defaulting to pass: {text[:200]}")
        parsed = {"verdict": "pass", "feedback": "Could not parse review, passing by default"}

    verdict = parsed.get("verdict", "pass")
    feedback = parsed.get("feedback", "")
    hint = str(parsed.get("hint", "other")).strip().lower()
    target = str(parsed.get("target", "sql")).strip().lower()
    if target not in {"sql", "planner", "both"}:
        target = "sql"

    # Deterministic guard: force retry when histogram intent with insufficient bin data.
    verdict, target, feedback = _force_histogram_retry(state, verdict, target, feedback)

    # Deterministic guard: pass when NULLs are due to dataset sparsity, not SQL errors.
    verdict, target, feedback = _override_null_sparsity_retry(state, verdict, target, feedback)

    # Deterministic guard against known low-value false positives.
    verdict, target, feedback = _override_false_positive_retry(state, verdict, target, feedback)
    verdict, target, feedback = _override_sum_and_avg_both_requested(state, verdict, target, feedback)

    notes = parsed.get("transparency_notes", [])

    logger.info(f"Critic: verdict={verdict}, hint={hint!r}, feedback={feedback[:300]}")

    done_event = _progress_event(state, "reviewing results", "done")

    result = {
        "critic_verdict": verdict,
        "critic_feedback": feedback,
        "stream_events": [start_event, done_event],
    }

    if verdict == "retry":
        result["retry_count"] = retry_count + 1
        result["retry_target"] = target
        result["critic_hint"] = hint
        # Invalidate artifacts generated from the failing branch.
        result["viz_result"] = None
        result["stats_result"] = None

    return result


_HISTOGRAM_KEYWORDS = (
    "histogram",
    "distribution",
    "frequency distribution",
    "frequency",
    "binning",
    "bins",
    "width_bucket",
)


def _force_histogram_retry(state: AgentState, verdict: str, target: str, feedback: str) -> tuple[str, str, str]:
    """Force a retry when the user asked for a histogram but SQL produced too few bins."""
    if verdict == "retry":
        return verdict, target, feedback

    user_query = (state.get("user_query") or "").lower()
    if not any(kw in user_query for kw in _HISTOGRAM_KEYWORDS):
        return verdict, target, feedback

    sql_result = state.get("sql_result", {}) or {}
    final_rows = sql_result.get("final_rows", [])

    if len(final_rows) <= 5:
        logger.warning(
            f"Critic: histogram intent detected but only {len(final_rows)} rows — forcing SQL retry"
        )
        return (
            "retry",
            "sql",
            "User asked for a histogram/distribution, but the SQL returned only "
            f"{len(final_rows)} rows of summary statistics instead of properly binned frequency data. "
            "Rewrite the SQL to use width_bucket() (DuckDB) to compute histogram bins. "
            "Output bin_range as x column and frequency count as y column. "
            "Use at least 8-15 bins depending on data range.",
        )

    return verdict, target, feedback


def _override_null_sparsity_retry(
    state: AgentState, verdict: str, target: str, feedback: str
) -> tuple[str, str, str]:
    """Downgrade retry to pass when result NULLs are caused by dataset sparsity.

    The Critic (especially small models) frequently misidentifies sparse source
    data as a SQL logic error.  The tell-tale pattern is:
    - SQL executed successfully and returned rows
    - Grouping/dimension columns (year, genre, …) are populated
    - One or more metric columns (sales, score, …) are NULL for ≥60 % of rows
    - The SQL has a correct GROUP BY + aggregate structure

    In this case the NULLs are data facts, not bugs.  We pass with a note so
    the report can surface the data-quality caveat to the user.
    """
    if verdict != "retry":
        return verdict, target, feedback

    sql_result = state.get("sql_result", {}) or {}
    final_rows = sql_result.get("final_rows", [])
    final_cols = sql_result.get("final_columns", [])

    # Need enough rows to assess sparsity (a genuinely empty result might be a real error)
    if len(final_rows) < 3:
        return verdict, target, feedback

    # Identify metric columns that are NULL-dominated (>= 60 % of rows are NULL)
    sparse_cols: list[str] = []
    for col_idx, col_name in enumerate(final_cols):
        null_count = sum(1 for r in final_rows if r[col_idx] is None)
        if null_count / len(final_rows) >= 0.6:
            sparse_cols.append(str(col_name))

    if not sparse_cols:
        return verdict, target, feedback  # NULLs not dominant — may be a real SQL bug

    # Verify the SQL has a structurally sound aggregate pattern (GROUP BY + aggregate fn)
    sql_steps = sql_result.get("steps", []) or []
    final_sql = str(sql_steps[-1].get("sql", "")) if sql_steps else ""
    sql_u = final_sql.upper()

    has_group_by = "GROUP BY" in sql_u
    has_aggregation = any(f + "(" in sql_u for f in ("SUM(", "COUNT(", "AVG(", "MIN(", "MAX("))

    if not (has_group_by and has_aggregation):
        return verdict, target, feedback  # Broken SQL — let normal retry logic handle it

    # Also check: are dimension (non-metric) columns mostly non-null?
    # If ALL columns are null-dominated, it could genuinely be a bad query.
    non_sparse_cols = [c for c in final_cols if c not in sparse_cols]
    if not non_sparse_cols:
        return verdict, target, feedback  # Everything is null — real problem

    sparse_list = ", ".join(sparse_cols)
    logger.info(
        "Critic: overriding NULL-sparsity false-positive retry — "
        "columns [%s] are NULL-dominated (≥60%%) in %d rows; "
        "SQL has correct GROUP BY + aggregate — treating as data gap, not SQL error",
        sparse_list, len(final_rows),
    )
    return (
        "pass",
        target,
        (
            f"SQL query is structurally correct. "
            f"NULL values in [{sparse_list}] reflect missing data in the source dataset "
            f"for certain groups/periods — this is a data coverage gap, not a query error."
        ),
    )


def _override_false_positive_retry(state: AgentState, verdict: str, target: str, feedback: str) -> tuple[str, str, str]:
    """Downgrade known false-positive retries to pass.

    This keeps the pipeline stable when critic feedback is semantically equivalent
    or requests decomposition already satisfied by the SQL output.
    """
    if verdict != "retry":
        return verdict, target, feedback

    fb = (feedback or "").lower()
    sql_result = state.get("sql_result", {}) or {}
    contract = sql_result.get("intent_contract", {}) or {}
    sql_steps = sql_result.get("steps", []) or []
    final_sql = ""
    if sql_steps:
        final_sql = str(sql_steps[-1].get("sql", ""))
    final_cols = [str(c).lower() for c in (sql_result.get("final_columns") or [])]

    # Case 1: boundary equivalence nitpick (generic, contract-driven).
    boundary_nitpick = any(
        tok in fb for tok in ["boundary", "filter", "exclude", "includes", "off-by-one", ">=", ">"]
    )
    if boundary_nitpick and _is_equivalent_time_boundary(final_sql, contract):
        return "pass", target, "Accepted equivalent numeric boundary semantics; no material answer change."

    # Case 2: critic asks to split into multiple requests, but single result already combines intent parts.
    required_kw = [str(d).lower() for d in (contract.get("required_keywords") or contract.get("required_dimensions") or [])]
    has_required_dims = bool(required_kw) and all(any(kw in c for c in final_cols) for kw in required_kw)
    has_rank = any(re.search(r"(^|_)(rank|rn)$", c) for c in final_cols)
    has_total_like = any(re.search(r"(total|overall|grand|all)", c) for c in final_cols)
    has_metric_like = any(re.search(r"(count|cnt|sum|avg|min|max)", c) for c in final_cols)
    combined_answer_present = has_required_dims and has_rank and has_total_like and has_metric_like

    asks_split = (
        any(
            tok in fb
            for tok in [
                "not fully answer",
                "does not fully answer",
                "two",
                "separate",
                "both",
                "split",
            ]
        )
        and target in {"planner", "both"}
        and bool(contract.get("per_group"))
        and bool(contract.get("top_n"))
    )
    if asks_split and combined_answer_present:
        return "pass", target, "Accepted: single SQL output already combines required dimensions and top-N/overall metrics."

    return verdict, target, feedback


def _override_sum_and_avg_both_requested(
    state: AgentState, verdict: str, target: str, feedback: str
) -> tuple[str, str, str]:
    """Pass when critic mistakes AVG(secondary metric) for violating a 'total' request.

    Typical false positive: question asks for a total/sum of one measure AND an average
    of a secondary measure, SQL correctly uses both SUM and AVG, but critic says 'use SUM not AVG'.
    """
    if verdict != "retry" or target != "sql":
        return verdict, target, feedback

    sql_result = state.get("sql_result", {}) or {}
    sql_steps = sql_result.get("steps", []) or []
    final_sql = ""
    if sql_steps:
        final_sql = str(sql_steps[-1].get("sql", ""))
    sql_u = final_sql.upper()

    if "SUM(" not in sql_u or "AVG(" not in sql_u:
        return verdict, target, feedback

    sql_task = (state.get("sql_task") or "").lower()
    user_q = (state.get("user_query") or "").lower()
    text = f"{sql_task}\n{user_q}"

    wants_sum_like = any(
        tok in text
        for tok in (
            "sum(",
            "summed",
            "combined sales",
            "total revenue",
            "aggregate sales",
            "grand total",
        )
    )
    wants_avg_like = any(
        tok in text
        for tok in (
            "average ",
            " avg",
            "avg(",
            "mean ",
            "rating",
        )
    )

    if not (wants_sum_like and wants_avg_like):
        return verdict, target, feedback

    fb = (feedback or "").lower()
    false_positive = (
        ("avg" in fb and "sum" in fb)
        or ("average" in fb and ("total" in fb or "sum" in fb))
        or ("avg" in fb and "total" in fb)
    )
    if false_positive:
        logger.info("Critic: overriding SUM/AVG false positive — both aggregates justified by question")
        return (
            "pass",
            target,
            "Accepted: question requests both a summed/totaled measure and a separate average; "
            "SUM and AVG in the same query are expected.",
        )

    return verdict, target, feedback


def _is_equivalent_time_boundary(sql: str, contract: dict) -> bool:
    """Check whether SQL time filter is semantically equivalent to contract boundary.

    Supported equivalence:
    - ... > N  == ... >= N+1
    Schema-agnostic: scans for any `> value` or `>= value` pattern in SQL.
    """
    tf = contract.get("time_filter") or {}
    op = str(tf.get("op", "")).strip()
    value = tf.get("value")
    if op not in {">", ">="} or not isinstance(value, (int, float)):
        return False

    expected = float(value)
    sql_u = (sql or "").upper()

    for m in re.finditer(r"(>=|>)\s*(-?\d+(?:\.\d+)?)", sql_u):
        found_op = m.group(1)
        try:
            found_val = float(m.group(2))
        except ValueError:
            continue
        if found_op == op and found_val == expected:
            return True
        if op == ">" and found_op == ">=" and found_val == expected + 1:
            return True
        if op == ">=" and found_op == ">" and found_val == expected - 1:
            return True

    return False


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