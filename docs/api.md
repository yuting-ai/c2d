# c2d — API Reference

本文档定义前后端之间的完整 HTTP + SSE 接口契约。前端 `useAnalysisStream` hook 和后端 `backend/api/routes.py` 均以此为准。

所有路由前缀：`/api`

---

## 0. 近期接口变更（截至 2026-03-26）

### 0.1 上传接口

- `POST /api/projects/{project_id}/datasets` 新增 multipart 字段：
  - `analysis_mode`: `simple | advanced`
- 后端据此执行模式化质量扫描阈值（advanced 更严格）。

### 0.2 warning_issues 返回结构

`warning_issues[]` 新增/统一字段：

- `key`: `column:issue_type`
- `issue_type`: `missing | outlier | categorical | unit_mismatch | percent_scale | currency_symbol`
- `severity`: `warning | info`
- `must_solve`: `boolean`

### 0.3 确认校验行为

- `POST /api/projects/{project_id}/confirm` 现同时校验：
  - blocking issue 是否全部有决策
  - must-solve warning 是否全部有决策
- 新增错误码：`MUST_SOLVE_WARNING_UNRESOLVED`

### 0.4 决策写入兼容

- warning 决策以 `issue_key` 为主键保存（兼容列级回退）。
- 空值决策会清除后端存储，避免"已解决但无有效值"的假阳性。

### 0.5 数据集版本化

- 新增数据集内容版本化系统（单元格编辑 → 快照 → 恢复）。
- 新增 preview / cell edit / snapshot / versions / restore / export 端点。

### 0.6 分析流水线与查询语言（2026-03-28）

- **`GET /api/analyze/stream`**（见 §6）在 `run_analysis_stream` 内对 `query` 做 **单次** 语言检测：`backend/graph/language.py` → `detect_language`（可选依赖 **`langdetect`**，见 `pyproject.toml` / `environment.yml`）。
- 检测结果写入 pipeline 初始 **`user_lang`**（BCP-47，如 `zh-cn`、`en`），服务端日志 **`user_lang=...`**；**不单独作为 SSE 事件字段**下发，但影响各 agent 生成文本语言。
- 含中英混合问句时，对 **汉字子串** 再检测，减轻误判。

---

## 1. 约定

### Base URL

```
开发环境：http://localhost:8000/api
生产环境：由 VITE_API_BASE_URL 配置
```

### 请求格式

* `Content-Type: application/json`（JSON body）
* `Content-Type: multipart/form-data`（文件上传）
* Query parameters 用于 GET 和 SSE 端点

### 响应格式

成功响应统一使用：

```json
{
  "ok": true,
  "data": { ... }
}
```

错误响应通过 `HTTPException(detail=...)` 抛出：

```json
{
  "detail": {
    "ok": false,
    "error": {
      "code": "DATASET_NOT_FOUND",
      "message": "Dataset ds_abc123 does not exist"
    }
  }
}
```

### 错误码

| HTTP Status | code                     | 场景                                    |
| ----------- | ------------------------ | --------------------------------------- |
| 400         | `VALIDATION_ERROR`     | 参数校验失败                            |
| 400         | `BLOCKING_UNRESOLVED`  | 有未解决的 blocking issue，不能开始分析 |
| 400         | `MUST_SOLVE_WARNING_UNRESOLVED` | must-solve warning 未处理     |
| 404         | `PROJECT_NOT_FOUND`    | 项目不存在                              |
| 404         | `DATASET_NOT_FOUND`    | 数据集不存在                            |
| 500         | `PIPELINE_ERROR`       | Agent pipeline 执行异常                 |
| 500         | `INTERNAL_ERROR`       | 未知错误                                |

---

## 2. Datasets

### `POST /api/projects/{project_id}/datasets`

上传数据文件到项目。触发类型推断和数据质量扫描。

**Request:**

```
Content-Type: multipart/form-data

file: (binary)       # CSV, Excel, TSV, TXT
analysis_mode: simple | advanced  (可选)
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "dataset_id": "ds_001",
    "name": "sales_2024.csv",
    "row_count": 12430,
    "column_count": 8,
    "size_bytes": 2202624,
    "columns": [
      {
        "name": "sale_date",
        "original_type": "VARCHAR",
        "inferred_type": "DATE",
        "null_pct": 0.0,
        "sample_values": ["2024-01-03", "2024-01-07"]
      }
    ],
    "blocking_issues": [
      {
        "key": "order_date",
        "column": "order_date",
        "original_type": "VARCHAR",
        "inferred_type": "DATE",
        "description": "mixed date formats — month/day order ambiguous",
        "samples": ["2024-01-03", "01/03/2024", "20240103"],
        "options": [
          { "value": "iso", "label": "ISO: YYYY-MM-DD (recommended)" },
          { "value": "us", "label": "US: MM/DD/YYYY" },
          { "value": "exclude", "label": "exclude this column" }
        ]
      }
    ],
    "warning_issues": [
      {
        "key": "notes:missing",
        "column": "notes",
        "col_type": "VARCHAR",
        "issue_type": "missing",
        "severity": "warning",
        "must_solve": false,
        "description": "67% missing",
        "options": [
          { "value": "keep", "label": "keep as-is" },
          { "value": "drop_row", "label": "drop rows with missing" }
        ]
      }
    ],
    "auto_converted": [
      {
        "column": "sale_date",
        "from_type": "VARCHAR",
        "to_type": "DATE",
        "note": "100% ISO format"
      }
    ]
  }
}
```

### `PUT /api/projects/{project_id}/datasets/{dataset_id}/decisions`

提交数据清洗决策。decisions 的值为纯字符串（选项 value），key 为列名或 `column:issue_type`。

**Request:**

```json
{
  "decisions": {
    "order_date": "iso",
    "amount:outlier": "winsorize"
  }
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "resolved_count": 2,
    "unresolved_count": 0,
    "all_resolved": true
  }
}
```

### `POST /api/projects/{project_id}/confirm`

确认数据清洗决策，执行 `apply_decisions()`，注册 DuckDB 表。首次确认 `strategy_version` 从 0 → 1，后续每次更新递增。

**Request:**

```json
{}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "strategy_version": 1,
    "is_update": false,
    "active_tables": [
      {
        "name": "sales_2024",
        "columns": ["sale_date", "region", "revenue", "order_count", "channel", "cost"],
        "excluded_columns": ["salesperson_id"],
        "row_count": 12430
      }
    ]
  }
}
```

---

## 3. Analysis (SSE)

### `GET /api/analyze/stream`

核心端点。建立 SSE 连接，执行 LangGraph pipeline，流式推送进度和结果。

**Query Parameters:**

| 参数           | 类型   | 必填 | 说明             |
| -------------- | ------ | ---- | ---------------- |
| `project_id` | string | ✅   | 分析项目 ID      |
| `query`      | string | ✅   | 用户自然语言问题 |

**Response:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

每个事件格式：

```
event: {event_type}
data: {json_payload}

```

事件类型详见下方 Section 5。

---

## 4. Schema Info

### `GET /api/projects/{project_id}/schema`

获取项目当前所有数据集的 schema 信息。

**Response:**

```json
{
  "ok": true,
  "data": {
    "datasets": [
      {
        "id": "ds_001",
        "name": "sales_2024.csv",
        "confirmed": true,
        "row_count": 12430,
        "column_count": 8,
        "columns": [
          {
            "name": "sale_date",
            "original_type": "VARCHAR",
            "inferred_type": "DATE",
            "null_pct": 0.0,
            "sample_values": ["2024-01-03", "2024-01-07"]
          }
        ]
      }
    ],
    "strategy_version": 1,
    "system_mode": "chat",
    "active_tables": [
      {
        "name": "sales_2024",
        "columns": ["sale_date", "region", "revenue"],
        "excluded_columns": [],
        "row_count": 12430
      }
    ]
  }
}
```

#### 行为补充（重启恢复）

- 当 `project_id` 当前不在后端内存态时，服务端会尝试从 `data/processed/{project_id}.duckdb` 自动 bootstrap 项目。
- bootstrap 成功后，仍返回同一份 schema 响应结构，前端不需要额外分支。

### `GET /api/debug/projects`

仅用于本地调试/测试。返回当前机器上可恢复的 DuckDB 项目列表。

**Response:**

```json
{
  "ok": true,
  "data": {
    "projects": [
      {
        "project_id": "proj_8emmf4bk",
        "title": "proj_8emmf4bk",
        "dataset_names": ["sales.duckdb", "products.duckdb"],
        "dataset_count": 2,
        "strategy_version": 1,
        "updated_at": 1711764400
      }
    ]
  }
}
```

---

## 5. SSE Event Reference

所有 SSE 事件的 `data` 字段均为 JSON。

### `progress`

Agent pipeline 节点状态更新。由各 agent 放入 `stream_events`。

```json
{
  "steps": [
    { "agent": "analyst", "label": "querying data · step 1", "status": "active" },
    { "agent": "analyst", "label": "planning analysis", "status": "done" }
  ]
}
```

前端映射 → `chatStore.updateTrace(projectId, sessionId, exchangeId, steps)`

### `result`

某个 worker agent 产出了中间结果。由各 agent 放入 `stream_events`。

#### `result` (type: sql)

```json
{
  "type": "sql",
  "steps": [
    {
      "title": "query · step 1 of 1",
      "sql": "SELECT channel, SUM(revenue) FROM sales_2024 GROUP BY channel",
      "tag": "SQL Agent"
    }
  ]
}
```

前端映射 → `chatStore.addSqlSteps()` 更新 chat 展示（不写 resultsStore）。

### `done`

Pipeline 完整执行完毕，由 `sse.py` 统一构建。

```json
{
  "report": {
    "conclusion": "Markdown string (prose/lists/bold; full data grid is Chart panel Table — see frontend.md §0.9)",
    "should_record": true,
    "strategy_version": 1,
    "evidence": null
  },
  "dataset_versions": {
    "ds_001": "v1711764400"
  },
  "sql_result": {
    "columns": ["channel", "total_revenue"],
    "rows": [["online", 89200], ["offline", 62400]],
    "steps": [{ "title": "...", "sql": "...", "tag": "SQL Agent" }]
  },
  "viz_result": {
    "type": "bar",
    "alt_types": ["pie"],
    "title": "Revenue by Channel",
    "x_label": "Channel",
    "y_label": "Revenue",
    "series": [{ "name": "Revenue", "x": ["online", "offline"], "y": [89200, 62400] }],
    "table_data": { "headers": [...], "rows": [...] }
  },
  "stats_result": null
}
```

前端映射：
- `chatStore.setReply()` + `setStatus('done')`
- `resultsStore.finalizeChartRecord()` 或 `removeChartRecord()`
- `resultsStore.addSqlRecord()`
- `resultsStore.addReportRecord()`（if `should_record`）

### `error`

Pipeline 执行过程中的异常。

```json
{
  "code": "PIPELINE_ERROR",
  "message": "SQL Agent failed: column 'reveneu' not found"
}
```

前端映射 → `chatStore.setError()` → 显示错误信息，移除 chart 占位。

---

## 6. Dataset Versioning

### `GET /api/projects/{project_id}/datasets/{dataset_id}/preview`

分页预览数据集内容。

**Query Parameters:**

| 参数         | 类型   | 必填 | 说明                           |
| ------------ | ------ | ---- | ------------------------------ |
| `offset`   | int    | ❌   | 起始行（默认 0）               |
| `limit`    | int    | ❌   | 返回行数（默认 100）           |
| `sort_col` | string | ❌   | 排序列                         |
| `sort_dir` | string | ❌   | 排序方向（`asc` / `desc`）   |

### `PATCH /api/projects/{project_id}/datasets/{dataset_id}/cells`

编辑单个单元格。

**Request:**

```json
{
  "row_index": 42,
  "column": "revenue",
  "value": "12800.00"
}
```

### `POST /api/projects/{project_id}/datasets/{dataset_id}/versions/snapshot`

创建版本快照（将当前表状态保存为 Parquet）。

### `GET /api/projects/{project_id}/datasets/{dataset_id}/versions`

获取版本列表。

### `POST /api/projects/{project_id}/datasets/{dataset_id}/versions/{version_id}/restore`

恢复到指定版本。

### `GET /api/projects/{project_id}/datasets/{dataset_id}/export`

导出数据集为 CSV。

---

## 7. LLM Management

### `GET /api/llm/status`

获取当前 LLM provider 状态。

### `PUT /api/llm/provider`

运行时切换 LLM provider（deepseek / ollama / anthropic），无需重启。

**Query Parameters:**

| 参数       | 类型   | 必填 | 说明                              |
| ---------- | ------ | ---- | --------------------------------- |
| `provider` | string | ✅   | `deepseek` / `ollama` / `anthropic` |
| `model`    | string | ❌   | 模型名称（如 `qwen3:8b`）        |

### `GET /api/health`

健康检查端点。

### `GET /api/test-llm`

LLM 连接测试。

---

## 8. 路由总览

### 已实现的路由

```
方法    路径                                                                说明
──────────────────────────────────────────────────────────────────────────────────────
POST    /api/projects/{project_id}/datasets                                  上传数据集
PUT     /api/projects/{project_id}/datasets/{dataset_id}/decisions           提交清洗决策
POST    /api/projects/{project_id}/confirm                                   确认/更新策略

GET     /api/analyze/stream                                                  分析（SSE）

GET     /api/projects/{project_id}/schema                                    Schema 信息
GET     /api/debug/projects                                                  调试：可恢复项目

GET     /api/projects/{pid}/datasets/{did}/preview                           数据预览（分页）
PATCH   /api/projects/{pid}/datasets/{did}/cells                             单元格编辑
POST    /api/projects/{pid}/datasets/{did}/versions/snapshot                  创建版本快照
GET     /api/projects/{pid}/datasets/{did}/versions                          版本列表
POST    /api/projects/{pid}/datasets/{did}/versions/{vid}/restore            恢复版本
GET     /api/projects/{pid}/datasets/{did}/export                            CSV 导出

GET     /api/health                                                          健康检查
GET     /api/test-llm                                                        LLM 连接测试
GET     /api/llm/status                                                      LLM 状态
PUT     /api/llm/provider                                                    切换 LLM provider
```

### 计划中但尚未实现的路由

```
GET     /api/projects                                                        项目列表
POST    /api/projects                                                        创建项目
PATCH   /api/projects/{project_id}/star                                      项目收藏
DELETE  /api/projects/{project_id}                                           删除项目

GET     /api/projects/{project_id}/records                                   记录列表
PATCH   /api/projects/{pid}/records/{rid}/star                               记录收藏
GET     /api/projects/{pid}/records/{rid}/export                             单记录导出
GET     /api/projects/{project_id}/export                                    全项目导出

GET     /api/projects/{project_id}/exchanges                                 对话记录
```

---

## 9. 后端文件映射

```
backend/api/
├── main.py         # FastAPI app 实例、中间件、startup/shutdown
├── routes.py       # 所有路由注册
├── schemas.py      # Pydantic 模型
└── sse.py          # SSE 事件推送（run_analysis_stream 异步生成器）
```

`schemas.py` 包含以下模型：

```
Request 模型：
  SubmitDecisionsRequest    # decisions: dict[str, str]

Response 模型：
  ApiResponse               # {"ok": true, "data": T}
  ApiError                   # {"ok": false, "error": {...}}
  ConversionOptionSchema     # {value, label}
  ColumnSchema               # {name, original_type, inferred_type, null_pct, sample_values}
  BlockingIssueSchema        # {key, column, original_type, inferred_type, description, samples, options}
  WarningIssueSchema         # {key, column, col_type, issue_type, severity, must_solve, description, options}
  AutoConvertedSchema        # {column, from_type, to_type, note}
  DatasetUploadResponse      # 上传响应（dataset_id + columns + issues）
  DecisionResponse           # {resolved_count, unresolved_count, all_resolved}
  ActiveTableSchema          # {name, columns, excluded_columns, row_count}
  ConfirmResponse            # {strategy_version, is_update, active_tables}
```

`routes.py` 中 `CellEditRequest` 内联定义（BaseModel: row_index, column, value）。
