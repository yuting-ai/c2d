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

CURRENCY_SYMBOLS = {'$', '¥', '€', '£', '₹'}
DISTANCE_HINT_TOKENS = ('distance', 'dist', 'length', 'km', 'meter', 'metre', 'mileage')
DISTANCE_UNIT_PATTERN = re.compile(r'^\s*([+-]?\d+(?:\.\d+)?)\s*(km|m)\s*$', re.IGNORECASE)

UNIT_FAMILY_CONFIG = {
    'distance': {
        'label': 'distance units',
        'hints': DISTANCE_HINT_TOKENS,
        'pattern': re.compile(r'^\s*([+-]?\d+(?:\.\d+)?)\s*(km|m)\s*$', re.IGNORECASE),
        'aliases': {'km': 'km', 'm': 'm'},
        'options': [
            ('to_km', 'normalize to km'),
            ('to_m', 'normalize to m'),
            ('keep', 'keep as-is'),
        ],
    },
    'area': {
        'label': 'area units',
        'hints': ('area', 'size', 'sqft', 'sqm', 'm2', 'ft2'),
        'pattern': re.compile(r'^\s*([+-]?\d+(?:\.\d+)?)\s*(sqm|m2|sq_m|sqft|ft2)\s*$', re.IGNORECASE),
        'aliases': {'sqm': 'sqm', 'm2': 'sqm', 'sq_m': 'sqm', 'sqft': 'sqft', 'ft2': 'sqft'},
        'options': [
            ('to_sqm', 'normalize to sqm'),
            ('to_sqft', 'normalize to sqft'),
            ('keep', 'keep as-is'),
        ],
    },
    'weight': {
        'label': 'weight units',
        'hints': ('weight', 'mass', 'kg', 'gram', 'g', 'lb', 'lbs'),
        'pattern': re.compile(r'^\s*([+-]?\d+(?:\.\d+)?)\s*(kg|g|lb|lbs)\s*$', re.IGNORECASE),
        'aliases': {'kg': 'kg', 'g': 'g', 'lb': 'lb', 'lbs': 'lb'},
        'options': [
            ('to_kg', 'normalize to kg'),
            ('to_g', 'normalize to g'),
            ('to_lb', 'normalize to lb'),
            ('keep', 'keep as-is'),
        ],
    },
    'temperature': {
        'label': 'temperature units',
        'hints': ('temp', 'temperature', 'celsius', 'fahrenheit', 'deg_c', 'deg_f'),
        'pattern': re.compile(r'^\s*([+-]?\d+(?:\.\d+)?)\s*(c|f)\s*$', re.IGNORECASE),
        'aliases': {'c': 'c', 'f': 'f'},
        'options': [
            ('to_c', 'normalize to C'),
            ('to_f', 'normalize to F'),
            ('keep', 'keep as-is'),
        ],
    },
}

UNIT_TARGET_OPTIONS = {
    'to_km': ('distance', 'km'),
    'to_m': ('distance', 'm'),
    'to_sqm': ('area', 'sqm'),
    'to_sqft': ('area', 'sqft'),
    'to_kg': ('weight', 'kg'),
    'to_g': ('weight', 'g'),
    'to_lb': ('weight', 'lb'),
    'to_c': ('temperature', 'c'),
    'to_f': ('temperature', 'f'),
}


def _parse_plain_numeric(text: str) -> float | None:
    cleaned = text.strip().replace(',', '')
    try:
        return float(cleaned)
    except ValueError:
        return None


def _convert_unit_value(value: float, from_unit: str, to_unit: str, family: str) -> float:
    if family == 'distance':
        meters = value * 1000.0 if from_unit == 'km' else value
        return meters / 1000.0 if to_unit == 'km' else meters

    if family == 'area':
        sqm = value if from_unit == 'sqm' else value / 10.76391041671
        return sqm if to_unit == 'sqm' else sqm * 10.76391041671

    if family == 'weight':
        kg = value if from_unit == 'kg' else (value / 1000.0 if from_unit == 'g' else value / 2.20462262185)
        if to_unit == 'kg':
            return kg
        if to_unit == 'g':
            return kg * 1000.0
        return kg * 2.20462262185

    if family == 'temperature':
        celsius = value if from_unit == 'c' else (value - 32.0) * 5.0 / 9.0
        return celsius if to_unit == 'c' else celsius * 9.0 / 5.0 + 32.0

    return value


def _scan_mixed_unit_issue(
    col_name: str,
    col_type: str,
    non_null: pd.Series,
    analysis_mode: str,
) -> 'QualityIssue | None':
    if len(non_null) == 0:
        return None

    lower_col = col_name.lower()
    for family, cfg in UNIT_FAMILY_CONFIG.items():
        pattern = cfg['pattern']
        aliases = cfg['aliases']
        parsed_units: list[str] = []
        parsed_count = 0

        for v in non_null.tolist():
            m = pattern.match(str(v).strip().lower())
            if not m:
                continue
            parsed_count += 1
            parsed_units.append(aliases.get(m.group(2), m.group(2)))

        if parsed_count == 0:
            continue

        unit_set = set(parsed_units)
        parsed_ratio = parsed_count / len(non_null)
        has_hint = any(tok in lower_col for tok in cfg['hints'])
        if len(unit_set) < 2:
            continue
        if parsed_ratio < 0.30:
            continue
        if not has_hint and parsed_ratio < 0.70:
            continue

        unparsed = len(non_null) - parsed_count
        description = (
            f"mixed {cfg['label']} detected ({'/'.join(sorted(unit_set))}); "
            f"parsed {parsed_count}/{len(non_null)}"
        )
        if unparsed > 0:
            description += f", {unparsed} values without explicit unit"

        return QualityIssue(
            column=col_name,
            col_type=col_type,
            issue_type='unit_mismatch',
            severity='warning',
            must_solve=(analysis_mode == 'advanced'),
            description=description,
            options=[ConversionOption(value=v, label=l) for v, l in cfg['options']],
        )

    return None

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
    issue_type: str                     # missing | outlier | categorical
    severity: str                       # blocking | warning | info
    description: str
    options: list[ConversionOption] | None = None
    must_solve: bool = False


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
    for inferrer in [_try_boolean, _try_integer, _try_year_like_integer, _try_float, _try_date]:
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


def _try_year_like_integer(series: pd.Series, col: str, base: ColumnInference) -> ColumnInference | None:
    """Detect year-like columns stored as float strings (e.g. 2020.0)."""
    cleaned = series.str.strip()
    numeric = pd.to_numeric(cleaned, errors='coerce')
    confidence = numeric.notna().sum() / len(cleaned)
    if confidence < 0.95:
        return None

    valid = numeric.dropna()
    if len(valid) == 0:
        return None

    int_like_ratio = (abs(valid - valid.round()) < 1e-9).mean()
    year_range_ratio = ((valid >= 1950) & (valid <= 2100)).mean()
    lower_col = col.lower()
    has_year_hint = any(tok in lower_col for tok in ("year", "yr", "release_year"))

    if int_like_ratio >= 0.98 and (has_year_hint or year_range_ratio >= 0.90):
        base.inferred_type = "INTEGER"
        base.confidence = round(float(confidence), 3)
        base.decision = "auto"
        base.auto_note = "year-like numeric values normalized to INTEGER"
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
        dominant = max(format_counts, key=lambda k: format_counts[k])
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

def scan_quality(
    df: pd.DataFrame,
    inferences: list[ColumnInference],
    analysis_mode: str = "simple",
) -> list[QualityIssue]:
    """Scan all columns for quality issues."""
    issues: list[QualityIssue] = []
    missing_must_solve_threshold = 0.05 if analysis_mode == "advanced" else 0.50

    for inf in inferences:
        series = df[inf.column].astype(str)
        non_null = series[~series.str.strip().str.lower().isin(NULL_VALUES)]

        # ── Missing values ──
        if inf.null_pct > 0.30:
            is_numeric = inf.inferred_type in ("DOUBLE", "INTEGER")
            issues.append(QualityIssue(
                column=inf.column,
                col_type=inf.inferred_type or inf.original_type,
                issue_type="missing",
                severity="warning",
                must_solve=inf.null_pct >= missing_must_solve_threshold,
                description=f"{inf.null_pct*100:.0f}% missing",
                options=(
                    [
                        ConversionOption("mean", "fill missing with mean"),
                        ConversionOption("median", "fill missing with median"),
                        ConversionOption("drop_row", "drop rows with missing values"),
                        ConversionOption("keep", "keep missing values"),
                    ]
                    if is_numeric else
                    [
                        ConversionOption("mode", "fill with mode"),
                        ConversionOption("unknown", 'fill with "unknown"'),
                        ConversionOption("drop_row", "drop rows with missing values"),
                        ConversionOption("keep", "keep missing values"),
                    ]
                ),
            ))
        elif inf.null_pct > 0:
            issues.append(QualityIssue(
                column=inf.column,
                col_type=inf.inferred_type or inf.original_type,
                issue_type="missing",
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
                            issue_type="outlier",
                            severity=severity,
                            must_solve=(len(outliers) / len(numeric)) >= 0.08,
                            description=f"{len(outliers)} outliers (> 3σ, max {max_val:,.0f})",
                            options=(
                                [
                                    ConversionOption("keep", "keep"),
                                    ConversionOption("winsorize", "winsorize (cap 1st/99th pct)"),
                                    ConversionOption("clip_iqr", "clip by IQR bounds"),
                                    ConversionOption("drop_row", "drop outlier rows"),
                                ]
                                if severity == "warning" else None
                            ),
                        ))

        # ── Semantic: mixed unit families (distance/area/weight/temperature) ──
        unit_issue = _scan_mixed_unit_issue(
            col_name=inf.column,
            col_type=inf.inferred_type or inf.original_type,
            non_null=non_null,
            analysis_mode=analysis_mode,
        )
        if unit_issue:
            issues.append(unit_issue)

        # ── Semantic: percent scale mismatch (0-1 vs 0-100) ──
        if inf.inferred_type in ("DOUBLE", "INTEGER") and len(non_null) >= 10:
            raw = non_null.str.strip().str.replace('%', '', regex=False).str.replace(',', '', regex=False)
            numeric = pd.to_numeric(raw, errors='coerce').dropna()
            if len(numeric) >= 10:
                ratio_like = numeric[(numeric >= 0) & (numeric <= 1)]
                percent_like = numeric[(numeric > 1) & (numeric <= 100)]
                if len(ratio_like) >= 3 and len(percent_like) >= 3:
                    ratio_share = len(ratio_like) / len(numeric)
                    pct_share = len(percent_like) / len(numeric)
                    if ratio_share >= 0.10 and pct_share >= 0.10:
                        issues.append(QualityIssue(
                            column=inf.column,
                            col_type=inf.inferred_type,
                            issue_type="percent_scale",
                            severity="warning",
                            must_solve=(analysis_mode == "advanced"),
                            description="mixed percent scales detected (0-1 and 0-100)",
                            options=[
                                ConversionOption("normalize_to_percent", "normalize to 0-100"),
                                ConversionOption("normalize_to_ratio", "normalize to 0-1"),
                                ConversionOption("keep", "keep as-is"),
                            ],
                        ))

        # ── Semantic: mixed currency symbols ──
        if len(non_null) > 0:
            symbols: set[str] = set()
            symbol_rows = 0
            for v in non_null.tolist():
                text = str(v)
                found = {s for s in CURRENCY_SYMBOLS if s in text}
                if found:
                    symbol_rows += 1
                    symbols.update(found)

            if len(symbols) >= 2 and (symbol_rows / len(non_null)) >= 0.30:
                issues.append(QualityIssue(
                    column=inf.column,
                    col_type=inf.inferred_type or inf.original_type,
                    issue_type="currency_symbol",
                    severity="warning",
                    must_solve=(analysis_mode == "advanced"),
                    description=f"mixed currency symbols detected ({' '.join(sorted(symbols))})",
                    options=[
                        ConversionOption("strip_currency_symbol", "remove currency symbols (no FX conversion)"),
                        ConversionOption("keep", "keep as-is"),
                    ],
                ))

        # ── Possible categorical ──
        if inf.inferred_type is None:
            unique_count = series.nunique()
            if 2 <= unique_count <= 20 and len(series) > 100:
                issues.append(QualityIssue(
                    column=inf.column,
                    col_type="VARCHAR",
                    issue_type="categorical",
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
            if not inf.inferred_type:
                continue
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
        issue_key = f"{issue.column}:{issue.issue_type}"
        option = decisions.get(issue_key) or decisions.get(issue.column)
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

    if issue.issue_type == "missing":
        raw = df[col].astype(str).str.strip()
        missing_mask = raw.str.lower().isin(NULL_VALUES)
        normalized = df[col].mask(missing_mask)

        if option == "mode":
            mode_val = normalized.mode().iloc[0] if len(normalized.mode()) > 0 else None
            df[col] = normalized.fillna(mode_val)
        elif option == "unknown":
            df[col] = normalized.fillna("unknown")
        elif option == "mean":
            numeric = pd.to_numeric(normalized, errors='coerce')
            df[col] = numeric.fillna(numeric.mean())
        elif option == "median":
            numeric = pd.to_numeric(normalized, errors='coerce')
            df[col] = numeric.fillna(numeric.median())
        elif option in ("keep", "keep_null"):
            pass
        elif option in ("drop_row", "drop_rows"):
            df = df[~missing_mask]

    elif issue.issue_type == "outlier":
        numeric = pd.to_numeric(df[col], errors='coerce')
        mean, std = numeric.mean(), numeric.std()
        if option == "keep":
            pass
        elif option == "winsorize":
            lower, upper = numeric.quantile(0.01), numeric.quantile(0.99)
            df[col] = numeric.clip(lower, upper)
        elif option == "clip_iqr":
            q1, q3 = numeric.quantile(0.25), numeric.quantile(0.75)
            iqr = q3 - q1
            lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            df[col] = numeric.clip(lower, upper)
        elif option in ("drop_row", "drop_rows"):
            if std > 0:
                df = df[abs(numeric - mean) <= 3 * std]

    elif issue.issue_type == "unit_mismatch":
        if option in UNIT_TARGET_OPTIONS:
            family, target_unit = UNIT_TARGET_OPTIONS[option]
            cfg = UNIT_FAMILY_CONFIG[family]
            pattern = cfg['pattern']
            aliases = cfg['aliases']

            def _convert_unit(v: object) -> float | None:
                text = str(v).strip().lower()
                m = pattern.match(text)
                if m:
                    value = float(m.group(1))
                    from_unit = aliases.get(m.group(2), m.group(2))
                    return _convert_unit_value(value, from_unit, target_unit, family)

                parsed = _parse_plain_numeric(text)
                return parsed

            df[col] = df[col].apply(_convert_unit)

    elif issue.issue_type == "percent_scale":
        numeric = pd.to_numeric(
            df[col].astype(str).str.strip().str.replace('%', '', regex=False).str.replace(',', '', regex=False),
            errors='coerce',
        )
        if option == "normalize_to_percent":
            mask = (numeric >= 0) & (numeric <= 1)
            numeric.loc[mask] = numeric.loc[mask] * 100.0
            df[col] = numeric
        elif option == "normalize_to_ratio":
            mask = (numeric > 1) & (numeric <= 100)
            numeric.loc[mask] = numeric.loc[mask] / 100.0
            df[col] = numeric

    elif issue.issue_type == "currency_symbol":
        if option == "strip_currency_symbol":
            cleaned = df[col].astype(str)
            for sym in CURRENCY_SYMBOLS:
                cleaned = cleaned.str.replace(sym, '', regex=False)
            cleaned = cleaned.str.strip().str.replace(',', '', regex=False)
            df[col] = pd.to_numeric(cleaned, errors='coerce')

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