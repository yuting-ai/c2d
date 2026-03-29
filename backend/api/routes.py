"""API routes — Phase 2 + Phase 3: dataset upload, decisions, confirm, analyze."""

import uuid
import os
from pathlib import Path
import json as _json
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
from typing import Any
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


def _bootstrap_project_from_db(project_id: str) -> bool:
    """Build in-memory project state from an existing DuckDB file on disk.

    Returns True when a project was successfully bootstrapped.
    """
    db_path = Path(settings.DUCKDB_DATA_DIR) / f"{project_id}.duckdb"
    if not db_path.exists():
        return False

    conn = engine.get_connection(project_id)
    try:
        tables = [row[0] for row in conn.execute("SHOW TABLES").fetchall()]
    except Exception:
        return False

    if not tables:
        return False

    project = _get_project(project_id)
    # Keep existing in-memory state if already loaded.
    if project["datasets"]:
        return True

    datasets: dict[str, dict] = {}
    for idx, table_name in enumerate(tables):
        # Build lightweight inferred schema directly from DuckDB table metadata.
        col_rows = conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()
        inferences: list[ColumnInference] = []
        for col_row in col_rows:
            col_name = str(col_row[1])
            col_type = str(col_row[2])
            inferences.append(ColumnInference(
                column=col_name,
                original_type=col_type,
                inferred_type=col_type,
                confidence=1.0,
                decision="auto",
                auto_note="restored from existing DuckDB table",
            ))

        row_count = _table_row_count(conn, table_name)
        dataset_id = f"restored_{idx}_{table_name}"
        datasets[dataset_id] = {
            "id": dataset_id,
            "name": f"{table_name}.duckdb",
            "filepath": str(db_path),
            "df": None,
            "row_count": row_count,
            "column_count": len(inferences),
            "inferences": inferences,
            "quality_issues": [],
            "decisions": {},
            "confirmed": True,
            "table_name": table_name,
        }

    project["datasets"] = datasets
    project["strategy_version"] = max(project.get("strategy_version", 0), 1)
    return True


def _safe_row_count(ds: dict) -> int:
    if "row_count" in ds and ds["row_count"] is not None:
        return int(ds["row_count"])
    if ds.get("df") is not None:
        return int(len(ds["df"]))
    return 0


def _safe_column_count(ds: dict) -> int:
    if "column_count" in ds and ds["column_count"] is not None:
        return int(ds["column_count"])
    if ds.get("df") is not None:
        return int(len(ds["df"].columns))
    return len(ds.get("inferences", []))


def _table_row_count(conn, table_name: str) -> int:
    row = conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()
    if not row:
        return 0
    return int(row[0])


# ══════════════════════════════════════
# POST /api/projects/{project_id}/datasets — Upload dataset
# ══════════════════════════════════════

@router.post("/projects/{project_id}/datasets")
async def upload_dataset(
    project_id: str,
    file: UploadFile = File(...),
    analysis_mode: str = Form("simple"),
):
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
        mode = "advanced" if analysis_mode == "advanced" else "simple"
        quality_issues = scan_quality(df, inferences, analysis_mode=mode)
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
            key=f"{qi.column}:{qi.issue_type}",
            column=qi.column,
            col_type=qi.col_type,
            issue_type=qi.issue_type,
            severity=qi.severity,
            must_solve=qi.must_solve,
            description=qi.description,
            options=(
                [ConversionOptionSchema(value=o.value, label=o.label) for o in qi.options]
                if qi.options else None
            ),
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

    # Merge decisions (empty value means clear decision)
    for key, value in body.decisions.items():
        if value is None or (isinstance(value, str) and not value.strip()):
            ds["decisions"].pop(key, None)
        else:
            ds["decisions"][key] = value

    # Count resolved blocking issues
    blocking_columns = [
        inf.column for inf in ds["inferences"] if inf.decision == "ask_user"
    ]
    resolved = sum(
        1 for col in blocking_columns
        if col in ds["decisions"] and str(ds["decisions"].get(col, "")).strip()
    )
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
            if col not in ds["decisions"] or not str(ds["decisions"].get(col, "")).strip():
                raise HTTPException(400, detail={
                    "ok": False,
                    "error": {
                        "code": "BLOCKING_UNRESOLVED",
                        "message": f"Dataset {ds['name']} has unresolved blocking issue: {col}",
                    }
                })

        must_solve_warnings = [
            qi for qi in ds.get("quality_issues", [])
            if qi.severity == "warning" and getattr(qi, "must_solve", False)
        ]
        for qi in must_solve_warnings:
            issue_key = f"{qi.column}:{qi.issue_type}"
            selected = ds["decisions"].get(issue_key) or ds["decisions"].get(qi.column)
            if not str(selected or "").strip():
                raise HTTPException(400, detail={
                    "ok": False,
                    "error": {
                        "code": "MUST_SOLVE_WARNING_UNRESOLVED",
                        "message": f"Dataset {ds['name']} has unresolved must-solve warning: {issue_key}",
                    }
                })

    # Increment strategy version
    is_update = project["strategy_version"] > 0
    project["strategy_version"] += 1

    # Apply decisions and register DuckDB tables
    conn = engine.get_connection(project_id)
    active_tables: list[ActiveTableSchema] = []

    for ds_id, ds in project["datasets"].items():
        # Restored projects loaded from existing DuckDB tables don't keep raw DataFrame in memory.
        # In this case, reuse the current table metadata instead of re-running apply_decisions().
        if ds.get("df") is None:
            table_name = ds.get("table_name") or ds["name"].rsplit(".", 1)[0]
            col_rows = conn.execute(f'PRAGMA table_info("{table_name}")').fetchall()
            columns = [str(row[1]) for row in col_rows]
            row_count = _table_row_count(conn, table_name)

            ds["confirmed"] = True
            ds["table_name"] = table_name

            active_tables.append(ActiveTableSchema(
                name=table_name,
                columns=columns,
                excluded_columns=[],
                row_count=row_count,
            ))
            continue

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
    if project_id not in _project_state:
        _bootstrap_project_from_db(project_id)
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
            "row_count": _safe_row_count(ds),
            "column_count": _safe_column_count(ds),
            "columns": columns,
        })

    return ApiResponse(data={
        "datasets": datasets,
        "strategy_version": project["strategy_version"],
        "system_mode": "chat" if all(d["confirmed"] for d in project["datasets"].values()) else "clean",
    })

# ══════════════════════════════════════
# Null-handling helpers
# ══════════════════════════════════════

_NULL_THRESHOLD = 0.40   # columns with ≥ 40 % NULL get flagged
_NUMERIC_TYPES  = ("INT", "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC", "REAL",
                   "BIGINT", "SMALLINT", "HUGEINT", "TINYINT", "UBIGINT")


def _is_numeric_type(type_str: str) -> bool:
    t = (type_str or "").upper()
    return any(nt in t for nt in _NUMERIC_TYPES)


def _recommend_null_method(query: str, col: str, null_pct: float, is_numeric: bool):
    """Return (method, reason) based on query content and column characteristics."""
    q = query.lower()
    ranking_kw  = ("top", "rank", "best", "worst", "highest", "lowest", "compare")
    trend_kw    = ("trend", "over time", "monthly", "yearly", "quarterly", "total", "sum")
    presence_kw = ("exist", "have", "any", "whether", "does")

    if not is_numeric:
        return "exclude", "Categorical columns cannot be imputed with mean or median."

    if any(kw in q for kw in presence_kw):
        return "keep_null", (
            "The question asks about data presence; keeping NULL is the most transparent approach."
        )
    if any(kw in q for kw in ranking_kw):
        return "median", (
            "Ranking and comparison queries are sensitive to extreme values; "
            "median imputation is more robust."
        )
    if any(kw in q for kw in trend_kw):
        return "mean", (
            "Trend and aggregation queries benefit from mean imputation "
            "to preserve the overall magnitude."
        )
    # Default: keep null (most conservative)
    return "keep_null", (
        f"Column has {null_pct:.0%} missing values. "
        "Keeping NULL is the safest default — SQL aggregates (AVG, SUM) skip NULLs automatically."
    )


def _build_null_options(is_numeric: bool) -> list[dict]:
    if is_numeric:
        return [
            {
                "method": "median",
                "label": "Fill with median",
                "impact": (
                    "Replaces NULL with the column median. "
                    "Most robust for comparisons and rankings — resistant to extreme values."
                ),
            },
            {
                "method": "mean",
                "label": "Fill with mean",
                "impact": (
                    "Replaces NULL with the column average. "
                    "Preserves total magnitude but can be pulled by outliers."
                ),
            },
            {
                "method": "keep_null",
                "label": "Keep as NULL",
                "impact": (
                    "SQL aggregations (AVG, SUM) automatically skip NULLs. "
                    "Results reflect only rows that have data — most transparent."
                ),
            },
            {
                "method": "exclude",
                "label": "Exclude this column",
                "impact": "Column will not appear in the analysis at all.",
            },
        ]
    # Categorical — only keep or exclude make sense
    return [
        {
            "method": "keep_null",
            "label": "Keep as NULL",
            "impact": "Rows with no value will be grouped under NULL in aggregations.",
        },
        {
            "method": "exclude",
            "label": "Exclude this column",
            "impact": "Column will not appear in the analysis at all.",
        },
    ]


# ══════════════════════════════════════
# GET /api/analyze/preflight — fast NULL-quality pre-check (no LLM)
# ══════════════════════════════════════

@router.get("/analyze/preflight")
async def analyze_preflight(
    project_id: str = Query(...),
    query: str = Query(...),
):
    """Scan active datasets for sparse columns and return recommended NULL-handling options.

    Called by the frontend *before* starting the analysis stream so the user can
    decide how to handle missing values.  No LLM is involved — this is a pure
    schema-level check and is typically < 50 ms.
    """
    from backend.memory.null_handling_prefs import load_null_prefs

    if project_id not in _project_state:
        _bootstrap_project_from_db(project_id)
    project = _get_project(project_id)

    saved_prefs = load_null_prefs(project_id)
    warnings: list[dict] = []

    for ds_id, ds in project["datasets"].items():
        if not ds.get("confirmed"):
            continue
        table_name = ds.get("table_name", "")

        for inf in ds.get("inferences", []):
            null_pct = inf.null_pct
            if null_pct is None or null_pct < _NULL_THRESHOLD:
                continue

            col_type    = inf.inferred_type or inf.original_type or ""
            is_numeric  = _is_numeric_type(col_type)
            recommended, reason = _recommend_null_method(query, inf.column, null_pct, is_numeric)

            entry: dict = {
                "column":             inf.column,
                "table":              table_name,
                "sparsity_rate":      round(null_pct, 3),
                "column_type":        col_type,
                "recommended":        recommended,
                "recommended_reason": reason,
                "options":            _build_null_options(is_numeric),
            }
            # Surface any previously saved user preference for this column
            if inf.column in saved_prefs:
                entry["saved_preference"] = saved_prefs[inf.column]

            warnings.append(entry)

    return ApiResponse(data={"warnings": warnings})


# ══════════════════════════════════════
# POST /api/analyze/save-null-prefs — persist user's null-handling choices
# ══════════════════════════════════════

class SaveNullPrefsRequest(BaseModel):
    config: dict[str, str]   # {column_name: method}

@router.post("/projects/{project_id}/null-prefs")
async def save_null_preferences(project_id: str, body: SaveNullPrefsRequest):
    """Persist the user's NULL-handling preferences for future sessions."""
    from backend.memory.null_handling_prefs import save_null_prefs
    save_null_prefs(project_id, body.config)
    return ApiResponse(data={"saved": True})


# ══════════════════════════════════════
# GET /api/analyze/stream — SSE analysis stream
# ══════════════════════════════════════

@router.get("/analyze/stream")
async def analyze_stream(
    project_id: str = Query(...),
    query: str = Query(...),
    null_handling_config: str = Query(default="", description="JSON-encoded {column: method} map"),
):
    """Run analysis pipeline and stream results via SSE."""
    if project_id not in _project_state:
        _bootstrap_project_from_db(project_id)
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
        excluded_set = {inf.column for inf in ds["inferences"] if ds["decisions"].get(inf.column) == "exclude"}

        # Build columns as list of dicts: {name, type} so the SQL Agent knows data types
        col_dicts = []
        for inf in ds["inferences"]:
            if inf.decision == "ask_user" and inf.column not in ds["decisions"]:
                continue
            if inf.column in excluded_set:
                continue
            col_type = inf.inferred_type or inf.original_type or "TEXT"
            col_dicts.append({"name": inf.column, "type": col_type})

        # Keep backward-compat: also expose plain name list for any code that still uses it
        columns = [c["name"] for c in col_dicts]

        active_tables.append({
            "name": table_name,
            "columns": columns,       # plain list (used by _validate_sql_candidate)
            "col_dicts": col_dicts,   # typed list (used by TABLE_SCHEMA_TEMPLATE)
            "row_count": _safe_row_count(ds),
        })

        # Build quality notes from decisions
        for col, option in ds["decisions"].items():
            inf = next((i for i in ds["inferences"] if i.column == col), None)
            if option == "exclude":
                continue
            if inf and inf.decision == "ask_user":
                quality_notes.append(f"{col}: non-{inf.inferred_type} values -> {option}")
            else:
                quality_notes.append(f"{col}: quality decision -> {option}")

    from backend.api.sse import run_analysis_stream

    dataset_ids = list(project["datasets"].keys())

    # Parse optional null_handling_config (JSON-encoded query string)
    parsed_null_config: dict[str, str] = {}
    if null_handling_config:
        try:
            parsed_null_config = _json.loads(null_handling_config)
        except Exception:
            pass   # Malformed JSON — ignore, use defaults

    return EventSourceResponse(
        run_analysis_stream(
            project_id=project_id,
            query=query,
            active_tables=active_tables,
            quality_notes=quality_notes,
            dataset_ids=dataset_ids,
            null_handling_config=parsed_null_config,
        )
    )


@router.get("/debug/projects")
async def debug_list_projects():
    """List restorable projects from local DuckDB files (test/debug only)."""
    base = Path(settings.DUCKDB_DATA_DIR)
    files = sorted(base.glob("proj_*.duckdb"), key=lambda p: p.stat().st_mtime, reverse=True)

    items = []
    for path in files:
        project_id = path.stem
        if project_id not in _project_state:
            _bootstrap_project_from_db(project_id)
        project = _get_project(project_id)
        datasets = list(project.get("datasets", {}).values())
        items.append({
            "project_id": project_id,
            "title": project_id,
            "dataset_names": [d.get("name", "") for d in datasets],
            "dataset_count": len(datasets),
            "strategy_version": project.get("strategy_version", 0),
            "updated_at": int(path.stat().st_mtime),
        })

    return ApiResponse(data={"projects": items})


# ══════════════════════════════════════
# LLM provider switch (runtime, no restart needed)
# ══════════════════════════════════════

@router.get("/llm/status")
async def llm_status():
    """Return current LLM provider and model."""
    info = get_current_provider()
    return ApiResponse(data=info)


# ══════════════════════════════════════════════════════════════
#  DATASET PREVIEW & VERSIONING ENDPOINTS
# ══════════════════════════════════════════════════════════════

from backend.db.versioning import (
    query_preview, apply_cell_edit, create_snapshot,
    restore_version, get_versions, get_current_version_id,
    export_csv,
)


def _get_ds_table(project_id: str, dataset_id: str) -> tuple[dict, str]:
    """Helper: resolve project + dataset, return (ds_dict, table_name)."""
    project = _get_project(project_id)
    ds = project["datasets"].get(dataset_id)
    if not ds:
        raise HTTPException(404, detail={
            "ok": False,
            "error": {"code": "DATASET_NOT_FOUND", "message": f"Dataset {dataset_id} not found"},
        })
    table_name = ds.get("table_name")
    if not table_name:
        raise HTTPException(400, detail={
            "ok": False,
            "error": {"code": "NOT_CONFIRMED", "message": "Dataset not confirmed yet"},
        })
    return ds, table_name


# ── Preview ──────────────────────────────────────────────────

@router.get("/projects/{project_id}/datasets/{dataset_id}/preview")
async def preview_dataset(
    project_id: str,
    dataset_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=500),
    sort_col: str = Query("", description="Column to sort by"),
    sort_dir: str = Query("asc", pattern="^(asc|desc)$"),
):
    """Return a paginated, optionally sorted preview of a dataset."""
    _, table_name = _get_ds_table(project_id, dataset_id)
    conn = engine.get_connection(project_id)
    data = query_preview(
        conn=conn,
        table_name=table_name,
        offset=offset,
        limit=limit,
        sort_col=sort_col or None,
        sort_dir=sort_dir,
    )
    version_id = get_current_version_id(project_id, dataset_id)
    return ApiResponse(data={**data, "version_id": version_id})


# ── Cell edit ────────────────────────────────────────────────

class CellEditRequest(BaseModel):
    row_index: int
    column: str
    value: Any


@router.patch("/projects/{project_id}/datasets/{dataset_id}/cells")
async def edit_cell(
    project_id: str,
    dataset_id: str,
    body: CellEditRequest,
):
    """Apply a single cell edit to the live DuckDB table."""
    _, table_name = _get_ds_table(project_id, dataset_id)
    conn = engine.get_connection(project_id)
    try:
        apply_cell_edit(
            conn=conn,
            table_name=table_name,
            project_id=project_id,
            dataset_id=dataset_id,
            row_index=body.row_index,
            column=body.column,
            new_value=body.value,
        )
    except (IndexError, KeyError) as e:
        raise HTTPException(400, detail={
            "ok": False,
            "error": {"code": "EDIT_ERROR", "message": str(e)},
        })
    return ApiResponse(data={"ok": True, "version_queued": True})


# ── Create snapshot (called after frontend debounce) ─────────

@router.post("/projects/{project_id}/datasets/{dataset_id}/versions/snapshot")
async def snapshot_version(project_id: str, dataset_id: str):
    """Flush pending edits into a persisted version snapshot."""
    _, table_name = _get_ds_table(project_id, dataset_id)
    conn = engine.get_connection(project_id)
    version = create_snapshot(
        conn=conn,
        table_name=table_name,
        project_id=project_id,
        dataset_id=dataset_id,
    )
    return ApiResponse(data=version)


# ── List versions ────────────────────────────────────────────

@router.get("/projects/{project_id}/datasets/{dataset_id}/versions")
async def list_versions(project_id: str, dataset_id: str):
    """Return all saved versions for a dataset, newest first."""
    # Validate dataset exists (even if not confirmed yet)
    project = _get_project(project_id)
    if dataset_id not in project["datasets"]:
        raise HTTPException(404, detail={
            "ok": False,
            "error": {"code": "DATASET_NOT_FOUND", "message": f"Dataset {dataset_id} not found"},
        })
    versions = get_versions(project_id, dataset_id)
    return ApiResponse(data={"versions": versions})


# ── Restore version ──────────────────────────────────────────

@router.post("/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/restore")
async def restore_dataset_version(
    project_id: str,
    dataset_id: str,
    version_id: str,
):
    """Restore a dataset to a previously saved version."""
    _, table_name = _get_ds_table(project_id, dataset_id)
    conn = engine.get_connection(project_id)
    try:
        version = restore_version(
            conn=conn,
            project_id=project_id,
            dataset_id=dataset_id,
            version_id=version_id,
        )
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, detail={
            "ok": False,
            "error": {"code": "VERSION_NOT_FOUND", "message": str(e)},
        })
    return ApiResponse(data=version)


# ── Export CSV ───────────────────────────────────────────────

@router.get("/projects/{project_id}/datasets/{dataset_id}/export")
async def export_dataset_csv(project_id: str, dataset_id: str):
    """Export the current dataset state as a CSV file."""
    ds, table_name = _get_ds_table(project_id, dataset_id)
    conn = engine.get_connection(project_id)
    try:
        csv_path = export_csv(
            conn=conn,
            table_name=table_name,
            project_id=project_id,
            dataset_id=dataset_id,
        )
    except Exception as e:
        raise HTTPException(500, detail={
            "ok": False,
            "error": {"code": "EXPORT_ERROR", "message": str(e)},
        })
    safe_name = ds["name"].rsplit(".", 1)[0] + "_export.csv"
    return FileResponse(
        path=str(csv_path),
        media_type="text/csv",
        filename=safe_name,
    )


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