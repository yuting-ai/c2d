# c2d — Data Pipeline

本文档覆盖从用户上传文件到 DuckDB 表注册的完整数据处理流程实现细节。对应后端 `backend/db/` 目录和 architecture.md Section 11 的 implementation。

---

## 1. 总览

```
用户上传文件
    │
    ▼
┌──────────────────────────────────────────────────┐
│  loader.py                                        │
│                                                   │
│  1. parse()        → 读取文件，统一为 DataFrame    │
│  2. infer_types()  → 逐列类型推断                  │
│  3. scan_quality() → 数据质量扫描，分级标记         │
│  4. apply_decisions() → 执行用户决策，写入 DuckDB  │
│                                                   │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  engine.py                                        │
│                                                   │
│  DuckDB 连接管理 + 表注册 + 文件持久化             │
│                                                   │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  sandbox.py                                       │
│                                                   │
│  SQL 执行沙箱：超时、行数限制、只读隔离            │
│                                                   │
└──────────────────────────────────────────────────┘
```

---

## 2. 文件解析（parse）

 **文件** ：`backend/db/loader.py` → `parse()`

### 2.1 支持格式

| 格式  | 扩展名             | 解析方式                                    |
| ----- | ------------------ | ------------------------------------------- |
| CSV   | `.csv`           | `pandas.read_csv()`，自动检测分隔符和编码 |
| TSV   | `.tsv`           | `pandas.read_csv(sep='\t')`               |
| Excel | `.xlsx`,`.xls` | `pandas.read_excel()`（openpyxl / xlrd）  |

### 2.2 解析规则

```python
def parse(file_path: str) -> pd.DataFrame:
    """读取文件，统一为 DataFrame。所有列初始读取为字符串。"""
  
    ext = Path(file_path).suffix.lower()
  
    if ext == '.csv':
        # 自动检测分隔符（csv.Sniffer）
        # 自动检测编码（chardet，fallback utf-8）
        # dtype=str → 所有列初始为字符串，避免 pandas 自动推断出错
        df = pd.read_csv(file_path, dtype=str, keep_default_na=False)
  
    elif ext == '.tsv':
        df = pd.read_csv(file_path, sep='\t', dtype=str, keep_default_na=False)
  
    elif ext in ('.xlsx', '.xls'):
        df = pd.read_excel(file_path, dtype=str, keep_default_na=False)
  
    else:
        raise UnsupportedFileError(f"Unsupported file type: {ext}")
  
    # 列名清洗
    df.columns = [clean_column_name(c) for c in df.columns]
  
    return df
```

### 2.3 列名清洗

```python
def clean_column_name(name: str) -> str:
    """清洗列名，确保 DuckDB 兼容。"""
    name = name.strip()
    name = re.sub(r'\s+', '_', name)          # 空格 → 下划线
    name = re.sub(r'[^\w]', '', name)          # 移除特殊字符
    name = name.lower()                         # 全小写
    if name[0].isdigit():
        name = '_' + name                       # 数字开头加前缀
    return name
```

---

## 3. 类型推断（infer_types）

 **文件** ：`backend/db/loader.py` → `infer_types()`

对每一列进行类型推断，返回三种结果之一：

```python
class ConversionResult:
    AUTO_CONVERT = "auto"     # 高置信度，无歧义，自动转换
    ASK_USER     = "ask"      # 有歧义，需要用户选择 → BLOCKING issue
    KEEP_STRING  = "keep"     # 无法识别，保持 VARCHAR
```

### 3.1 推断流程

```python
def infer_types(df: pd.DataFrame) -> list[ColumnInference]:
    results = []
    for col in df.columns:
        series = df[col].dropna()
        if len(series) == 0:
            results.append(ColumnInference(col, "VARCHAR", "keep", confidence=0))
            continue
      
        # 按优先级尝试
        result = (
            try_integer(series) or
            try_float(series) or
            try_date(series) or
            try_boolean(series) or
            try_categorical(series) or
            ColumnInference(col, "VARCHAR", "keep", confidence=1.0)
        )
        results.append(result)
  
    return results
```

### 3.2 各类型推断规则

#### Integer

```python
def try_integer(series: pd.Series) -> ColumnInference | None:
    """尝试推断为 INTEGER。"""
    cleaned = series.str.strip().str.replace(',', '', regex=False)
    int_pattern = r'^-?\d+$'
    match_rate = cleaned.str.match(int_pattern).mean()
  
    if match_rate >= 0.95:
        return ColumnInference(
            column=series.name,
            inferred_type="INTEGER",
            action="auto",
            confidence=match_rate,
            note=f"{match_rate:.1%} integer format"
        )
    return None
```

#### Float / Double

```python
def try_float(series: pd.Series) -> ColumnInference | None:
    """尝试推断为 DOUBLE。"""
    cleaned = series.str.strip().str.replace(',', '', regex=False)
    float_pattern = r'^-?\d+\.?\d*([eE][+-]?\d+)?$'
    match_rate = cleaned.str.match(float_pattern).mean()
  
    non_numeric = cleaned[~cleaned.str.match(float_pattern)]
    non_numeric_samples = non_numeric.head(5).tolist()
    non_numeric_rate = 1 - match_rate
  
    if match_rate >= 0.95:
        return ColumnInference(
            column=series.name,
            inferred_type="DOUBLE",
            action="auto",
            confidence=match_rate,
            note=f"{match_rate:.1%} numeric"
        )
  
    if match_rate >= 0.60:
        return ColumnInference(
            column=series.name,
            inferred_type="DOUBLE",
            action="ask",
            confidence=match_rate,
            non_numeric_rate=non_numeric_rate,
            non_numeric_samples=non_numeric_samples,
            options=[
                {"value": "null", "label": "→ null (safest, excludes rows)"},
                {"value": "zero", "label": "→ 0 (treats N/A as zero)"},
                {"value": "mean", "label": "→ mean (fill with average)"},
                {"value": "median", "label": "→ median (robust to outliers)"},
                {"value": "exclude", "label": "exclude this column"},
            ]
        )
    return None
```

#### Date

```python
DATE_PATTERNS = [
    (r'^\d{4}-\d{2}-\d{2}$',      'ISO',       '%Y-%m-%d'),
    (r'^\d{4}/\d{2}/\d{2}$',      'ISO/',      '%Y/%m/%d'),
    (r'^\d{8}$',                    'compact',   '%Y%m%d'),
    (r'^\d{2}/\d{2}/\d{4}$',      'ambiguous', None),
    (r'^\d{2}-\d{2}-\d{4}$',      'ambiguous', None),
]

def try_date(series: pd.Series) -> ColumnInference | None:
    """尝试推断为 DATE。"""
    cleaned = series.str.strip()
  
    detected_formats = []
    for pattern, name, fmt in DATE_PATTERNS:
        rate = cleaned.str.match(pattern).mean()
        if rate > 0.1:
            detected_formats.append((name, fmt, rate))
  
    if not detected_formats:
        return None
  
    total_match = sum(r for _, _, r in detected_formats)
    has_ambiguous = any(n == 'ambiguous' for n, _, _ in detected_formats)
  
    if total_match >= 0.95 and not has_ambiguous:
        primary_fmt = max(detected_formats, key=lambda x: x[2])
        return ColumnInference(
            column=series.name,
            inferred_type="DATE",
            action="auto",
            confidence=total_match,
            date_format=primary_fmt[1],
            note=f"{total_match:.1%} {primary_fmt[0]} format"
        )
  
    if total_match >= 0.60:
        samples = cleaned.head(5).tolist()
        return ColumnInference(
            column=series.name,
            inferred_type="DATE",
            action="ask",
            confidence=total_match,
            samples=samples,
            options=[
                {"value": "iso", "label": "ISO: YYYY-MM-DD (recommended)"},
                {"value": "us", "label": "US: MM/DD/YYYY"},
                {"value": "eu", "label": "EU: DD/MM/YYYY"},
                {"value": "exclude", "label": "exclude this column"},
            ]
        )
    return None
```

#### Boolean

```python
BOOL_TRUTHY = {'true', 'yes', '1', 't', 'y'}
BOOL_FALSY  = {'false', 'no', '0', 'f', 'n'}

def try_boolean(series: pd.Series) -> ColumnInference | None:
    cleaned = series.str.strip().str.lower()
    unique = set(cleaned.unique())
  
    if unique.issubset(BOOL_TRUTHY | BOOL_FALSY) and len(unique) <= 4:
        return ColumnInference(
            column=series.name,
            inferred_type="BOOLEAN",
            action="auto",
            confidence=1.0,
            note="binary values detected"
        )
    return None
```

#### Categorical 检测

```python
def try_categorical(series: pd.Series) -> ColumnInference | None:
    n_unique = series.nunique()
    n_total = len(series)
  
    if n_unique < 20 and n_unique / n_total < 0.05:
        return ColumnInference(
            column=series.name,
            inferred_type="VARCHAR",
            action="keep",
            confidence=1.0,
            is_categorical=True,
            n_unique=n_unique,
            note=f"likely categorical ({n_unique} unique values)"
        )
    return None
```

### 3.3 推断结果数据结构

```python
@dataclass
class ColumnInference:
    column: str
    inferred_type: str            # INTEGER, DOUBLE, DATE, BOOLEAN, VARCHAR
    action: str                   # auto | ask | keep
    confidence: float
  
    date_format: str | None = None
    note: str = ""
  
    options: list[dict] | None = None
    samples: list[str] | None = None
    non_numeric_rate: float | None = None
    non_numeric_samples: list[str] | None = None
  
    is_categorical: bool = False
    n_unique: int | None = None
```

---

## 4. 数据质量扫描（scan_quality）

 **文件** ：`backend/db/loader.py` → `scan_quality()`

### 4.1 严重程度定义

```python
class Severity(Enum):
    BLOCKING = "blocking"
    WARNING  = "warning"
    INFO     = "info"
```

### 4.2 扫描规则

```python
def scan_quality(df: pd.DataFrame, inferences: list[ColumnInference]) -> list[QualityIssue]:
    issues = []
  
    for col in df.columns:
        series = df[col]
        inference = next(i for i in inferences if i.column == col)
      
        if inference.action == "ask":
            issues.append(QualityIssue(
                column=col,
                severity=Severity.BLOCKING,
                description=build_blocking_description(inference),
                options=inference.options,
                samples=inference.samples
            ))
      
        null_rate = series.isna().mean() + (series == '').mean()
      
        if null_rate > 0.30:
            issues.append(QualityIssue(
                column=col,
                severity=Severity.WARNING,
                description=f"{null_rate:.0%} missing ({int(null_rate * len(series))} rows)",
                null_rate=null_rate
            ))
        elif null_rate > 0.0:
            issues.append(QualityIssue(
                column=col,
                severity=Severity.INFO,
                description=f"{null_rate:.1%} missing",
                null_rate=null_rate
            ))
      
        if inference.inferred_type in ("INTEGER", "DOUBLE") and inference.action == "auto":
            numeric = pd.to_numeric(series, errors='coerce').dropna()
            if len(numeric) > 10:
                z_scores = (numeric - numeric.mean()) / numeric.std()
                outlier_count = (z_scores.abs() > 3).sum()
                if outlier_count > 0:
                    max_val = numeric.max()
                    issues.append(QualityIssue(
                        column=col,
                        severity=Severity.WARNING if outlier_count > 5 else Severity.INFO,
                        description=f"{outlier_count} outliers (> 3σ, max {max_val:,.0f})",
                        outlier_count=outlier_count
                    ))
      
        if inference.is_categorical:
            issues.append(QualityIssue(
                column=col,
                severity=Severity.INFO,
                description=f"likely categorical ({inference.n_unique} unique values)",
            ))
  
    return issues
```

### 4.3 分级阈值汇总

| 指标         | BLOCKING     | WARNING | INFO                    |
| ------------ | ------------ | ------- | ----------------------- |
| 类型歧义     | action="ask" | —      | —                      |
| 缺失率       | —           | > 30%   | > 0% 且 ≤ 30%          |
| 离群值 (3σ) | —           | > 5 个  | 1-5 个                  |
| 疑似分类     | —           | —      | unique < 20 且占比 < 5% |

---

## 5. 用户决策执行（apply_decisions）

 **文件** ：`backend/db/loader.py` → `apply_decisions()`

### 5.1 执行逻辑

```python
def apply_decisions(
    df: pd.DataFrame,
    inferences: list[ColumnInference],
    decisions: dict[str, dict],
    dataset_name: str
) -> tuple[pd.DataFrame, list[str]]:
    excluded_columns = []
  
    for inference in inferences:
        col = inference.column
      
        if inference.action == "auto":
            df = auto_convert(df, inference)
      
        elif inference.action == "ask":
            issue_key = find_issue_key(inference)
            decision = decisions.get(issue_key)
          
            if not decision:
                raise BlockingUnresolvedException(
                    f"Column '{col}' requires a decision but none was provided"
                )
          
            option = decision["option"]
          
            if option == "exclude":
                excluded_columns.append(col)
                df = df.drop(columns=[col])
                continue
          
            df = apply_type_decision(df, inference, option)
  
    return df, excluded_columns


def auto_convert(df: pd.DataFrame, inference: ColumnInference) -> pd.DataFrame:
    col = inference.column
  
    if inference.inferred_type == "INTEGER":
        df[col] = pd.to_numeric(
            df[col].str.strip().str.replace(',', '', regex=False),
            errors='coerce'
        ).astype('Int64')
  
    elif inference.inferred_type == "DOUBLE":
        df[col] = pd.to_numeric(
            df[col].str.strip().str.replace(',', '', regex=False),
            errors='coerce'
        )
  
    elif inference.inferred_type == "DATE":
        df[col] = pd.to_datetime(
            df[col].str.strip(),
            format=inference.date_format,
            errors='coerce'
        )
  
    elif inference.inferred_type == "BOOLEAN":
        df[col] = df[col].str.strip().str.lower().isin(BOOL_TRUTHY)
  
    return df


def apply_type_decision(df, inference, option):
    col = inference.column
  
    if inference.inferred_type == "DOUBLE":
        numeric = pd.to_numeric(
            df[col].str.strip().str.replace(',', '', regex=False),
            errors='coerce'
        )
        if option == "null":
            df[col] = numeric
        elif option == "zero":
            df[col] = numeric.fillna(0)
        elif option == "mean":
            df[col] = numeric.fillna(numeric.mean())
        elif option == "median":
            df[col] = numeric.fillna(numeric.median())
  
    elif inference.inferred_type == "DATE":
        fmt_map = {"iso": '%Y-%m-%d', "us": '%m/%d/%Y', "eu": '%d/%m/%Y'}
        df[col] = pd.to_datetime(df[col], format=fmt_map.get(option), errors='coerce')
  
    return df
```

---

## 6. DuckDB 引擎（engine.py）

 **文件** ：`backend/db/engine.py`

### 6.1 连接管理

```python
import duckdb
from pathlib import Path

class DuckDBEngine:
    """每个项目一个独立的 .duckdb 文件。"""
  
    def __init__(self, data_dir: str):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._connections: dict[str, duckdb.DuckDBPyConnection] = {}
  
    def get_connection(self, project_id: str) -> duckdb.DuckDBPyConnection:
        if project_id not in self._connections:
            db_path = self.data_dir / f"{project_id}.duckdb"
            self._connections[project_id] = duckdb.connect(str(db_path))
        return self._connections[project_id]
  
    def close(self, project_id: str):
        conn = self._connections.pop(project_id, None)
        if conn:
            conn.close()
  
    def close_all(self):
        for conn in self._connections.values():
            conn.close()
        self._connections.clear()
```

### 6.2 表注册

```python
def register_table(engine, project_id, dataset_name, df, excluded_columns):
    conn = engine.get_connection(project_id)
    table_name = sanitize_table_name(dataset_name)
  
    conn.execute(f"DROP TABLE IF EXISTS {table_name}")
    conn.execute(f"CREATE TABLE {table_name} AS SELECT * FROM df")
  
    schema = conn.execute(f"DESCRIBE {table_name}").fetchall()
    row_count = conn.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
  
    return TableInfo(
        name=table_name,
        columns=[{"name": col, "type": dtype} for col, dtype, *_ in schema],
        excluded_columns=excluded_columns,
        row_count=row_count
    )


def sanitize_table_name(filename: str) -> str:
    name = Path(filename).stem
    name = re.sub(r'[^\w]', '_', name)
    name = re.sub(r'_+', '_', name).strip('_')
    name = name.lower()
    if name[0].isdigit():
        name = 't_' + name
    return name
```

### 6.3 数据持久化

```
data/processed/
├── proj_abc123.duckdb      # 项目 A 的所有表
├── proj_def456.duckdb      # 项目 B 的所有表
```

---

## 7. SQL 执行沙箱（sandbox.py）

 **文件** ：`backend/db/sandbox.py`

```python
class QuerySandbox:
    MAX_ROWS = 50000
    TIMEOUT_SECONDS = 30
    BLOCKED_KEYWORDS = [
        'DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER',
        'CREATE TABLE', 'TRUNCATE', 'GRANT', 'REVOKE',
    ]
  
    def __init__(self, engine: DuckDBEngine):
        self.engine = engine
  
    async def execute(self, project_id: str, sql: str) -> QueryResult:
        sql_upper = sql.upper().strip()
      
        for keyword in self.BLOCKED_KEYWORDS:
            if keyword in sql_upper:
                raise ForbiddenQueryError(f"Blocked keyword: {keyword}")
      
        if not (sql_upper.startswith('SELECT') or sql_upper.startswith('WITH')):
            raise ForbiddenQueryError("Only SELECT and WITH queries allowed")
      
        if 'LIMIT' not in sql_upper:
            sql = f"SELECT * FROM ({sql}) sub LIMIT {self.MAX_ROWS}"
      
        conn = self.engine.get_connection(project_id)
      
        try:
            start = time.monotonic()
            result = conn.execute(sql)
            columns = [desc[0] for desc in result.description]
            rows = result.fetchall()
            execution_ms = int((time.monotonic() - start) * 1000)
          
            return QueryResult(
                columns=columns, rows=rows,
                row_count=len(rows), execution_ms=execution_ms,
                truncated=len(rows) >= self.MAX_ROWS
            )
        except duckdb.Error as e:
            return QueryResult(error=str(e), sql=sql)
```

---

## 8. Join Graph 检测

 **文件** ：`backend/db/loader.py` → `detect_join_keys()`

```python
def detect_join_keys(new_df, existing_tables):
    results = []
    for table_name, existing_df in existing_tables.items():
        best_match = None
        best_overlap = 0.0
      
        for new_col in new_df.columns:
            for exist_col in existing_df.columns:
                overlap = compute_value_overlap(new_df[new_col], existing_df[exist_col])
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_match = (new_col, exist_col, overlap)
      
        if best_match:
            new_col, exist_col, overlap = best_match
            if overlap >= 0.90 and new_col == exist_col:
                join_type = "exact"
            elif overlap >= 0.60:
                join_type = "candidate"
            else:
                join_type = "none"
          
            results.append(JoinResult(
                target_table=table_name, type=join_type,
                key=f"{new_col} ↔ {exist_col}", overlap=overlap
            ))
    return results


def compute_value_overlap(series_a, series_b):
    set_a = set(series_a.dropna().unique())
    set_b = set(series_b.dropna().unique())
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    smaller_set = min(len(set_a), len(set_b))
    return len(intersection) / smaller_set


def check_connectivity(active_set, join_graph):
    if len(active_set) <= 1:
        return active_set, set()
    start = next(iter(active_set))
    visited = {start}
    queue = [start]
    while queue:
        node = queue.pop(0)
        for neighbor in join_graph.get(node, []):
            if neighbor in active_set and neighbor not in visited:
                visited.add(neighbor)
                queue.append(neighbor)
    orphans = active_set - visited
    return visited, orphans
```

| 条件                      | 判定          | 前端行为           |
| ------------------------- | ------------- | ------------------ |
| overlap ≥ 90% 且列名相同 | `exact`     | 直接允许开启       |
| overlap ≥ 60%            | `candidate` | 弹确认面板         |
| overlap < 60%             | `none`      | 拒绝，提示开新项目 |

---

## 9. 策略版本化与数据重建

用户更新清洗策略后，DuckDB 表需要从原始文件重建：

```python
async def update_strategy(engine, project_id, dataset_id, new_decisions):
    raw_df = load_raw_dataframe(project_id, dataset_id)
    cleaned_df, excluded = apply_decisions(raw_df, inferences, new_decisions)
    table_info = register_table(engine, project_id, dataset_name, cleaned_df, excluded)
    new_version = increment_strategy_version(project_id)
    return table_info, new_version
```

原始文件保留策略：

```
data/uploads/proj_abc123/
├── sales_2024.csv          # 原始上传（重建数据源）
└── products.csv

data/processed/
├── proj_abc123.duckdb      # 清洗后的表（可从原始文件重建）
```

---

## 10. 文件映射

```
backend/db/
├── engine.py       # DuckDB 连接管理、表注册、持久化
├── loader.py       # parse + infer_types + scan_quality + apply_decisions + detect_join_keys
└── sandbox.py      # SQL 执行沙箱
```

---

## 11. 关键实现备注

**为什么初始读取所有列都是字符串（dtype=str）？**
如果让 pandas 自动推断类型，它会把 "01/03/2024" 静默解析为 January 3rd（美式），用户可能意图是 March 1st（欧式）。全部读为字符串后，由我们自己的推断逻辑控制转换，歧义处才弹出让用户选择。

**为什么每个项目一个独立的 DuckDB 文件？**
项目隔离——一个项目的表不会泄漏到另一个项目。删除项目时直接删文件，不需要在共享数据库里 DROP TABLE。连接管理也更简单——每个项目独立连接，不存在多项目并发写入同一个文件的锁竞争。

**为什么质量扫描用固定规则而不是 LLM？**
null 率计算、z-score 离群值检测、正则匹配日期格式——这些都是确定性操作，LLM 做不了更好，反而更慢更贵更不可预测。真正需要 LLM 判断力的场景（"这个 WARNING 列是否影响当前问题"）已经由 Planner Agent 处理。

**为什么保留原始上传文件？**
策略版本化要求用户可以随时修改清洗决策并重建 DuckDB 表。如果只保留清洗后的 DuckDB 文件，策略更新时就无法从头重新执行 apply_decisions()。原始文件是重建的唯一数据源。
