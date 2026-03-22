"""LangGraph state shared across all agents."""

from typing import TypedDict, Annotated
from operator import add


class AgentState(TypedDict, total=False):
    # ── Input ──
    user_query: str
    session_id: str
    project_id: str

    # ── Dataset context ──
    active_tables: list[dict]       # [{name, columns, row_count}, ...]
    quality_notes: list[str]        # applied cleaning decisions as text

    # ── Planner output ──
    plan: list[str]                 # ["sql", "viz", "stats"]
    sql_task: str
    viz_task: str | None
    stats_task: str | None
    involved_columns: list[str]

    # ── SQL Agent output ──
    sql_result: dict                # {"steps": [...], "final_rows": [...], "final_columns": [...], "error": ...}

    # ── Viz Agent output (Phase 4) ──
    viz_result: dict | None

    # ── Stats Agent output (Phase 4) ──
    stats_result: dict | None

    # ── Critic output (Phase 4) ──
    critic_verdict: str             # "pass" | "retry"
    critic_feedback: str
    retry_count: int
    retry_target: str | None

    # ── Report output (Phase 4) ──
    report: dict | None
    should_record: bool

    # ── Streaming ──
    stream_events: Annotated[list[dict], add]   # accumulated SSE events