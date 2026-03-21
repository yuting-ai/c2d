"""Data loading pipeline: parse → infer types → scan quality → apply decisions → DuckDB."""

import re
import pandas as pd
import duckdb
from dataclasses import dataclass, field
from pathlib import Path


# ── Null value whitelist ──
NULL_VALUES = {'', 'null', 'none', 'n/a', 'na', '-', '.', 'nan', 'missing', 'unknown'}

# ── Numeric cleaning patterns ──
STRIP_PATTERNS = [
    (re.compile(r'^[\$¥€£₹]\s*'), ''),
    (re.compile(r'\s*%$'), ''),
    (re.compile(r',', ), ''),
]

# ── Type detection patterns ──
INT_PATTERN = re.compile(r'^[+-]?\d{1,15}$')
FLOAT_PATTERN = re.compile(r'^[+-]?\d{1,15}(\.\d+)?([eE][+-]?\d+)?$')

BOOL_TRUE = {'true', 'yes', 'y', '1', 'on', 'active'}
BOOL_FALSE = {'false', 'no', 'n', '0', 'off', 'inactive'}

DATE_PATTERNS = [
    (re.compile(r'^\d{4}-\d{2}-\d{2}$'), '%Y-%m-%d', 'ISO'),
    (re.compile(r'^\d{4}/\d{2}/\d{2}$'), '%Y/%m/%d', 'ISO-slash'),
    (re.compile(r'^\d{8}$'), '%Y%m%d', 'compact'),
    (re.compile(r'^\d{2}/\d{2}/\d{4}$'), None, 'ambiguous'),
    (re.compile(r'^\d{2}-\d{2}-\d{4}$'), None, 'ambiguous'),
]

SQL_KEYWORDS = {
    'select', 'from', 'where', 'table', 'index', 'create', 'drop',
    'insert', 'update', 'delete', 'order', 'group', 'having', 'join',
    'union', 'all', 'as', 'on', 'in', 'not', 'and', 'or', 'null',
    'true', 'false', 'between', 'like', 'is', 'exists', 'case', 'when',
}


# ══════════════════════════════════════
# Data structures
# ══════════════════════════════════════

@dataclass
class ConversionOption:
    value: str
    label: str


@dataclass
class ColumnInference:
    column: str
    original_type: str = "VARCHAR"
    inferred_type: str | None = None
    confidence: float = 0.0
    format_consistent: bool = True
    decision: str = "keep_string"       # auto | ask_user | keep_string

    auto_note: str | None = None
    conflicting_samples: list[str] | None = None
    options: list[ConversionOption] | None = None

    null_count: int = 0
    null_pct: float = 0.0
    sample_values: list[str] = field(default_factory=list)


@dataclass
class QualityIssue:
    column: str
    col_type: str
    severity: str                       # blocking | warning | info
    description: str
    options: list[str] | None = None


@dataclass
class TableRegistration:
    name: str
    columns: list[str]
    excluded_columns: list[str]
    row_count: int
    dtypes: dict[str, str]


# ══════════════════════════════════════
# Phase 1: File parsing
# ══════════════════════════════════════

def parse_file(filepath: str) -> pd.DataFrame:
    """Parse uploaded file into DataFrame with all columns as string."""
    ext = filepath.rsplit('.', 1)[-1].lower()

    if ext == 'csv':
        df = pd.read_csv(filepath, dtype=str, keep_default_na=False)
    elif ext in ('tsv', 'txt'):
        df = pd.read_csv(filepath, sep='\t', dtype=str, keep_default_na=False)
    elif ext in ('xlsx', 'xls'):
        df = pd.read_excel(filepath, dtype=str, keep_default_na=False)
    else:
        raise ValueError(f"Unsupported file format: .{ext}")

    # Normalize column names
    df.columns = [
        col.strip().lower().replace(' ', '_').replace('-', '_')
        for col in df.columns
    ]

    # Drop fully empty rows
    df = df.replace('', pd.NA).dropna(how='all').fillna('')
    df = df.reset_index(drop=True)

    return df


# ══════════════════════════════════════
# Phase 2: Type inference
# ══════════════════════════════════════

def infer_types(df: pd.DataFrame) -> list[ColumnInference]:
    """Infer types for all columns."""
    results = []
    for col in df.columns:
        series = df[col].astype(str)
        result = _infer_column_type(series, col)
        results.append(result)
    return results


def _get_non_null(series: pd.Series) -> tuple[pd.Series, int, float]:
    """Split series into non-null values and compute null stats."""
    mask = series.str.strip().str.lower().isin(NULL_VALUES)
    non_null = series[~mask]
    null_count = mask.sum()
    null_pct = null_count / len(series) if len(series) > 0 else 0
    return non_null, int(null_count), float(null_pct)


def _infer_column_type(series: pd.Series, col: str) -> ColumnInference:
    """Infer type for a single column."""
    non_null, null_count, null_pct = _get_non_null(series)
    samples = non_null.head(5).tolist() if len(non_null) > 0 else []

    base = ColumnInference(
        column=col,
        null_count=null_count,
        null_pct=round(null_pct, 4),
        sample_values=samples,
    )

    if len(non_null) == 0:
        return base

    # Try each inferrer in priority order
    for inferrer in [_try_boolean, _try_integer, _try_float, _try_date]:
        result = inferrer(non_null, col, base)
        if result:
            return result

    return base


def _try_boolean(series: pd.Series, col: str, base: ColumnInference) -> ColumnInference | None:
    values = set(series.str.strip().str.lower())
    if values.issubset(BOOL_TRUE | BOOL_FALSE) and len(values) >= 2:
        base.inferred_type = "BOOLEAN"
        base.confidence = 1.0
        base.decision = "auto"
        base.auto_note = "all values in {true/false} set"
        return base
    return None


def _try_integer(series: pd.Series, col: str, base: ColumnInference) -> ColumnInference | None:
    cleaned = series.str.strip().str.replace(',', '', regex=False)
    match_count = cleaned.apply(lambda v: bool(INT_PATTERN.match(v))).sum()
    confidence = match_count / len(cleaned)

    if confidence >= 0.95:
        base.inferred_type = "INTEGER"
        base.confidence = round(confidence, 3)
        base.decision = "auto"
        base.auto_note = f"{confidence*100:.0f}% integer"
        return base
    return None


def _try_float(series: pd.Series, col: str, base: ColumnInference) -> ColumnInference | None:
    def clean(v: str) -> str:
        v = v.strip()
        for pattern, repl in STRIP_PATTERNS:
            v = pattern.sub(repl, v)
        return v

    cleaned = series.apply(clean)
    matches = cleaned.apply(lambda v: bool(FLOAT_PATTERN.match(v)))
    match_count = matches.sum()
    total = len(cleaned)
    confidence = match_count / total

    if confidence >= 0.95:
        base.inferred_type = "DOUBLE"
        base.confidence = round(confidence, 3)
        base.decision = "auto"
        base.auto_note = f"{confidence*100:.0f}% numeric"
        return base

    if confidence >= 0.60:
        non_match = cleaned[~matches].head(5).tolist()
        base.inferred_type = "DOUBLE"
        base.confidence = round(confidence, 3)
        base.format_consistent = False
        base.decision = "ask_user"
        base.conflicting_samples = non_match
        base.options = [
            ConversionOption("null", "→ null (safest, excludes rows)"),
            ConversionOption("zero", "→ 0 (treats non-numeric as zero)"),
            ConversionOption("mean", "→ mean (fill with average)"),
            ConversionOption("median", "→ median (robust to outliers)"),
            ConversionOption("exclude", "exclude this column"),
        ]
        return base

    return None


def _try_date(series: pd.Series, col: str, base: ColumnInference) -> ColumnInference | None:
    cleaned = series.str.strip()

    format_counts: dict[str, int] = {}
    for pattern, fmt, label in DATE_PATTERNS:
        count = cleaned.apply(lambda v: bool(pattern.match(v))).sum()
        if count > 0:
            format_counts[label] = count

    if not format_counts:
        return None

    total_matched = sum(format_counts.values())
    confidence = total_matched / len(cleaned)

    if confidence < 0.60:
        return None

    has_ambiguous = 'ambiguous' in format_counts
    all_consistent = len(format_counts) == 1

    if confidence >= 0.95 and all_consistent and not has_ambiguous:
        dominant = max(format_counts, key=format_counts.get)
        base.inferred_type = "DATE"
        base.confidence = round(confidence, 3)
        base.decision = "auto"
        base.auto_note = f"100% {dominant} format"
        return base

    # Ambiguous or mixed → ask user
    samples = []
    for pat, fmt, label in DATE_PATTERNS:
        match = cleaned[cleaned.apply(lambda v: bool(pat.match(v)))].head(1)
        if len(match) > 0:
            samples.append(match.iloc[0])

    base.inferred_type = "DATE"
    base.confidence = round(confidence, 3)
    base.format_consistent = False
    base.decision = "ask_user"
    base.conflicting_samples = samples[:5]
    base.options = [
        ConversionOption("iso", "ISO: YYYY-MM-DD (recommended)"),
        ConversionOption("us", "US: MM/DD/YYYY"),
        ConversionOption("eu", "EU: DD/MM/YYYY"),
        ConversionOption("exclude", "exclude this column"),
    ]
    return base


# ══════════════════════════════════════
# Phase 3: Quality scanning
# ══════════════════════════════════════

def scan_quality(df: pd.DataFrame, inferences: list[ColumnInference]) -> list[QualityIssue]:
    """Scan all columns for quality issues."""
    issues: list[QualityIssue] = []

    for inf in inferences:
        series = df[inf.column].astype(str)

        # ── Missing values ──
        if inf.null_pct > 0.30:
            issues.append(QualityIssue(
                column=inf.column,
                col_type=inf.original_type,
                severity="warning",
                description=f"{inf.null_pct*100:.0f}% missing",
                options=["fill with mode", 'fill with "unknown"', "keep null", "drop rows"],
            ))
        elif inf.null_pct > 0:
            issues.append(QualityIssue(
                column=inf.column,
                col_type=inf.inferred_type or inf.original_type,
                severity="info",
                description=f"{inf.null_pct*100:.1f}% missing ({inf.null_count} rows)",
            ))

        # ── Outliers (numeric auto-converted columns only) ──
        if inf.inferred_type in ("DOUBLE", "INTEGER") and inf.decision == "auto":
            numeric = pd.to_numeric(
                series.str.strip().str.replace(',', '', regex=False),
                errors='coerce',
            ).dropna()

            if len(numeric) > 10:
                mean, std = numeric.mean(), numeric.std()
                if std > 0:
                    outliers = numeric[abs(numeric - mean) > 3 * std]
                    if len(outliers) > 0:
                        max_val = outliers.max()
                        severity = "warning" if len(outliers) > 5 else "info"
                        issues.append(QualityIssue(
                            column=inf.column,
                            col_type=inf.inferred_type,
                            severity=severity,
                            description=f"{len(outliers)} outliers (> 3σ, max {max_val:,.0f})",
                            options=(
                                ["keep", "flag & keep (adds is_outlier col)", "clip to 3σ", "drop rows"]
                                if severity == "warning" else None
                            ),
                        ))

        # ── Possible categorical ──
        if inf.inferred_type is None:
            unique_count = series.nunique()
            if 2 <= unique_count <= 20 and len(series) > 100:
                issues.append(QualityIssue(
                    column=inf.column,
                    col_type="VARCHAR",
                    severity="info",
                    description=f"possible categorical — {unique_count} unique values",
                ))

    return issues


# ══════════════════════════════════════
# Phase 4: Apply decisions & register DuckDB table
# ══════════════════════════════════════

def apply_decisions(
    df: pd.DataFrame,
    inferences: list[ColumnInference],
    quality_issues: list[QualityIssue],
    decisions: dict[str, str],
    dataset_name: str,
    conn: duckdb.DuckDBPyConnection,
) -> TableRegistration:
    """Apply user decisions, clean data, register as DuckDB table."""

    df = df.copy()
    excluded_columns: list[str] = []

    # ── Type conversions ──
    for inf in inferences:
        col = inf.column

        if inf.decision == "auto":
            df[col] = _convert_auto(df[col].astype(str), inf.inferred_type)

        elif inf.decision == "ask_user":
            option = decisions.get(col) or decisions.get(inf.column)
            if not option:
                continue
            if option == "exclude":
                excluded_columns.append(col)
                continue
            df[col] = _convert_with_decision(df[col].astype(str), inf, option)

    # ── Quality decisions ──
    for issue in quality_issues:
        if issue.severity != "warning":
            continue
        option = decisions.get(issue.column)
        if not option:
            continue
        df = _apply_quality_decision(df, issue, option)

    # ── Remove excluded columns ──
    if excluded_columns:
        df = df.drop(columns=[c for c in excluded_columns if c in df.columns])

    # ── Register to DuckDB ──
    table_name = sanitize_table_name(dataset_name)
    conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
    conn.register(f"_tmp_{table_name}", df)
    conn.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM "_tmp_{table_name}"')
    conn.unregister(f"_tmp_{table_name}")

    return TableRegistration(
        name=table_name,
        columns=[c for c in df.columns],
        excluded_columns=excluded_columns,
        row_count=len(df),
        dtypes={c: str(df[c].dtype) for c in df.columns},
    )


def _convert_auto(series: pd.Series, target_type: str) -> pd.Series:
    """Apply automatic type conversion."""
    cleaned = series.str.strip()
    null_mask = cleaned.str.lower().isin(NULL_VALUES)

    if target_type == "INTEGER":
        result = pd.to_numeric(cleaned.str.replace(',', '', regex=False), errors='coerce')
        result[null_mask] = pd.NA
        return result.astype('Int64')

    elif target_type == "DOUBLE":
        for pattern, repl in STRIP_PATTERNS:
            cleaned = cleaned.str.replace(pattern, repl, regex=True)
        result = pd.to_numeric(cleaned, errors='coerce')
        return result

    elif target_type == "DATE":
        result = pd.to_datetime(cleaned, errors='coerce', format='mixed')
        return result

    elif target_type == "BOOLEAN":
        return cleaned.str.lower().isin(BOOL_TRUE)

    return series


def _convert_with_decision(series: pd.Series, inf: ColumnInference, option: str) -> pd.Series:
    """Apply user-chosen conversion for ambiguous columns."""
    cleaned = series.str.strip()

    if inf.inferred_type == "DOUBLE":
        for pattern, repl in STRIP_PATTERNS:
            cleaned = cleaned.str.replace(pattern, repl, regex=True)
        numeric = pd.to_numeric(cleaned, errors='coerce')

        if option == "null":
            return numeric
        elif option == "zero":
            return numeric.fillna(0)
        elif option == "mean":
            return numeric.fillna(numeric.mean())
        elif option == "median":
            return numeric.fillna(numeric.median())

    elif inf.inferred_type == "DATE":
        if option == "iso":
            return pd.to_datetime(cleaned, format='mixed', dayfirst=False, errors='coerce')
        elif option == "us":
            return pd.to_datetime(cleaned, format='%m/%d/%Y', errors='coerce')
        elif option == "eu":
            return pd.to_datetime(cleaned, format='%d/%m/%Y', errors='coerce')

    return series


def _apply_quality_decision(df: pd.DataFrame, issue: QualityIssue, option: str) -> pd.DataFrame:
    """Apply quality-related decisions."""
    col = issue.column

    if "missing" in issue.description:
        if option == "mode":
            mode_val = df[col].mode().iloc[0] if len(df[col].mode()) > 0 else None
            df[col] = df[col].fillna(mode_val)
        elif option == "unknown":
            df[col] = df[col].fillna("unknown")
        elif option == "null":
            pass
        elif option == "drop":
            df = df.dropna(subset=[col])

    elif "outlier" in issue.description:
        numeric = pd.to_numeric(df[col], errors='coerce')
        mean, std = numeric.mean(), numeric.std()
        if option == "keep":
            pass
        elif option == "flag":
            df[f"{col}_is_outlier"] = abs(numeric - mean) > 3 * std
        elif option == "clip":
            lower, upper = mean - 3 * std, mean + 3 * std
            df[col] = numeric.clip(lower, upper)
        elif option == "drop":
            df = df[abs(numeric - mean) <= 3 * std]

    return df


def sanitize_table_name(filename: str) -> str:
    """Convert filename to safe DuckDB table name."""
    name = filename.rsplit('.', 1)[0]
    name = re.sub(r'[^a-zA-Z0-9_]', '_', name)
    name = re.sub(r'_+', '_', name)
    name = name.strip('_').lower()
    if name in SQL_KEYWORDS:
        name = f"t_{name}"
    return name