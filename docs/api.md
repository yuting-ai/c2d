# c2d — API Reference

本文档定义前后端之间的完整 HTTP + SSE 接口契约。前端 `useAnalysisStream` hook 和后端 `backend/api/routes.py` 均以此为准。

所有路由前缀：`/api`

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

所有响应统一使用 JSON：

```json
{
  "ok": true,
  "data": { ... }
}
```

错误响应：

```json
{
  "ok": false,
  "error": {
    "code": "DATASET_NOT_FOUND",
    "message": "Dataset ds_abc123 does not exist"
  }
}
```

### 错误码

| HTTP Status | code                     | 场景                                    |
| ----------- | ------------------------ | --------------------------------------- |
| 400         | `VALIDATION_ERROR`     | 参数校验失败                            |
| 400         | `BLOCKING_UNRESOLVED`  | 有未解决的 blocking issue，不能开始分析 |
| 400         | `NO_JOIN_KEY`          | 新数据集与 active 数据集无法 join       |
| 404         | `PROJECT_NOT_FOUND`    | 项目不存在                              |
| 404         | `DATASET_NOT_FOUND`    | 数据集不存在                            |
| 409         | `DATASET_DISCONNECTED` | 关闭数据集导致连通性断裂                |
| 500         | `PIPELINE_ERROR`       | Agent pipeline 执行异常                 |
| 500         | `INTERNAL_ERROR`       | 未知错误                                |

---

## 2. Projects

### `GET /api/projects`

获取当前用户的所有分析项目列表。

**Response:**

```json
{
  "ok": true,
  "data": {
    "projects": [
      {
        "id": "proj_abc123",
        "title": "Monthly revenue trend by region",
        "dataset_names": ["sales_2024.csv", "products.csv"],
        "created_at": "2024-03-21T14:05:00Z",
        "updated_at": "2024-03-21T14:45:00Z",
        "starred": false,
        "record_count": 3,
        "strategy_version": 1
      }
    ]
  }
}
```

### `POST /api/projects`

创建新分析项目。

**Request:**

```json
{
  "title": "New Analysis"
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "id": "proj_def456",
    "title": "New Analysis",
    "dataset_names": [],
    "created_at": "2024-03-21T15:00:00Z",
    "updated_at": "2024-03-21T15:00:00Z",
    "starred": false,
    "record_count": 0,
    "strategy_version": 0
  }
}
```

### `PATCH /api/projects/{project_id}/star`

切换项目收藏状态。

**Response:**

```json
{
  "ok": true,
  "data": { "starred": true }
}
```

### `DELETE /api/projects/{project_id}`

删除项目及关联的所有数据（DuckDB 文件、记录、记忆）。

**Response:**

```json
{
  "ok": true,
  "data": null
}
```

---

## 3. Datasets

### `POST /api/projects/{project_id}/datasets`

上传数据文件到项目。触发类型推断和数据质量扫描。

**Request:**

```
Content-Type: multipart/form-data

file: (binary)       # CSV, Excel, TSV
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
        "key": "0-0",
        "column": "order_date",
        "original_type": "VARCHAR",
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
        "column": "notes",
        "type": "VARCHAR",
        "description": "67% missing"
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

### `PATCH /api/projects/{project_id}/datasets/{dataset_id}/toggle`

开关数据集。开启时校验 join graph 连通性。

**Request:**

```json
{
  "active": true
}
```

**Response（成功）:**

```json
{
  "ok": true,
  "data": {
    "dataset_id": "ds_001",
    "active": true,
    "join_result": {
      "type": "exact",
      "key": "product_id ↔ id",
      "overlap": 0.94
    }
  }
}
```

**Response（join 失败）:**

```json
{
  "ok": false,
  "error": {
    "code": "NO_JOIN_KEY",
    "message": "No join key found between ds_002 and active datasets"
  }
}
```

**Response（关闭时级联）:**

```json
{
  "ok": true,
  "data": {
    "dataset_id": "ds_001",
    "active": false,
    "cascaded": ["ds_003"],
    "message": "Closing ds_001 also deactivated ds_003 (no longer connected)"
  }
}
```

### `PUT /api/projects/{project_id}/datasets/{dataset_id}/decisions`

提交数据清洗决策。可以在首次确认前逐条提交，也可以修改已有决策。

**Request:**

```json
{
  "decisions": {
    "0-0": { "option": "iso" },
    "0-1": { "option": "null" }
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

**Response（首次确认）:**

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

**Response（策略更新）:**

```json
{
  "ok": true,
  "data": {
    "strategy_version": 2,
    "is_update": true,
    "affected_records": [1, 2, 3],
    "active_tables": [ ... ]
  }
}
```

---

## 4. Analysis (SSE)

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

事件类型详见下方 Section 6。

**错误情况：**

如果项目不存在或有未解决的 blocking issue，直接返回 HTTP 错误（非 SSE）：

```json
HTTP 400
{
  "ok": false,
  "error": {
    "code": "BLOCKING_UNRESOLVED",
    "message": "Dataset sales_2024.csv has 2 unresolved blocking issues"
  }
}
```

---

## 5. Records

### `GET /api/projects/{project_id}/records`

获取项目的所有分析记录（Report Tab 内容）。

**Query Parameters:**

| 参数                 | 类型 | 必填 | 说明           |
| -------------------- | ---- | ---- | -------------- |
| `strategy_version` | int  | ❌   | 按策略版本过滤 |

**Response:**

```json
{
  "ok": true,
  "data": {
    "records": [
      {
        "id": 1,
        "query": "Monthly revenue trend by region over the past 12 months",
        "time": "14:32",
        "conclusion": "East region grew the fastest, up +34.2% over 12 months...",
        "critic_note": "East uptrend statistically significant (p < 0.01)...",
        "chart_svg": "<svg>...</svg>",
        "chart_config": {
          "default_type": "line",
          "alt_types": ["line", "area", "bar", "table"],
          "configs": {
            "line": { ... },
            "area": { ... },
            "bar": { ... }
          },
          "table_data": {
            "headers": ["month", "East", "North", "SW"],
            "rows": [["Jan", 124800, 208400, 218000], ...]
          }
        },
        "sql_steps": [
          {
            "title": "query · step 1 of 2",
            "sql": "SELECT region, DATE_TRUNC('month', sale_date) AS month...",
            "tag": "SQL Agent"
          }
        ],
        "evidence": {
          "tests": [
            { "key": "East trend significance", "value": "p < 0.01" },
            { "key": "trend r² (linear fit)", "value": "0.91" },
            { "key": "95% CI (MoM growth)", "value": "±2.1%" }
          ],
          "anomalies": [
            { "icon": "△", "text": "East Jul ¥680k exceeded 2σ — likely promotional activity" }
          ]
        },
        "starred": false,
        "strategy_version": 1,
        "status": "done"
      }
    ]
  }
}
```

`evidence` 为 `null` 表示该记录不需要 evidence section（纯事实查询）。

### `PATCH /api/projects/{project_id}/records/{record_id}/star`

切换记录收藏状态。

**Response:**

```json
{
  "ok": true,
  "data": { "starred": true }
}
```

### `GET /api/projects/{project_id}/records/{record_id}/export`

导出单条记录的 Markdown + SVG zip。

**Response:**

```
Content-Type: application/zip
Content-Disposition: attachment; filename="monthly-revenue-trend.zip"

(binary zip data)
```

### `GET /api/projects/{project_id}/export`

导出整个项目 Report 的 Markdown + SVG zip。

**Response:**

```
Content-Type: application/zip
Content-Disposition: attachment; filename="project-report.zip"

(binary zip data)
```

---

## 6. SSE Event Reference

所有 SSE 事件的 `data` 字段均为 JSON。以下是每个事件类型的完整 payload 格式。

### `progress`

Agent pipeline 节点状态更新。每个节点变化时推送一次。

```json
{
  "exchange_id": 3,
  "steps": [
    { "agent": "SQL Agent", "label": "monthly revenue by channel", "status": "done" },
    { "agent": "Stats Agent", "label": "divergence trend test", "status": "active" },
    { "agent": "Viz Agent", "label": "waiting for data", "status": "waiting" },
    { "agent": "Critic Agent", "label": "waiting", "status": "waiting" }
  ]
}
```

`status` 枚举：`done` | `active` | `waiting`

前端映射 → `chatStore.updateTrace(exchangeId, steps)` → AgentTrace 组件实时更新。

### `result`

某个 worker agent 产出了中间结果。按 `type` 字段区分。

#### `result` (type: sql)

```json
{
  "type": "sql",
  "exchange_id": 3,
  "steps": [
    {
      "title": "channel revenue · step 1 of 1",
      "sql": "SELECT channel, DATE_TRUNC('month', sale_date) AS month, SUM(revenue) AS total_revenue FROM sales_2024 WHERE channel IN ('online', 'offline') GROUP BY channel, month ORDER BY month, channel",
      "tag": "SQL Agent",
      "row_count": 24,
      "execution_ms": 12
    }
  ]
}
```

前端映射 → `resultsStore.addSqlRecord()` → SQL Tab 新增条目。

#### `result` (type: viz)

```json
{
  "type": "viz",
  "exchange_id": 3,
  "default_type": "line",
  "alt_types": ["line", "area", "bar", "table"],
  "configs": {
    "line": {
      "data": [{ "x": [...], "y": [...], "name": "Online", "type": "scatter", "mode": "lines" }],
      "layout": { "title": "Online vs Offline Revenue", "xaxis": { "title": "Month" } }
    },
    "area": { ... },
    "bar": { ... }
  },
  "table_data": {
    "headers": ["month", "online", "offline", "delta"],
    "rows": [["Jan", 89200, 62400, "+43%"], ...]
  },
  "svg": "<svg width=\"100%\" viewBox=\"0 0 328 180\">...</svg>"
}
```

前端映射 → `resultsStore.addChartRecord()` → Chart Tab 新增条目。`configs` 用于 Plotly 渲染各类型视图，`table_data` 用于 table 视图和 Copy data 功能，`svg` 用于 Report 嵌入和 SVG 导出。

#### `result` (type: stats)

Stats Agent 完成后推送，但不直接渲染——数据由后续的 `record` 事件整合到 evidence section。

```json
{
  "type": "stats",
  "exchange_id": 3,
  "tests": [
    { "key": "online vs offline divergence", "value": "p = 0.003", "significant": true },
    { "key": "gap growth rate", "value": "+12.4% per month" }
  ],
  "outliers": [
    { "icon": "△", "text": "Nov online ¥142k — seasonal spike (Black Friday)" }
  ],
  "summary": {
    "online_mean": 98400,
    "offline_mean": 71200,
    "correlation": -0.34
  }
}
```

前端不直接处理此事件——等 `record` 事件中的 `evidence` 字段。如果 `tests` 为空数组，Report Agent 不会生成 evidence section。

### `record`

Report Agent 判断 `should_record = true`，前端追加到 Report Tab。

```json
{
  "exchange_id": 3,
  "record": {
    "id": 3,
    "query": "Compare online vs offline channel performance — is the gap widening?",
    "time": "14:45",
    "conclusion": "Online channel revenue is 38% higher than offline and the gap is widening at +12.4% per month. The divergence is statistically significant (p = 0.003).",
    "critic_note": "Divergence trend confirmed. Recommend checking if offline decline is driven by specific regions.",
    "chart_svg": "<svg>...</svg>",
    "evidence": {
      "tests": [
        { "key": "divergence significance", "value": "p = 0.003" },
        { "key": "gap growth rate", "value": "+12.4% / month" },
        { "key": "95% CI (gap)", "value": "¥22k–¥31k" }
      ],
      "anomalies": [
        { "icon": "△", "text": "Nov online ¥142k — seasonal spike (Black Friday)" }
      ]
    },
    "starred": false,
    "strategy_version": 1,
    "status": "done"
  }
}
```

`evidence` 为 `null` → 纯事实查询，前端不渲染 evidence toggle。

前端映射 → `resultsStore.addReportRecord()` → Report Tab 新增 section。

### `quality_block`

Planner 发现当前 query 涉及的列有未处理的 WARNING 级别问题，需要用户做决策后才能继续。

```json
{
  "exchange_id": 3,
  "blocked_column": "channel",
  "dataset_id": "ds_001",
  "dataset_name": "sales_2024.csv",
  "issue": {
    "column": "channel",
    "type": "VARCHAR",
    "description": "missing 1.2% (149 rows)",
    "options": [
      { "value": "mode", "label": "fill with mode (\"online\")" },
      { "value": "unknown", "label": "fill with \"unknown\"" },
      { "value": "null", "label": "keep null" },
      { "value": "drop", "label": "drop rows" }
    ]
  }
}
```

前端映射 → Schema Panel 弹出该列的决策面板，分析暂停。用户选择后调用 `PUT /api/projects/{project_id}/datasets/{dataset_id}/decisions` 提交决策，后端自动恢复 pipeline。

### `strategy_update`

用户通过 Schema Panel 更新了数据清洗策略（非分析过程中的事件，由 `POST /api/projects/{project_id}/confirm` 触发后广播）。

```json
{
  "project_id": "proj_abc123",
  "new_version": 2,
  "affected_record_ids": [1, 2, 3]
}
```

前端映射 → `resultsStore.markOutdated(newVersion)` → 旧记录打 amber 版本 tag。

### `done`

Pipeline 完整执行完毕，包含最终的聚合报告。

```json
{
  "exchange_id": 3,
  "report": {
    "conclusion": "Online channel revenue is 38% higher than offline...",
    "should_record": true,
    "strategy_version": 1
  }
}
```

前端映射 → `chatStore.setReply()` + `chatStore.setStatus('done')` → Agent bubble 出现。

### `error`

Pipeline 执行过程中的异常。

```json
{
  "exchange_id": 3,
  "code": "PIPELINE_ERROR",
  "message": "SQL Agent failed after 2 retries: column 'reveneu' not found",
  "agent": "SQL Agent",
  "recoverable": false
}
```

`recoverable: true` 表示 Critic Agent 已尝试重试但仍失败，用户可以尝试换一种提问方式。`recoverable: false` 表示系统级错误。

前端映射 → `chatStore.setStatus('error')` → 显示错误信息。

---

## 7. Schema Info

### `GET /api/projects/{project_id}/schema`

获取项目当前所有数据集的 schema 信息（Results Panel Schema Tab 内容）。

**Response:**

```json
{
  "ok": true,
  "data": {
    "datasets": [
      {
        "id": "ds_001",
        "name": "sales_2024.csv",
        "active": true,
        "confirmed": true,
        "row_count": 12430,
        "column_count": 8,
        "size_bytes": 2202624,
        "columns": [
          {
            "name": "sale_date",
            "type": "DATE",
            "null_pct": 0.0,
            "sample_values": ["2024-01-03", "2024-01-07"]
          },
          {
            "name": "revenue",
            "type": "DOUBLE",
            "null_pct": 0.0,
            "sample_values": ["12800.00", "45200.50"]
          }
        ],
        "join_keys": {
          "ds_002": {
            "type": "exact",
            "key": "product_id ↔ id",
            "overlap": 0.94
          }
        }
      }
    ],
    "strategy_version": 1,
    "system_mode": "chat"
  }
}
```

---

## 8. Chat History

### `GET /api/projects/{project_id}/exchanges`

获取项目的完整对话记录（Chat Panel 内容）。

**Query Parameters:**

| 参数      | 类型 | 必填 | 说明                     |
| --------- | ---- | ---- | ------------------------ |
| `limit` | int  | ❌   | 返回最近 N 条（默认 50） |

**Response:**

```json
{
  "ok": true,
  "data": {
    "exchanges": [
      {
        "id": 1,
        "query": "Monthly revenue trend by region over the past 12 months — which region grew the fastest?",
        "trace": [
          { "agent": "SQL Agent", "label": "aggregate monthly revenue by region", "status": "done" },
          { "agent": "Stats Agent", "label": "compute MoM growth rate + trend fit", "status": "done" },
          { "agent": "Viz Agent", "label": "generate multi-region line chart", "status": "done" },
          { "agent": "Critic Agent", "label": "conclusion approved", "status": "done" }
        ],
        "reply": "East region grew the fastest, up +34.2% over 12 months...",
        "status": "done",
        "created_at": "2024-03-21T14:32:00Z"
      }
    ]
  }
}
```

---

## 9. 路由总览

```
方法    路径                                                        说明
──────────────────────────────────────────────────────────────────────────────
GET     /api/projects                                               项目列表
POST    /api/projects                                               创建项目
PATCH   /api/projects/{project_id}/star                             项目收藏
DELETE  /api/projects/{project_id}                                  删除项目

POST    /api/projects/{project_id}/datasets                         上传数据集
PATCH   /api/projects/{project_id}/datasets/{dataset_id}/toggle     开关数据集
PUT     /api/projects/{project_id}/datasets/{dataset_id}/decisions  提交清洗决策
POST    /api/projects/{project_id}/confirm                          确认/更新策略

GET     /api/analyze/stream                                         分析（SSE）

GET     /api/projects/{project_id}/records                          记录列表
PATCH   /api/projects/{project_id}/records/{record_id}/star         记录收藏
GET     /api/projects/{project_id}/records/{record_id}/export       单记录导出
GET     /api/projects/{project_id}/export                           全项目导出

GET     /api/projects/{project_id}/schema                           Schema 信息
GET     /api/projects/{project_id}/exchanges                        对话记录
```

共 14 个端点，其中 1 个 SSE 流、2 个文件传输（upload + export）、11 个 JSON 接口。

---

## 10. 后端文件映射

```
backend/api/
├── main.py         # FastAPI app 实例、中间件、startup/shutdown
├── routes.py       # 所有路由注册（按 Section 分 router）
├── schemas.py      # Pydantic 模型（Request/Response 全部定义在此）
└── sse.py          # SSE 事件推送工具函数（封装 sse-starlette）
```

`schemas.py` 应包含以下模型：

```
Request 模型：
  CreateProjectRequest
  ToggleDatasetRequest
  SubmitDecisionsRequest

Response 模型：
  ApiResponse[T]          # 统一响应包装 {"ok": true, "data": T}
  ApiError                # 错误响应 {"ok": false, "error": {...}}
  ProjectResponse
  DatasetUploadResponse
  ToggleDatasetResponse
  DecisionResponse
  ConfirmResponse
  RecordResponse
  ExchangeResponse
  SchemaResponse

SSE 事件模型：
  ProgressEvent
  ResultEvent
  RecordEvent
  QualityBlockEvent
  StrategyUpdateEvent
  DoneEvent
  ErrorEvent
```
