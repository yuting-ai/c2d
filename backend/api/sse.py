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
    final_viz_result = None
    final_stats_result = None
    final_report = None

    try:
        logger.info(f"Starting pipeline: project={project_id} query={query[:80]}")

        async for chunk in pipeline.astream(initial_state, stream_mode="updates"):
            for node_name, update in chunk.items():
                logger.info(f"Node completed: {node_name}")

                for event in update.get("stream_events", []):
                    event_type = event.get("type", "progress")
                    event_data = event.get("data", {})
                    yield {"event": event_type, "data": json.dumps(event_data, default=str)}

                # Track results
                if "sql_result" in update:
                    final_sql_result = update["sql_result"]
                if "viz_result" in update and update["viz_result"]:
                    final_viz_result = update["viz_result"]
                if "stats_result" in update and update["stats_result"]:
                    final_stats_result = update["stats_result"]
                if "report" in update and update["report"]:
                    final_report = update["report"]

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
            report_data = final_report or {}
            done_data = {
                "report": {
                    "conclusion": answer,
                    "should_record": report_data.get("should_record", bool(final_sql_result.get("final_rows"))),
                    "strategy_version": report_data.get("strategy_version", 1),
                    "evidence": report_data.get("evidence"),
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
            if final_viz_result:
                done_data["viz_result"] = final_viz_result
            if final_stats_result:
                done_data["stats_result"] = final_stats_result
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