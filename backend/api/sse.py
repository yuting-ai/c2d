"""SSE streaming — yields events as each pipeline node completes."""

import json
import logging
from typing import AsyncGenerator
from backend.graph.pipeline import pipeline
from backend.graph.state import AgentState

logger = logging.getLogger(__name__)


async def run_analysis_stream(
    project_id: str,
    query: str,
    active_tables: list[dict],
    quality_notes: list[str],
) -> AsyncGenerator[dict, None]:
    """Run pipeline, yield SSE dicts as each node completes."""

    initial_state: AgentState = {
        "user_query": query,
        "project_id": project_id,
        "session_id": f"session_{project_id}",
        "active_tables": active_tables,
        "quality_notes": quality_notes,
        "plan": [],
        "sql_task": "",
        "involved_columns": [],
        "sql_result": {},
        "stream_events": [],
        "retry_count": 0,
    }

    final_sql_result = {}

    try:
        logger.info(f"Starting pipeline: project={project_id} query={query[:80]}")

        # astream with updates mode: yields {node_name: state_update} per node
        async for chunk in pipeline.astream(initial_state, stream_mode="updates"):
            for node_name, update in chunk.items():
                logger.info(f"Node completed: {node_name}")

                # Yield accumulated events from this node
                for event in update.get("stream_events", []):
                    event_type = event.get("type", "progress")
                    event_data = event.get("data", {})
                    yield {"event": event_type, "data": json.dumps(event_data, default=str)}

                # Track sql_result for final done event
                if "sql_result" in update:
                    final_sql_result = update["sql_result"]

        # Yield done event
        answer = final_sql_result.get("answer", "")
        error = final_sql_result.get("error")

        if error:
            yield {
                "event": "error",
                "data": json.dumps({
                    "code": "PIPELINE_ERROR",
                    "message": error,
                    "agent": "SQL Agent",
                    "recoverable": True,
                }),
            }
        else:
            done_data = {
                "report": {
                    "conclusion": answer,
                    "should_record": bool(final_sql_result.get("final_rows")),
                    "strategy_version": 1,
                },
                "sql_result": {
                    "columns": final_sql_result.get("final_columns", []),
                    "rows": final_sql_result.get("final_rows", [])[:50],
                    "steps": [
                        {"title": s.get("title", ""), "sql": s.get("sql", ""), "tag": s.get("tag", "")}
                        for s in final_sql_result.get("steps", [])
                    ],
                },
            }
            yield {"event": "done", "data": json.dumps(done_data, default=str)}

        logger.info(f"Pipeline completed: project={project_id}")

    except Exception as e:
        logger.exception(f"Pipeline error: {e}")
        yield {
            "event": "error",
            "data": json.dumps({
                "code": "PIPELINE_ERROR",
                "message": str(e),
                "agent": "system",
                "recoverable": False,
            }),
        }