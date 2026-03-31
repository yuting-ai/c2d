"""Dataset versioning — snapshot-per-save, persisted as Parquet files.

Lifecycle
---------
1. Cell edit comes in via PATCH /cells  →  apply_cell_edit()
   - Immediately updates the live DuckDB table (no version created yet)
   - Appends to a pending-edits buffer (in-memory, per project/dataset)

2. Frontend debounces 3 s after last edit  →  POST /versions/snapshot
   - create_snapshot() flushes the buffer into a versioned Parquet file
   - Generates an auto-description from the buffered edits
   - Returns the new version metadata

3. On project load  →  restore_current()
   - Checks for a persisted "current version" pointer
   - If found, loads the Parquet snapshot back into DuckDB
   - Otherwise falls through to normal CSV → confirm flow

4. Restore to arbitrary version  →  restore_version()
   - Loads the target Parquet file back into DuckDB
   - Updates the "current" pointer
"""

from __future__ import annotations

import json
import shutil
import time
import logging
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd

from backend.config.settings import settings

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
#  Directory helpers
# ─────────────────────────────────────────────

def _versions_dir(project_id: str, dataset_id: str) -> Path:
    p = Path(settings.DUCKDB_DATA_DIR) / "versions" / project_id / dataset_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _meta_path(project_id: str, dataset_id: str) -> Path:
    return _versions_dir(project_id, dataset_id) / "versions.json"


def _parquet_path(project_id: str, dataset_id: str, version_id: str) -> Path:
    return _versions_dir(project_id, dataset_id) / f"{version_id}.parquet"


# ─────────────────────────────────────────────
#  In-memory pending-edits buffer
#  { (project_id, dataset_id) → [EditRecord] }
# ─────────────────────────────────────────────

_pending: dict[tuple[str, str], list[dict]] = {}


def _buffer_key(project_id: str, dataset_id: str) -> tuple[str, str]:
    return (project_id, dataset_id)


# ─────────────────────────────────────────────
#  Version metadata helpers
# ─────────────────────────────────────────────

def _load_meta(project_id: str, dataset_id: str) -> dict:
    path = _meta_path(project_id, dataset_id)
    if path.exists():
        return json.loads(path.read_text("utf-8"))
    return {"versions": [], "current_version_id": None}


def _save_meta(project_id: str, dataset_id: str, meta: dict) -> None:
    _meta_path(project_id, dataset_id).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_versions(project_id: str, dataset_id: str) -> list[dict]:
    """Return all versions for a dataset, newest first."""
    meta = _load_meta(project_id, dataset_id)
    current = meta.get("current_version_id")
    versions = meta.get("versions", [])
    for v in versions:
        v["is_current"] = (v["version_id"] == current)
    return list(reversed(versions))


def get_current_version_id(project_id: str, dataset_id: str) -> str | None:
    return _load_meta(project_id, dataset_id).get("current_version_id")


# ─────────────────────────────────────────────
#  Apply a single cell edit (immediate, no snapshot)
# ─────────────────────────────────────────────

def apply_cell_edit(
    conn: duckdb.DuckDBPyConnection,
    table_name: str,
    project_id: str,
    dataset_id: str,
    row_index: int,          # 0-based display row index (may be in sorted order)
    column: str,
    new_value: Any,
    sort_col: str | None = None,   # active sort column sent by the frontend
    sort_dir: str = "asc",         # "asc" or "desc"
    old_value: Any = None,
) -> None:
    """
    Apply one cell edit to the live DuckDB table and record it in the
    pending-edits buffer (to be committed later via create_snapshot).

    When the frontend grid is sorted, row_index is the display position in
    the sorted view, not the physical row in the table.  We resolve the
    correct physical row by sorting a copy of the DataFrame the same way
    and mapping back to the original index.
    """
    # Read full table into pandas, apply edit, re-register
    df: pd.DataFrame = conn.execute(f'SELECT * FROM "{table_name}"').df()

    if row_index < 0 or row_index >= len(df):
        raise IndexError(f"row_index {row_index} out of range (table has {len(df)} rows)")
    if column not in df.columns:
        raise KeyError(f"Column '{column}' not found in table '{table_name}'")

    # Resolve physical row index when a sort is active
    physical_idx: int = row_index
    if sort_col and sort_col in df.columns:
        ascending = sort_dir.lower() != "desc"
        df_sorted = (
            df
            .sort_values(sort_col, ascending=ascending, na_position="last")
            .reset_index()           # 'index' column now holds original positions
        )
        physical_idx = int(df_sorted.at[row_index, "index"])

    # Coerce type to match column dtype where possible
    target_dtype = df[column].dtype
    try:
        if pd.api.types.is_integer_dtype(target_dtype):
            new_value = int(new_value) if new_value not in (None, "", "NULL") else None
        elif pd.api.types.is_float_dtype(target_dtype):
            new_value = float(new_value) if new_value not in (None, "", "NULL") else None
    except (ValueError, TypeError):
        pass  # keep as string

    old_value = df.at[physical_idx, column] if old_value is None else old_value
    df.at[physical_idx, column] = new_value

    # Rebuild DuckDB table from updated DataFrame
    conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
    conn.register(f"_tmp_{table_name}", df)
    conn.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM "_tmp_{table_name}"')
    conn.unregister(f"_tmp_{table_name}")

    # Buffer the edit for the upcoming snapshot
    key = _buffer_key(project_id, dataset_id)
    if key not in _pending:
        _pending[key] = []
    _pending[key].append({
        "row_index": row_index,
        "column": column,
        "old_value": _json_safe(old_value),
        "new_value": _json_safe(new_value),
        "ts": time.time(),
    })

    logger.debug(f"Cell edit applied: {table_name}[{row_index}][{column}] = {new_value!r}")


# ─────────────────────────────────────────────
#  Create a version snapshot (called after debounce)
# ─────────────────────────────────────────────

def create_snapshot(
    conn: duckdb.DuckDBPyConnection,
    table_name: str,
    project_id: str,
    dataset_id: str,
) -> dict:
    """
    Save the current table state as a Parquet snapshot.
    Returns the new version metadata dict.
    """
    key = _buffer_key(project_id, dataset_id)
    edits = _pending.pop(key, [])

    if not edits:
        # Nothing to snapshot — return current version info
        meta = _load_meta(project_id, dataset_id)
        cur = meta.get("current_version_id")
        if cur:
            existing = next((v for v in meta["versions"] if v["version_id"] == cur), None)
            if existing:
                return existing
        return {"version_id": None, "description": "no changes", "created_at": None}

    # Build version id and description
    ts = int(time.time())
    version_id = f"v{ts}"
    description = _build_description(edits)

    # Export table to Parquet
    pq_path = _parquet_path(project_id, dataset_id, version_id)
    conn.execute(
        f"COPY (SELECT * FROM \"{table_name}\") TO '{pq_path}' (FORMAT PARQUET)"
    )

    # Update metadata
    meta = _load_meta(project_id, dataset_id)
    version_entry = {
        "version_id": version_id,
        "created_at": ts,
        "description": description,
        "table_name": table_name,
        "edits": edits,
    }
    meta["versions"].append(version_entry)
    meta["current_version_id"] = version_id
    _save_meta(project_id, dataset_id, meta)

    logger.info(f"Snapshot created: {project_id}/{dataset_id} → {version_id} ({len(edits)} edits)")
    return {**version_entry, "is_current": True}


# ─────────────────────────────────────────────
#  Restore a version
# ─────────────────────────────────────────────

def restore_version(
    conn: duckdb.DuckDBPyConnection,
    project_id: str,
    dataset_id: str,
    version_id: str,
) -> dict:
    """
    Restore the DuckDB table to the state of a given version snapshot.
    Updates the 'current' pointer.
    """
    meta = _load_meta(project_id, dataset_id)
    entry = next((v for v in meta["versions"] if v["version_id"] == version_id), None)
    if not entry:
        raise ValueError(f"Version '{version_id}' not found")

    table_name = entry["table_name"]
    pq_path = _parquet_path(project_id, dataset_id, version_id)
    if not pq_path.exists():
        raise FileNotFoundError(f"Parquet snapshot missing: {pq_path}")

    # Load Parquet back into DuckDB
    conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
    conn.execute(
        f"CREATE TABLE \"{table_name}\" AS SELECT * FROM read_parquet('{pq_path}')"
    )

    # Clear any pending edits (they're now stale)
    _pending.pop(_buffer_key(project_id, dataset_id), None)

    # Update current pointer
    meta["current_version_id"] = version_id
    _save_meta(project_id, dataset_id, meta)

    logger.info(f"Restored: {project_id}/{dataset_id} → {version_id}")
    return {**entry, "is_current": True}


def restore_current_version(
    conn: duckdb.DuckDBPyConnection,
    project_id: str,
    dataset_id: str,
    table_name: str,
) -> str | None:
    """
    On project load: if there's a persisted current version, reload it
    into DuckDB. Returns the version_id if loaded, None otherwise.
    """
    meta = _load_meta(project_id, dataset_id)
    cur = meta.get("current_version_id")
    if not cur:
        return None

    pq_path = _parquet_path(project_id, dataset_id, cur)
    if not pq_path.exists():
        logger.warning(f"Current version parquet missing: {pq_path}, skipping restore")
        return None

    try:
        conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
        conn.execute(
            f"CREATE TABLE \"{table_name}\" AS SELECT * FROM read_parquet('{pq_path}')"
        )
        logger.info(f"Auto-restored on load: {project_id}/{dataset_id} → {cur}")
        return cur
    except Exception as e:
        logger.error(f"Failed to restore version {cur}: {e}")
        return None


# ─────────────────────────────────────────────
#  Preview query (paginated + sortable)
# ─────────────────────────────────────────────

def query_preview(
    conn: duckdb.DuckDBPyConnection,
    table_name: str,
    offset: int = 0,
    limit: int = 30,
    sort_col: str | None = None,
    sort_dir: str = "asc",
) -> dict:
    """
    Return a paginated preview of a table.
    Returns: { columns, rows, total, col_types }
    """
    # Total row count
    total = conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]

    # Order clause
    order = ""
    if sort_col:
        # Validate sort_col against actual columns to prevent injection
        cols = [r[0] for r in conn.execute(f'DESCRIBE "{table_name}"').fetchall()]
        if sort_col in cols:
            direction = "DESC" if sort_dir.lower() == "desc" else "ASC"
            order = f'ORDER BY "{sort_col}" {direction}'

    sql = f'SELECT * FROM "{table_name}" {order} LIMIT {limit} OFFSET {offset}'
    result = conn.execute(sql)
    columns = [desc[0] for desc in result.description]
    rows = [list(r) for r in result.fetchall()]

    # Column type info
    desc_rows = conn.execute(f'DESCRIBE "{table_name}"').fetchall()
    col_types = {r[0]: r[1] for r in desc_rows}

    return {
        "columns": columns,
        "col_types": col_types,
        "rows": rows,
        "total": total,
        "offset": offset,
        "limit": limit,
    }


# ─────────────────────────────────────────────
#  CSV export
# ─────────────────────────────────────────────

def export_csv(
    conn: duckdb.DuckDBPyConnection,
    table_name: str,
    project_id: str,
    dataset_id: str,
) -> Path:
    """Export the current table to a CSV file. Returns the file path."""
    export_dir = Path(settings.EXPORT_DIR) / project_id
    export_dir.mkdir(parents=True, exist_ok=True)
    out_path = export_dir / f"{dataset_id}_{int(time.time())}.csv"
    conn.execute(f"COPY (SELECT * FROM \"{table_name}\") TO '{out_path}' (FORMAT CSV, HEADER TRUE)")
    return out_path


# ─────────────────────────────────────────────
#  Internal helpers
# ─────────────────────────────────────────────

def _json_safe(value: Any) -> Any:
    """Convert pandas/numpy scalars to JSON-serialisable Python types."""
    if hasattr(value, "item"):          # numpy scalar
        return value.item()
    if value is pd.NA or value is None:
        return None
    return value


def _build_description(edits: list[dict]) -> str:
    """Auto-generate a human-readable version description from edit records."""
    if not edits:
        return "no changes"
    n = len(edits)
    # Group by column
    col_counts: dict[str, int] = {}
    for e in edits:
        col_counts[e["column"]] = col_counts.get(e["column"], 0) + 1

    parts = [f"{col} ×{cnt}" if cnt > 1 else col for col, cnt in col_counts.items()]
    col_summary = ", ".join(parts[:3])
    if len(parts) > 3:
        col_summary += f" +{len(parts) - 3} more"

    return f"Edited {n} cell{'s' if n != 1 else ''} in: {col_summary}"
