"""LangGraph state shared across all agents."""

from typing import TypedDict, Annotated
from operator import add


class AgentState(TypedDict, total=False):
    # ── Input ──
    user_query: str
    user_lang: str  # BCP-47 code from pipeline entry (langdetect)
    session_id: str
    project_id: str

    # ── Dataset context ──
    active_tables: list[dict]       # [{name, columns, row_count}, ...]
    quality_notes: list[str]        # applied cleaning decisions as text

    # ── Planner output ──
    plan: list[str]                 # ["sql", "viz", "stats"]
    intent_pattern: str             # "P-A" … "P-H" — canonical query shape from Planner
    sql_task: str
    viz_task: str | None
    stats_task: str | None
    involved_columns: list[str]

    # ── NULL handling ──
    data_quality_warnings: list[dict]   # [{column, table, sparsity_rate, recommended, ...}]
    null_handling_config: dict          # {column_name: "mean"|"median"|"keep_null"|"exclude"}

    # ── SQL Agent output ──
    sql_result: dict                # {"steps": [...], "final_rows": [...], "final_columns": [...], "error": ...}

    # ── Viz Agent output (Phase 4) ──
    viz_result: dict | None

    # ── Stats Agent output (Phase 4) ──
    stats_result: dict | None

    # ── Critic output (Phase 4) ──
    critic_verdict: str             # "pass" | "retry"
    critic_feedback: str
    critic_hint: str                # machine-readable fix direction, e.g. "requires_window_function"
    retry_count: int
    retry_target: str | None        # "sql" | "planner" | "both" | None

    # ── Report output (Phase 4) ──
    report: dict | None
    should_record: bool

    # ── Streaming ──
    stream_events: Annotated[list[dict], add]   # accumulated SSE events