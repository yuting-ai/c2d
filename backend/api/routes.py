"""API routes — Phase 2 + Phase 3: dataset upload, decisions, confirm, analyze."""

import uuid
import os
from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from fastapi.responses import StreamingResponse
from sse_starlette.sse import EventSourceResponse
from backend.api.schemas import (
    ApiResponse, ApiError,
    DatasetUploadResponse, ColumnSchema, BlockingIssueSchema,
    WarningIssueSchema, AutoConvertedSchema, ConversionOptionSchema,
    SubmitDecisionsRequest, DecisionResponse,
    ConfirmResponse, ActiveTableSchema,
)
from backend.db.loader import (
    parse_file, infer_types, scan_quality, apply_decisions,
    ColumnInference, QualityIssue,
)
from backend.db.engine import engine
from backend.config.settings import settings
from backend.agents.base import set_provider, get_current_provider

router = APIRouter(prefix="/api")

# ── In-memory state (will move to SessionStorage in Phase 3+) ──
# Key: project_id → dataset state
_project_state: dict[str, dict] = {}

def _get_project(project_id: str) -> dict:
    if project_id not in _project_state:
        _project_state[project_id] = {
            "datasets": {},
            "strategy_version": 0,
        }
    return _project_state[project_id]


# ══════════════════════════════════════
# POST /api/projects/{project_id}/datasets — Upload dataset
# ══════════════════════════════════════

@router.post("/projects/{project_id}/datasets")
async def upload_dataset(project_id: str, file: UploadFile = File(...)):
    """Upload a CSV/Excel file, run type inference and quality scan."""

    # Validate file extension
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in ("csv", "tsv", "txt", "xlsx", "xls"):
        raise HTTPException(400, detail={
            "ok": False,
            "error": {"code": "VALIDATION_ERROR", "message": f"Unsupported format: .{ext}"}
        })

    # Save to uploads dir
    dataset_id = f"ds_{uuid.uuid4().hex[:8]}"
    filename = file.filename or f"{dataset_id}.csv"
    filepath = os.path.join(settings.UPLOAD_DIR, f"{dataset_id}_{filename}")

    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    # Parse → Infer → Scan
    try:
        df = parse_file(filepath)
        inferences = infer_types(df)
        quality_issues = scan_quality(df, inferences)
    except Exception as e:
        os.remove(filepath)
        raise HTTPException(500, detail={
            "ok": False,
            "error": {"code": "INTERNAL_ERROR", "message": str(e)}
        })

    # Build response
    columns = []
    blocking_issues = []
    auto_converted = []
    blocking_idx = 0

    for inf in inferences:
        columns.append(ColumnSchema(
            name=inf.column,
            original_type=inf.original_type,
            inferred_type=inf.inferred_type,
            null_pct=inf.null_pct,
            sample_values=inf.sample_values,
        ))

        if inf.decision == "ask_user":
            blocking_issues.append(BlockingIssueSchema(
                key=f"{inf.column}",
                column=inf.column,
                original_type=inf.original_type,
                inferred_type=inf.inferred_type,
                description=_build_blocking_description(inf),
                samples=inf.conflicting_samples or [],
                options=[
                    ConversionOptionSchema(value=o.value, label=o.label)
                    for o in (inf.options or [])
                ],
            ))
            blocking_idx += 1

        elif inf.decision == "auto" and inf.inferred_type:
            auto_converted.append(AutoConvertedSchema(
                column=inf.column,
                from_type=inf.original_type,
                to_type=inf.inferred_type,
                note=inf.auto_note or "",
            ))

    warning_issues = [
        WarningIssueSchema(
            column=qi.column,
            col_type=qi.col_type,
            description=qi.description,
            options=qi.options,
        )
        for qi in quality_issues
        if qi.severity == "warning"
    ]

    # Store state for later phases
    project = _get_project(project_id)
    project["datasets"][dataset_id] = {
        "id": dataset_id,
        "name": filename,
        "filepath": filepath,
        "df": df,
        "inferences": inferences,
        "quality_issues": quality_issues,
        "decisions": {},
        "confirmed": False,
    }

    response = DatasetUploadResponse(
        dataset_id=dataset_id,
        name=filename,
        row_count=len(df),
        column_count=len(df.columns),
        size_bytes=len(content),
        columns=columns,
        blocking_issues=blocking_issues,
        warning_issues=warning_issues,
        auto_converted=auto_converted,
    )

    return ApiResponse(data=response.model_dump())


def _build_blocking_description(inf: ColumnInference) -> str:
    """Generate human-readable description for a blocking issue."""
    if inf.inferred_type == "DOUBLE":
        non_match_pct = (1 - inf.confidence) * 100
        return f"numeric column with non-numeric values ({non_match_pct:.1f}%)"
    elif inf.inferred_type == "DATE":
        return "mixed date formats — month/day order ambiguous"
    return f"ambiguous type (confidence: {inf.confidence:.0%})"


# ══════════════════════════════════════
# PUT /api/projects/{project_id}/datasets/{dataset_id}/decisions
# ══════════════════════════════════════

@router.put("/projects/{project_id}/datasets/{dataset_id}/decisions")
async def submit_decisions(
    project_id: str,
    dataset_id: str,
    body: SubmitDecisionsRequest,
):
    """Submit data cleaning decisions for blocking issues."""
    project = _get_project(project_id)
    ds = project["datasets"].get(dataset_id)
    if not ds:
        raise HTTPException(404, detail={
            "ok": False,
            "error": {"code": "DATASET_NOT_FOUND", "message": f"Dataset {dataset_id} not found"}
        })

    # Merge decisions
    ds["decisions"].update(body.decisions)

    # Count resolved blocking issues
    blocking_columns = [
        inf.column for inf in ds["inferences"] if inf.decision == "ask_user"
    ]
    resolved = sum(1 for col in blocking_columns if col in ds["decisions"])
    unresolved = len(blocking_columns) - resolved

    return ApiResponse(data=DecisionResponse(
        resolved_count=resolved,
        unresolved_count=unresolved,
        all_resolved=unresolved == 0,
    ).model_dump())


# ══════════════════════════════════════
# POST /api/projects/{project_id}/confirm
# ══════════════════════════════════════

@router.post("/projects/{project_id}/confirm")
async def confirm_schema(project_id: str):
    """Confirm decisions, apply cleaning, register DuckDB tables."""
    project = _get_project(project_id)

    if not project["datasets"]:
        raise HTTPException(400, detail={
            "ok": False,
            "error": {"code": "VALIDATION_ERROR", "message": "No datasets uploaded"}
        })

    # Check all blocking issues resolved
    for ds_id, ds in project["datasets"].items():
        blocking_columns = [
            inf.column for inf in ds["inferences"] if inf.decision == "ask_user"
        ]
        for col in blocking_columns:
            if col not in ds["decisions"]:
                raise HTTPException(400, detail={
                    "ok": False,
                    "error": {
                        "code": "BLOCKING_UNRESOLVED",
                        "message": f"Dataset {ds['name']} has unresolved blocking issue: {col}",
                    }
                })

    # Increment strategy version
    is_update = project["strategy_version"] > 0
    project["strategy_version"] += 1

    # Apply decisions and register DuckDB tables
    conn = engine.get_connection(project_id)
    active_tables: list[ActiveTableSchema] = []

    for ds_id, ds in project["datasets"].items():
        reg = apply_decisions(
            df=ds["df"],
            inferences=ds["inferences"],
            quality_issues=ds["quality_issues"],
            decisions=ds["decisions"],
            dataset_name=ds["name"],
            conn=conn,
        )

        ds["confirmed"] = True
        ds["table_name"] = reg.name

        active_tables.append(ActiveTableSchema(
            name=reg.name,
            columns=reg.columns,
            excluded_columns=reg.excluded_columns,
            row_count=reg.row_count,
        ))

    return ApiResponse(data=ConfirmResponse(
        strategy_version=project["strategy_version"],
        is_update=is_update,
        active_tables=active_tables,
    ).model_dump())


# ══════════════════════════════════════
# GET /api/projects/{project_id}/schema — Schema info
# ══════════════════════════════════════

@router.get("/projects/{project_id}/schema")
async def get_schema(project_id: str):
    """Get current schema info for all datasets in a project."""
    project = _get_project(project_id)

    datasets = []
    for ds_id, ds in project["datasets"].items():
        columns = []
        for inf in ds["inferences"]:
            columns.append({
                "name": inf.column,
                "type": inf.inferred_type or inf.original_type,
                "null_pct": inf.null_pct,
                "sample_values": inf.sample_values,
            })

        datasets.append({
            "id": ds_id,
            "name": ds["name"],
            "confirmed": ds["confirmed"],
            "row_count": len(ds["df"]),
            "column_count": len(ds["df"].columns),
            "columns": columns,
        })

    return ApiResponse(data={
        "datasets": datasets,
        "strategy_version": project["strategy_version"],
        "system_mode": "chat" if all(d["confirmed"] for d in project["datasets"].values()) else "clean",
    })

# ══════════════════════════════════════
# GET /api/analyze/stream — SSE analysis stream
# ══════════════════════════════════════

@router.get("/analyze/stream")
async def analyze_stream(
    project_id: str = Query(...),
    query: str = Query(...),
):
    """Run analysis pipeline and stream results via SSE."""
    project = _get_project(project_id)

    # Validate project has confirmed datasets
    if not project["datasets"]:
        raise HTTPException(400, detail={
            "ok": False,
            "error": {"code": "VALIDATION_ERROR", "message": "No datasets uploaded"}
        })

    unconfirmed = [
        ds["name"] for ds in project["datasets"].values()
        if not ds.get("confirmed")
    ]
    if unconfirmed:
        raise HTTPException(400, detail={
            "ok": False,
            "error": {
                "code": "BLOCKING_UNRESOLVED",
                "message": f"Unconfirmed datasets: {', '.join(unconfirmed)}",
            }
        })

    # Build active_tables context for agents
    active_tables = []
    quality_notes = []

    for ds_id, ds in project["datasets"].items():
        table_name = ds.get("table_name", ds["name"].rsplit(".", 1)[0])
        columns = [inf.column for inf in ds["inferences"] if inf.decision != "ask_user" or inf.column in ds["decisions"]]
        excluded = [inf.column for inf in ds["inferences"] if ds["decisions"].get(inf.column) == "exclude"]
        columns = [c for c in columns if c not in excluded]

        active_tables.append({
            "name": table_name,
            "columns": columns,
            "row_count": len(ds["df"]),
        })

        # Build quality notes from decisions
        for col, option in ds["decisions"].items():
            inf = next((i for i in ds["inferences"] if i.column == col), None)
            if inf and option != "exclude":
                quality_notes.append(f"{col}: non-{inf.inferred_type} values → {option}")

    from backend.api.sse import run_analysis_stream

    return EventSourceResponse(
        run_analysis_stream(
            project_id=project_id,
            query=query,
            active_tables=active_tables,
            quality_notes=quality_notes,
        )
    )


# ══════════════════════════════════════
# LLM provider switch (runtime, no restart needed)
# ══════════════════════════════════════

@router.get("/llm/status")
async def llm_status():
    """Return current LLM provider and model."""
    info = get_current_provider()
    return ApiResponse(data=info)


@router.put("/llm/provider")
async def switch_llm_provider(
    provider: str = Query(..., description="deepseek | ollama | anthropic"),
    model: str = Query(None, description="Override model name (optional)"),
):
    """Switch LLM provider at runtime. Takes effect immediately for new requests."""
    allowed = {"deepseek", "ollama", "anthropic"}
    if provider not in allowed:
        raise HTTPException(400, detail={
            "ok": False,
            "error": {
                "code": "VALIDATION_ERROR",
                "message": f"Unknown provider '{provider}'. Allowed: {', '.join(sorted(allowed))}",
            }
        })

    set_provider(provider, model)
    info = get_current_provider()
    return ApiResponse(data={
        "switched": True,
        **info,
    })