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
│  1. parse_file()    → 读取文件，统一为 DataFrame  │
│  2. infer_types()   → 逐列类型推断                │
│  3. scan_quality()  → 数据质量扫描，分级标记       │
│  4. apply_decisions() → 执行用户决策，注册 DuckDB  │
│                                                   │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  engine.py                                        │
│                                                   │
│  DuckDB 连接管理 + 文件持久化                      │
│                                                   │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  sandbox.py                                       │
│                                                   │
│  SQL 执行沙箱：关键词过滤、fetchall 完整结果      │
│                                                   │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  versioning.py                                    │
│                                                   │
│  数据集版本化：单元格编辑、Parquet 快照、恢复      │
│                                                   │
└──────────────────────────────────────────────────┘
```

---

## 2. 文件解析（parse_file）

**文件**：`backend/db/loader.py` → `parse_file()`

### 2.1 支持格式

| 格式  | 扩展名                  | 解析方式                |
| ----- | ----------------------- | ----------------------- |
| CSV   | `.csv`                | `pandas.read_csv()`   |
| TSV   | `.tsv`, `.txt`        | `pandas.read_csv(sep='\t')` |
| Excel | `.xlsx`, `.xls`       | `pandas.read_excel()`（openpyxl / xlrd） |

### 2.2 解析规则

```python
def parse_file(filepath: str) -> pd.DataFrame:
    """读取文件，统一为 DataFrame。所有列初始读取为字符串。"""

    ext = Path(filepath).suffix.lower()

    if ext == '.csv':
        df = pd.read_csv(filepath, dtype=str, keep_default_na=False)
    elif ext in ('.tsv', '.txt'):
        df = pd.read_csv(filepath, sep='\t', dtype=str, keep_default_na=False)
    elif ext in ('.xlsx', '.xls'):
        df = pd.read_excel(filepath, dtype=str, keep_default_na=False)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    # 列名清洗：strip + lower + 空格/横杠 → 下划线
    df.columns = [col.strip().lower().replace(' ', '_').replace('-', '_') for col in df.columns]

    # 去全空行
    df = df.replace('', pd.NA).dropna(how='all').fillna('')
    df = df.reset_index(drop=True)

    return df
```

注：不使用 `csv.Sniffer` 或 `chardet`，直接依赖 `pd.read_csv()` 默认行为。

---

## 3. 类型推断（infer_types）

**文件**：`backend/db/loader.py` → `infer_types()`

对每一列进行类型推断，返回三种决策之一：

```python
# ColumnInference.decision 字段值
"auto"        # 高置信度，无歧义，自动转换
"ask_user"    # 有歧义，需要用户选择 → BLOCKING issue
"keep_string" # 无法识别，保持 VARCHAR
```

### 3.1 推断流程

推断顺序：`boolean → integer → year_like_integer → float → date`

```python
def infer_types(df: pd.DataFrame) -> list[ColumnInference]:
    results = []
    for col in df.columns:
        series = df[col].dropna()
        result = (
            _try_boolean(series) or
            _try_integer(series) or
            _try_year_like_integer(series) or
            _try_float(series) or
            _try_date(series) or
            ColumnInference(col, original_type="VARCHAR", inferred_type=None, ...)
        )
        results.append(result)
    return results
```

### 3.2 各类型推断规则

#### Boolean

```python
TRUE_VALUES  = {'true', 'yes', 'y', '1', 'on', 'active'}
FALSE_VALUES = {'false', 'no', 'n', '0', 'off', 'inactive'}

def _try_boolean(series) -> ColumnInference | None:
    unique = set(cleaned.unique())
    if unique.issubset(TRUE_VALUES | FALSE_VALUES) and len(values) >= 2:
        return ColumnInference(inferred_type="BOOLEAN", decision="auto", ...)
```

#### Integer / Year-like Integer

```python
def _try_integer(series) -> ColumnInference | None:
    # 检测 match_rate >= 0.95 → decision="auto"

def _try_year_like_integer(series) -> ColumnInference | None:
    # 检测形如 2020.0 的年份值 → decision="auto", inferred_type="INTEGER"
```

#### Float / Double

```python
STRIP_PATTERNS = [...]  # 移除货币符号 $¥€£₹ 和 % 后缀

def _try_float(series) -> ColumnInference | None:
    # 先用 STRIP_PATTERNS 清洗，再检测数值格式
    # match_rate >= 0.95 → decision="auto"
    # match_rate >= 0.60 → decision="ask_user"（生成选项）
```

#### Date

```python
DATE_PATTERNS = [
    (regex, fmt, label),   # 注意：(regex, format, label) 顺序
    ...
]

def _try_date(series) -> ColumnInference | None:
    # 检测匹配率，区分 ambiguous 和 unambiguous 格式
    # total_match >= 0.95 and not ambiguous → decision="auto"
    # total_match >= 0.60 → decision="ask_user"
```

### 3.3 推断结果数据结构

```python
@dataclass
class ColumnInference:
    column: str
    original_type: str
    inferred_type: str | None       # INTEGER, DOUBLE, DATE, BOOLEAN, None
    confidence: float
    format_consistent: bool
    decision: str                   # "auto" | "ask_user" | "keep_string"
    auto_note: str = ""

    conflicting_samples: list[str] | None = None
    options: list[ConversionOption] | None = None
    null_count: int = 0
    null_pct: float = 0.0
    sample_values: list[str] | None = None
```

---

## 4. 数据质量扫描（scan_quality）

**文件**：`backend/db/loader.py` → `scan_quality()`

### 4.1 函数签名

```python
def scan_quality(
    df: pd.DataFrame,
    inferences: list[ColumnInference],
    analysis_mode: str = "simple"
) -> list[QualityIssue]:
```

`analysis_mode` 影响 `must_solve` 的阈值判定。

### 4.2 质量问题结构

```python
@dataclass
class QualityIssue:
    column: str
    col_type: str
    issue_type: str        # missing | outlier | categorical | unit_mismatch | percent_scale | currency_symbol
    severity: str          # "warning" | "info"（字符串，非 Enum）
    description: str
    options: list[ConversionOption] | None
    must_solve: bool
```

注：`severity` 是普通字符串而非 Enum。类型歧义（`decision="ask_user"`）独立由 `ColumnInference` 处理，不在 `scan_quality` 中产生 blocking 级别的 issue。

### 4.3 扫描规则

| 检测类型 | 条件 | severity | must_solve 判定 |
| -------- | ---- | -------- | --------------- |
| 缺失率 | > 阈值（advanced 5%, simple 50%） | warning | 超阈值 = true |
| 离群值（>3σ） | 占比 >= 8% | warning | true |
| 混合单位 | 同列含多种单位（distance/area/weight/temperature） | warning | 视情况 |
| 百分比尺度 | 同列混合 0-1 与 0-100 | warning | 视情况 |
| 混合货币符号 | 同列含多种货币符号 | warning | 视情况 |
| 疑似分类 | 2 ≤ unique ≤ 20 且 rows > 100 | info | false |

Outlier 检测提供选项：`keep` / `winsorize` / `clip_iqr` / `drop_row`。

---

## 5. 用户决策执行（apply_decisions）

**文件**：`backend/db/loader.py` → `apply_decisions()`

### 5.1 函数签名

```python
def apply_decisions(
    df: pd.DataFrame,
    inferences: list[ColumnInference],
    quality_issues: list[QualityIssue],
    decisions: dict[str, str],
    dataset_name: str,
    conn: duckdb.DuckDBPyConnection
) -> TableRegistration:
```

返回 `TableRegistration` 数据类（非 tuple），包含 `name`, `columns`, `excluded_columns`, `row_count`, `dtypes`。

### 5.2 执行逻辑

```python
# 1. 对 auto 决策的列执行自动转换
#    _convert_auto(df, inference)
#    - DOUBLE 转换前先用 STRIP_PATTERNS 移除货币/百分号
#    - DATE 转换使用 format='mixed'

# 2. 对 ask_user 决策的列按用户选择转换
#    _convert_with_decision(df, inference, option)
#    - option == "exclude" → 排除列

# 3. 处理质量决策（6 种 issue_type）
#    - missing: keep/mean/median/drop_row
#    - outlier: keep/winsorize/clip_iqr/drop_row
#    - unit_mismatch / percent_scale / currency_symbol: 各自处理选项

# 4. 注册 DuckDB 表
#    conn.execute("DROP TABLE IF EXISTS ...")
#    conn.execute("CREATE TABLE ... AS SELECT * FROM df")
```

### 5.3 表名清洗

```python
def sanitize_table_name(filename: str) -> str:
    # 取文件名 stem → 移除特殊字符 → lower
    # SQL 关键字冲突时加 t_ 前缀
```

注：对 SQL 关键字加前缀，而非对数字开头加前缀。

---

## 6. DuckDB 引擎（engine.py）

**文件**：`backend/db/engine.py`

### 6.1 连接管理

```python
class DuckDBEngine:
    """每个项目一个独立的 .duckdb 文件。"""

    def __init__(self):
        # 从 settings.DUCKDB_DATA_DIR 读取数据目录
        self._connections: dict[str, duckdb.DuckDBPyConnection] = {}

    def get_connection(self, project_id: str) -> duckdb.DuckDBPyConnection:
        """获取读写连接。"""

    def get_readonly(self, project_id: str) -> duckdb.DuckDBPyConnection:
        """获取只读连接（SQL Agent sandbox 使用）。"""

    def close(self, project_id: str): ...
    def close_all(self): ...
    def list_tables(self, project_id: str) -> list[str]: ...
```

模块级单例：`engine = DuckDBEngine()`

### 6.2 数据持久化

```
data/processed/
├── proj_abc123.duckdb      # 项目 A 的所有表
├── proj_def456.duckdb      # 项目 B 的所有表
```

---

## 7. SQL 执行沙箱（sandbox.py）

**文件**：`backend/db/sandbox.py`

```python
FORBIDDEN_PATTERNS = [
    # DDL: DROP, ALTER, CREATE, INSERT, UPDATE, DELETE, TRUNCATE
    # 数据操作: COPY, EXPORT, IMPORT, ATTACH, DETACH
    # 其他: PRAGMA
]

def execute_sandboxed(conn, sql: str) -> dict:
    """
    同步执行 SQL，返回 dict。
    1. 剥离 markdown fences
    2. 正则检查 FORBIDDEN_PATTERNS
    3. conn.execute(sql)
    4. fetchall() 返回完整结果集
    5. 返回 {columns, rows, row_count, execution_ms, sql, error}
    """
```

注：不限制返回行数（原 `MAX_RESULT_ROWS` 限制已移除，使用 `fetchall()`）。前端通过 Overview/Detail 双模式（聚合 vs 原始数据）处理大数据集的渲染性能。不修改原始 SQL（不自动包裹 LIMIT）。不校验 SELECT/WITH 开头。无超时控制。

---

## 8. 数据集版本化（versioning.py）

**文件**：`backend/db/versioning.py`

完整的数据集内容版本化机制（单元格编辑 → Parquet 快照 → 恢复）。

### 8.1 核心函数

```python
def apply_cell_edit(conn, table_name, project_id, dataset_id, row_index, column, new_value, old_value=None):
    """直接更新 DuckDB 表 + 追加到 pending 缓冲。"""

def create_snapshot(conn, table_name, project_id, dataset_id) -> dict:
    """将当前表导出为 Parquet 文件，记录到 versions.json。"""

def restore_version(conn, project_id, dataset_id, version_id) -> dict:
    """从 Parquet 恢复表到指定版本。"""

def restore_current_version(conn, project_id, dataset_id, table_name) -> str | None:
    """项目加载时自动恢复当前版本。"""

def query_preview(conn, table_name, offset, limit, sort_col, sort_dir) -> dict:
    """分页 + 排序查询预览。"""

def export_csv(conn, table_name, project_id, dataset_id) -> Path:
    """导出为 CSV 文件。"""

def get_versions(project_id, dataset_id) -> list[dict]:
    """获取版本列表。"""
```

### 8.2 存储结构

```
data/versions/{project_id}/{dataset_id}/
├── versions.json           # 版本元数据
├── v1711764400.parquet     # 版本快照
├── v1711764500.parquet
```

---

## 9. 文件映射

```
backend/db/
├── engine.py       # DuckDB 连接管理（单例）、读写/只读连接、持久化
├── loader.py       # parse_file + infer_types + scan_quality + apply_decisions
├── sandbox.py      # SQL 执行沙箱（关键词过滤，fetchall 无行数限制）
└── versioning.py   # 数据集版本化（编辑、快照、恢复、预览、导出）
```

---

## 10. 关键实现备注

**为什么初始读取所有列都是字符串（dtype=str）？**
如果让 pandas 自动推断类型，它会把 "01/03/2024" 静默解析为 January 3rd（美式），用户可能意图是 March 1st（欧式）。全部读为字符串后，由我们自己的推断逻辑控制转换，歧义处才弹出让用户选择。

**为什么每个项目一个独立的 DuckDB 文件？**
项目隔离——一个项目的表不会泄漏到另一个项目。删除项目时直接删文件。连接管理也更简单。

**为什么质量扫描用固定规则而不是 LLM？**
null 率计算、z-score 离群值检测、正则匹配日期格式——这些都是确定性操作，LLM 做不了更好。

**为什么保留原始上传文件？**
策略版本化要求用户可以随时修改清洗决策并重建 DuckDB 表。原始文件是重建的唯一数据源。

**为什么 apply_decisions 直接注册 DuckDB 表？**
当前实现中 `apply_decisions()` 包含完整的 DuckDB 表注册逻辑（DROP IF EXISTS + CREATE TABLE AS SELECT），不通过单独的 `register_table()` 函数。
