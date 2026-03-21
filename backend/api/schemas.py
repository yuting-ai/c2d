"""Pydantic models for API requests and responses."""

from pydantic import BaseModel
from typing import Any


# ══════════════════════════════════════
# Generic response wrapper
# ══════════════════════════════════════

class ApiResponse(BaseModel):
    ok: bool = True
    data: Any = None

class ApiError(BaseModel):
    ok: bool = False
    error: dict[str, str]


# ══════════════════════════════════════
# Dataset upload response
# ══════════════════════════════════════

class ConversionOptionSchema(BaseModel):
    value: str
    label: str

class ColumnSchema(BaseModel):
    name: str
    original_type: str
    inferred_type: str | None
    null_pct: float
    sample_values: list[str]

class BlockingIssueSchema(BaseModel):
    key: str
    column: str
    original_type: str
    inferred_type: str | None
    description: str
    samples: list[str]
    options: list[ConversionOptionSchema]

class WarningIssueSchema(BaseModel):
    column: str
    col_type: str
    description: str
    options: list[str] | None = None

class AutoConvertedSchema(BaseModel):
    column: str
    from_type: str
    to_type: str
    note: str

class DatasetUploadResponse(BaseModel):
    dataset_id: str
    name: str
    row_count: int
    column_count: int
    size_bytes: int
    columns: list[ColumnSchema]
    blocking_issues: list[BlockingIssueSchema]
    warning_issues: list[WarningIssueSchema]
    auto_converted: list[AutoConvertedSchema]


# ══════════════════════════════════════
# Decisions
# ══════════════════════════════════════

class SubmitDecisionsRequest(BaseModel):
    decisions: dict[str, str]    # column_name → option_value

class DecisionResponse(BaseModel):
    resolved_count: int
    unresolved_count: int
    all_resolved: bool


# ══════════════════════════════════════
# Confirm
# ══════════════════════════════════════

class ActiveTableSchema(BaseModel):
    name: str
    columns: list[str]
    excluded_columns: list[str]
    row_count: int

class ConfirmResponse(BaseModel):
    strategy_version: int
    is_update: bool
    active_tables: list[ActiveTableSchema]