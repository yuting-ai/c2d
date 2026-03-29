# c2d — Technical Deep Dive

面试用技术文档。从代码层面追踪数据流，解释每个模块的实现逻辑和设计决策。

---

## 0. 近期代码变更记录（截至 2026-03-27）

以下为“上次文档更新后到当前”为止的核心代码改动归档（按功能域聚合）。

### 0.1 数据清洗与决策链路

- Warning 决策从“按列名”升级为“按问题键（`column:issue_type`）”，避免同一列多类 warning 冲突。
- `QualityIssue` 增加 `issue_type`，清洗应用逻辑改为按 `issue_type` 分支，而非描述文本匹配。
- 数值类 warning 可控选项扩展：`mean`、`median`、`drop_row`、`winsorize`、`clip_iqr`、`keep`。
- `VARCHAR -> DOUBLE` 推断后，warning 的 `col_type` 回传改为优先 `inferred_type`，前端类型徽章可显示为数字类型。
- must-solve 规则上线：
  - missing：阈值按模式生效（advanced = 5%，simple = 50%）
  - outlier：占比 >= 8%
- confirm 阶段增加后端强校验：未处理 must-solve warning 不允许确认。

### 0.2 模式化体验（simple / advanced）

- 新增全局分析模式：`simple` 与 `advanced`，前端本地持久化。
- simple 模式上传后支持自动策略并自动 confirm（低摩擦）。
- 上传接口新增 `analysis_mode`，前后端清洗阈值统一。
- simple 模式增加查询前提醒（命中高风险列时触发）。

### 0.3 Warning 与交互体验

- Warning 列表按列聚合展示，列内按 issue 展示，消除“重复列”感知问题。
- warning 条目支持 must-solve 标识，并纳入顶部/底部阻塞计数。
- advanced 模式下，warning 选中后自动折叠为绿色 `✓` 已解决摘要，点击可重新编辑。
- 类型徽章体系增强：文本/数字/日期/布尔差异化颜色 + 轻量图标。

### 0.4 Agent 与提示词稳定性

- Critic 重试判定收紧，减少低价值 retry（边界措辞或拆解偏差导致的误重试）。
- SQL / Planner 提示词示例去领域化，改为通用业务表结构示例。

### 0.5 图表渲染与 BI 模式（2026-03-27）

- **Overview/Detail 双模式**：Scatter、Line、Bar 图表新增 BI 风格的 Overview（聚合）模式。Overview 按 x 值分组计算 `mean(y)`，渲染聚合点；Detail 模式渲染原始数据。替代原来的简单抽样方式。
- **Programmatic alt_types 过滤**：Viz Agent 新增 `_compatible_chart_types()` 函数，基于数据形状（x 分类/数值/时序、y 数值）程序化过滤 LLM 输出的 `alt_types`。Histogram 分箱数据（x 为 `"0-500"` 等分类字符串）只保留 `bar`/`pie`，不出现无意义的 `scatter`/`line`/`area`。
- **Histogram/直方图 三层防护**：
  1. Planner prompt 增加 `sql_task` 编写指南，检测直方图/分布意图时强制指示使用 `width_bucket()` 分箱。
  2. SQL Agent prompt 增加完整的 DuckDB `width_bucket()` 直方图 SQL 模板。
  3. Critic Agent 新增 `_force_histogram_retry()`：若用户问直方图但 SQL 只返回 ≤5 行数据，自动强制 retry 并给出精确修复指令。
- **SQL 沙箱行数限制移除**：`backend/db/sandbox.py` 的 `MAX_RESULT_ROWS` 已移除，改用 `fetchall()` 返回完整结果集，确保数据完整性。
- **Table 视图阈值**：`TABLE_VIEW_MAX_ROWS = 50`，超过 50 行时 `table` 选项不显示（设计目的为截图/报告，非交互）。
- **Chart 缩放**：支持 100%–500% 水平缩放，用于查看密集数据细节。
- **Y 轴格式化**：数值轴自动缩写（K/M/B），非数值轴截断超长标签。
- **Bar 图排序**：x 轴为数值时按升序排列，非数值时按 y 总值降序排列。
- **X-ticks 自适应**：`X_TICKS_AUTO_OFF_THRESHOLD = 20`，span ≤ 20 时默认显示全部刻度，否则稀疏。

#### 0.5.1 与「图形画错 / 总结不符合数据」相关的后端保障（2026-03-28 文档归档）

与 **修复图表类型与数据形状不匹配**、**修复结论文本脱离查询结果** 直接相关的逻辑，已集中写入 **`agent_design.md` §1.2（图表）与 §1.3（Report）**，并在 **`architecture.md`** §5「图表与结论文本的数据一致性」作架构摘要。此处仅作索引：

- **图表**：`_build_series_from_rows`、`_compatible_chart_types`、`_force_histogram_retry`、SQL 窗口 ORDER BY / 分组内 rank 与主指标一致性校验。
- **结论**：`ranked_data_facts`（DATA_FACTS）、趋势句中「一直 / consistently」约束、两位小数与 GFM 表结构、稀疏评分列 NULL 免检（避免错误重试）。

### 0.6 主要涉及文件（按模块）

- 后端：
  - `backend/db/loader.py`
  - `backend/api/routes.py`
  - `backend/api/schemas.py`
  - `backend/agents/critic_agent.py`
  - `backend/config/prompts.py`
- 前端：
  - `frontend/src/stores/schemaStore.ts`
  - `frontend/src/components/schema/SchemaPanel.tsx`
  - `frontend/src/hooks/useAnalysisStream.ts`
  - `frontend/src/components/chat/ChatPanel.tsx`
  - `frontend/src/styles/schema.css`
  - `frontend/src/styles/chat.css`

### 0.7 SQL 稳定性与离线语法基线（2026-03-27 补充）

- **离线 DuckDB 语法参考接入**：SQL Agent 通过 `backend/knowledge/duckdb_retriever.py` 检索 `doc/duckdb_official/quick_reference.md`，并将检索片段注入 `SQL_AGENT_SYSTEM` 的 `duckdb_refs` 占位符，保证本地模型离线可用。
- **执行失败根因修复（表名误判）**：`_validate_sql_candidate()` 的 `FROM/JOIN` 表名提取修复，避免将 `EXTRACT(YEAR FROM release_date)` 中的 `FROM release_date` 误识别为表名。
- **验证可观测性增强**：新增 SQL Agent 调试日志（refs preview + tool step error preview）用于快速定位 SQL 失败原因；问题确认后可按需关闭。

### 0.8 P-B 查询修复 · Critic 假阳性修复（2026-03-28）

本节记录针对 **top-N per group（P-B）** 意图的完整修复链路，以及 Critic 对数据稀疏结果的假阳性问题修复。

#### 0.8.1 根因诊断过程

执行 P-B 类查询（"每年游戏发行量和类型 top5"）时，发现连续 3 次 SQL 迭代返回空结果或报错。逐步排查：

1. **重复 SQL 未检测**：`last_sql_fp` 指纹已计算但未与上一次比较，LLM 生成相同 SQL 后循环失败。
2. **CTE 被错误拒绝**：`_validate_sql_candidate()` 把 `WITH ranked AS (...)` 的外层 `FROM ranked` 误判为未知表，SQL 在执行前就被拦截，故 DuckDB error 日志从未出现。
3. **DuckDB ORDER BY 聚合表达式**：DuckDB 不允许在 GROUP BY 存在时，在窗口函数的 ORDER BY 里直接写聚合表达式（`ORDER BY SUM(col) DESC`），必须用别名。
4. **DuckDB 别名在 OVER 中也不可用**：即使把 ORDER BY 改为别名（`ORDER BY alias DESC`），在同一 SELECT 既有 GROUP BY 又有窗口函数时，DuckDB binder 仍无法解析 SELECT 层别名，必须把聚合和窗口函数拆入两个 CTE。
5. **PARTITION BY 引用原始列名**：拆 CTE 后，第二个 CTE 中 PARTITION BY 仍引用 `YEAR(release_date)` 而非已聚合的别名 `year`，再次触发 Binder Error。

#### 0.8.2 SQL Agent 修复

**文件**：`backend/agents/sql_agent.py`

| 修复点 | 描述 |
|--------|------|
| CTE 白名单 | `_validate_sql_candidate()` 新增两套正则从 `WITH ... AS (` 提取 CTE 名称（支持首个 CTE、RECURSIVE 关键字、多 CTE 逗号连接），将其加入 `allowed` 集合，避免 `FROM cte_name` 被误判为未知表 |
| 重复 SQL 检测（text 模式） | `_normalize_sql_fingerprint()` 计算当前 SQL 指纹，与 `last_sql_fp` 比较；相同时在重试 prompt 追加 `[!] CRITICAL` 警告，强制模型更换查询结构 |
| 重复 SQL 检测（tool 模式） | `_run_with_tools` 对 tool call 的 SQL 同样做指纹比较，重复时直接注入错误消息而非执行 |
| 验证失败日志 | `_validate_sql_candidate()` 拒绝时打 WARNING，含被拒表名、允许表列表、CTE 名列表 |
| DuckDB error 日志 | text 模式执行失败时打 WARNING，含 error 内容前 300 字符 |
| Schema 列类型 | `active_tables` 新增 `col_dicts: [{name, type}]` 字段，SQL Agent 格式化为 `col_name (TYPE)` 注入 schema 描述，帮助模型写出正确的 CAST 和聚合 |

**文件**：`backend/api/routes.py` · `backend/agents/planner.py`

- `active_tables` 构建时增加 `col_dicts` 字段（列名 + 推断类型），Planner 和 SQL Agent 均使用带类型的 schema 格式。

#### 0.8.3 `sanitize_sql()` 三级自动修复链

**文件**：`backend/agents/json_utils.py`

```
extract_sql()        从 LLM 输出提取 SQL
    │
    ▼
sanitize_sql()
    ├─ 1. TOP N → LIMIT N        （SQL Server 方言修复）
    ├─ 2. DATE_TRUNC 单引号列名  （MySQL 方言修复）
    ├─ 3. _fix_aggregate_in_orderby()   ← 本次新增
    │      ORDER BY SUM(col) → ORDER BY alias（窗口 OVER 中）
    └─ 4. _fix_window_in_grouped_cte()  ← 本次新增
           单 CTE（GROUP BY + 窗口函数）→ 两 CTE（聚合 + 排名）
               并将窗口项中的原始表达式替换为第一个 CTE 的输出别名
```

**`_fix_aggregate_in_orderby(sql)`**

- 触发条件：SQL 含 `GROUP BY`
- 构建 `agg_alias` 映射（`SUM(col) AS alias` → `{SUM(COL): alias}`）
- 将 ORDER BY 中出现的聚合表达式替换为别名
- 适用范围：窗口函数 OVER ORDER BY 和全局 ORDER BY 均处理

**`_fix_window_in_grouped_cte(sql)`**

- 触发条件：SQL 含 `GROUP BY` 且含 ` OVER `
- 流程：
  1. 用 `_find_matching_paren()` 定位第一个 CTE 的边界
  2. 用 `_split_select_items()` 按顶层逗号分割 SELECT 列表（正确处理嵌套括号）
  3. 按 `OVER\s*(` 将列表分为 `regular_items`（聚合列）和 `window_items`（窗口函数列）
  4. 用 `_select_item_output_name()` 提取 regular_items 的输出别名，构成第二个 CTE 的 SELECT 前缀
  5. 构建 `expr_to_alias` 映射，将窗口函数中引用的原始表达式（如 `YEAR(release_date)`）替换为聚合 CTE 的输出别名（如 `year`）
  6. 生成两个 CTE：`{name}_agg`（聚合+GROUP BY）和 `{name}`（窗口+FROM {name}_agg）

DuckDB 限制的本质：binder 在 SELECT-level 别名解析之前就处理窗口函数，因此同一 SELECT 中 GROUP BY 聚合别名在 OVER ORDER BY 里不可用——唯一可靠的解法是拆成两个 SELECT 层。

#### 0.8.4 Critic 假阳性修复（数据稀疏）

**文件**：`backend/agents/critic_agent.py`

**问题**：SQL 正确执行，但结果中 metric 列（如 `total_sales`）对 2021-2024 年的数据均为 NULL（因数据集本身缺失），Critic 错误地判定为 SQL 逻辑错误并触发 retry。

**诊断**：查原始 CSV，发现 `total_sales` 在 2021+ 年为 100% NULL，这是数据集的覆盖限制，与 SQL 正确性无关。

**两层修复**：

1. **Prompt 层**（`CRITIC_SYSTEM` 数据稀疏规则）：
   - 区分「维度列有值、指标列 NULL」与「SQL 逻辑错误」
   - 明确要求：指标 NULL 时 verdict 必须为 pass，并在 transparency_notes 里说明数据缺口

2. **程序化守卫 `_override_null_sparsity_retry()`**（模型无关，LLM 失败时兜底）：
   - 触发条件（同时满足）：
     - `verdict == "retry"`
     - `len(final_rows) >= 3`（有真实结果行）
     - 至少一个 metric 列 ≥ 60% 为 NULL
     - 至少一个非 NULL 主导的维度列（排除"全部为 NULL"的极端情况）
     - SQL 含 `GROUP BY` + 聚合函数（结构正确）
   - 触发后：降级为 pass，feedback 说明数据覆盖缺口

**守卫顺序**：`_force_histogram_retry()` → `_override_null_sparsity_retry()` → `_override_false_positive_retry()` → `_override_sum_and_avg_both_requested()`

#### 0.8.5 涉及文件汇总

| 文件 | 改动类型 |
|------|----------|
| `backend/agents/sql_agent.py` | CTE 白名单、重复检测、验证日志、col_dicts schema |
| `backend/agents/json_utils.py` | `_fix_aggregate_in_orderby`、`_fix_window_in_grouped_cte` 及三个辅助函数 |
| `backend/agents/critic_agent.py` | `_override_null_sparsity_retry`、Prompt 数据稀疏规则 |
| `backend/api/routes.py` | `active_tables` 增加 `col_dicts` |
| `backend/agents/planner.py` | schema 格式使用 `col_dicts` |
| `backend/config/prompts.py` | P-B 示例改用别名 + DuckDB CRITICAL 规则 |
| `tests/test_agents.py` | 新增 18 + 19 = 37 个回归测试 |

---

## 1. 完整请求追踪：从输入到结果

用户输入 "各平台游戏销量对比" 后，数据经过以下 14 个步骤到达屏幕。

### Step 1: 前端 InputArea → ChatStore

```
文件：frontend/src/components/chat/ChatPanel.tsx
函数：handleSend()
```

```typescript
const handleSend = () => {
  submit(input.trim(), activeProjectId!)  // 调用 SSE hook
  setInput('')                             // 清空输入框
}
```

`submit` 来自 `useAnalysisStream` hook。此时 UI 变化：输入框清空，exchange 创建。

### Step 2: SSE Hook → EventSource 连接

```
文件：frontend/src/hooks/useAnalysisStream.ts
函数：submit()
```

```typescript
// 多项目多会话架构
const { exchangeId, sessionId } = addExchange(projectId, query)
// chatStore 创建新 exchange，状态 = pending

// 创建 running 状态的 chart 占位卡片
const chartRecordId = useResultsStore.getState().startChartRecord(query)

const url = `/api/analyze/stream?project_id=${projectId}&query=${encodeURIComponent(query)}`
const eventSource = new EventSource(url)  // 浏览器原生 SSE 连接
```

**为什么用 EventSource 而不是 fetch？**
EventSource 自带事件类型分发（`addEventListener('progress', ...)`），不需要手动解析 SSE 格式。缺点是只支持 GET，但 query 参数放 URL 够用。

**为什么 exchange 的初始状态是 pending？**
pending → 前端显示 typing dots。收到第一条 SSE 事件后变 streaming → typing dots 被 ThinkingBlock 替代。

**为什么在 submit 时就创建 chart 占位？**
`startChartRecord(query)` 立即在 Chart Tab 创建一个 `status='running'` 的卡片，让用户知道分析正在进行。`done` 事件到达后用 `finalizeChartRecord()` 填充数据，失败则 `removeChartRecord()` 清除。

### Step 3: Vite Proxy → FastAPI

```
文件：frontend/vite.config.ts
```

```typescript
proxy: { '/api': { target: 'http://localhost:8000' } }
```

前端开发服务器 (5173) 把 `/api/*` 请求代理到后端 (8000)。生产环境需要 Nginx/Caddy 做同样的事。

### Step 4: FastAPI 路由 → SSE 生成器

```
文件：backend/api/routes.py
函数：analyze_stream()
```

```python
@router.get("/analyze/stream")
async def analyze_stream(project_id: str, query: str):
    project = _get_project(project_id)          # 从内存字典获取项目（含自动 bootstrap）
    # active_tables 和 quality_notes 从 project state 构建
    
    return EventSourceResponse(
        run_analysis_stream(project_id, query, active_tables, quality_notes, dataset_ids)
    )
```

**关键点**：`EventSourceResponse` 来自 `sse-starlette`，接收一个 async generator，每个 yield 的 dict 自动序列化为 SSE 格式（`event: xxx\ndata: {...}\n\n`）。

### Step 5: Pipeline 执行 → 逐节点流式推送

```
文件：backend/api/sse.py
函数：run_analysis_stream()
```

入口：`user_lang = detect_language(query)`（`backend/graph/language.py`），`logger.info("user_lang=%s", user_lang)`，`initial_state["user_lang"] = user_lang`。未安装 `langdetect` 时回退 `"en"`。

```python
async for chunk in pipeline.astream(initial_state, stream_mode="updates"):
    for node_name, update in chunk.items():
        # 每个节点完成时立即推送其 stream_events
        for event in update.get("stream_events", []):
            yield {"event": event_type, "data": json.dumps(event_data)}
        
        # 追踪最终结果
        if "sql_result" in update: final_sql_result = update["sql_result"]
        if "viz_result" in update: final_viz_result = update["viz_result"]
```

**为什么用 `astream(stream_mode="updates")` 而不是 `ainvoke`？**
`ainvoke` 等全部节点跑完才返回——用户看到的是长时间空白然后突然出结果。
`astream` 每个节点完成时 yield 一次——用户实时看到 trace 更新。

### Step 6: LangGraph 条件路由

```
文件：backend/graph/pipeline.py
```

```python
graph = StateGraph(AgentState)
graph.set_entry_point("planner")
graph.add_conditional_edges("planner", route_after_planner)  # → sql_agent 或 END
graph.add_conditional_edges("sql_agent", route_after_sql)    # → viz/stats/critic/report
graph.add_conditional_edges("viz_agent", route_after_viz)    # → stats 或 critic
graph.add_edge("stats_agent", "critic")                      # 固定边（stats → critic）
graph.add_conditional_edges("critic", route_after_critic)    # → report / retry / 补跑 viz
graph.add_edge("report", END)
```

**条件路由函数** 读取 AgentState 中的 `plan`、`sql_result`、`critic_verdict`、`retry_count`、`retry_target` 等字段决定下一步。这是 LangGraph 的核心模式——节点之间的跳转逻辑在编译时定义，运行时根据 state 动态决定。注：Critic 触发重试时路径缩短为 SQL → Critic（跳过 Viz/Stats），Critic 通过后再补跑 Viz。

### Step 7: Planner Agent — 意图理解

```
文件：backend/agents/planner.py
函数：planner_agent(state) → dict
```

```python
# 1. 构建 prompt（注入表结构、清洗决策、输出语言码）
system = PLANNER_SYSTEM.format(
    user_lang=state.get("user_lang", "en"),
    active_tables=tables_text,
    quality_notes=quality_notes,
)

# 重试时注入 Critic 反馈
if retry_count > 0 and retry_target in {"planner", "both"} and critic_feedback:
    system += f"\n\n⚠️ PREVIOUS PLAN FAILED REVIEW.\n{critic_feedback}"

# 2. 一次 LLM 调用
response = await llm.ainvoke([SystemMessage(no_think(system)), HumanMessage(query)])

# 3. 容错 JSON 解析（extract_json 处理 ``` 包裹、<think> 标签等）
parsed = extract_json(text) or fallback_plan

# 安全网：用户明确要图表时强制加入 "viz"
if _needs_viz(query) and "viz" not in plan: plan.append("viz")
# "top N per group" 模式注入窗口函数提示
if _is_top_n_per_group(query): parsed["sql_task"] += window_function_hint
```

**Planner 的两条路径**：
- `plan` 非空 → 返回 `sql_task`/`viz_task`/`stats_task`/`involved_columns` 等字段，pipeline 继续
- `plan` 为空 + `direct_answer` 非空 → 直接填充 `sql_result.answer`，pipeline 跳到 END

**为什么 Planner 能直接回答？**
它已经有表结构上下文（列名、行数、类型），"这是什么数据集" 类问题不需要查数据。省一次 SQL Agent 调用。

**安全网机制**：正则检测用户查询中的可视化关键词（中英文）。即使 LLM 给了 `direct_answer`，如果用户想要图表，会强制 override 为 `["sql", "viz"]` 路径。

### Step 8: SQL Agent — Tool Calling 循环

```
文件：backend/agents/sql_agent.py
函数：sql_agent(state) → dict
```

```python
tools = create_sql_tools(conn)        # 创建绑定 DuckDB 连接的 run_query tool

# 双模式：大模型走 tool-calling，小模型走文本提取
if supports_tools:
    llm_with_tools = llm.bind_tools(tools)
    for iteration in range(MAX_ITERATIONS):  # 最多 3 轮
        response = await llm_with_tools.ainvoke(messages)
        if not response.tool_calls:
            break
        for tc in response.tool_calls:
            result = await tool_map[tc["name"]].ainvoke(tc["args"])
            messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))
else:
    # 文本回退模式：从 LLM 输出提取 SQL 语句
    response = await llm.ainvoke(messages)
    sql = extract_sql(response.content)
    result = run_query_fn(sql)

# Intent Contract：执行前的语义校验
contract = _build_intent_contract(user_query, sql_task)
violation = _validate_sql_against_contract(sql, contract)
if violation:
    # 自动修正：将违规信息反馈给 LLM 重试
```

**Tool Calling 的工作原理**：
1. LLM 收到消息 + tool schema → 决定调用 `run_query(sql="SELECT ...")`
2. 我们执行 tool，把结果作为 `ToolMessage` 追加到 messages
3. LLM 看到结果 → 决定是否再调一次（比如修正 SQL 错误）或者停止

**Intent Contract 校验**：
在 SQL 执行前，从用户自然语言中提取语义约束（时间筛选、Top-N、分组、必需维度），然后校验生成的 SQL 是否满足。不满足则自动反馈给 LLM 修正，确保结果语义准确。

**SQL 沙箱**（`backend/db/sandbox.py`）：
```python
FORBIDDEN_PATTERNS = [
    re.compile(r'\b(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|TRUNCATE)\b', re.I),
    re.compile(r'\b(COPY|EXPORT|IMPORT|ATTACH|DETACH)\b', re.I),
    re.compile(r'\bPRAGMA\b', re.I),
]

def execute_sandboxed(conn, sql):
    sql = strip_markdown_fences(sql)    # 清除 LLM 可能加的 ``` 包裹
    for pattern in FORBIDDEN_PATTERNS:
        if pattern.search(sql): return {"error": "Forbidden operation detected"}
    result = conn.execute(sql)          # DuckDB 只读连接执行
    rows = result.fetchall()            # 返回完整结果集，确保数据准确性
```

同步执行、无超时限制。所有 SQL 经过正则检查，只允许 SELECT/WITH 等只读操作。不限制返回行数——前端通过 LOD（Overview/Detail）机制处理大数据集的渲染性能问题。

### Step 9: DuckDB 查询

```
文件：backend/db/engine.py
```

```python
class DuckDBEngine:
    def __init__(self):
        self._connections: dict[str, duckdb.DuckDBPyConnection] = {}
    
    def get_connection(self, project_id: str) -> duckdb.DuckDBPyConnection:
        """读写连接（用于 apply_decisions 写入数据）"""
        if project_id not in self._connections:
            db_path = Path(settings.DUCKDB_DATA_DIR) / f"{project_id}.duckdb"
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self._connections[project_id] = duckdb.connect(str(db_path))
        return self._connections[project_id]
    
    def get_readonly(self, project_id: str) -> duckdb.DuckDBPyConnection:
        """只读连接（用于 SQL Agent sandbox 查询）"""
        db_path = Path(settings.DUCKDB_DATA_DIR) / f"{project_id}.duckdb"
        return duckdb.connect(str(db_path), read_only=True)

engine = DuckDBEngine()  # 模块级单例
```

**每个项目一个 .duckdb 文件**，路径由 `settings.DUCKDB_DATA_DIR` 控制，在 confirm 阶段由 `loader.py` 的 `apply_decisions()` 创建。
**两种连接模式**：`get_connection()` 提供读写连接用于数据写入（复用连接池），`get_readonly()` 每次新建只读连接用于 SQL Agent 沙箱查询。

### Step 10: Viz Agent — 图表数据生成

```
文件：backend/agents/viz_agent.py
函数：viz_agent(state) → dict
```

```python
# 从 sql_result 构建数据预览（前 30 行）
header = " | ".join(str(c) for c in final_columns)
rows_text = "\n".join(" | ".join(str(v) for v in row) for row in final_rows[:30])
data_preview = f"{header}\n{rows_text}"

# LLM 选择图表类型（最多重试 1 次）
prompt = VIZ_SYSTEM.format(columns=..., data_preview=..., row_count=..., user_query=...)
for attempt in range(2):
    response = await llm.ainvoke(messages)
    chart_data = extract_json(response.content)  # 容错 JSON 解析
    if chart_data and chart_data.get("series"):
        break

# 关键：LLM 只决定 type/alt_types/title/x_label/y_label
# series 数据由 _build_series_from_rows() 从全量 SQL 结果确定性构建
full_series = _build_series_from_rows(final_columns, final_rows)

viz_result = {
    "type": primary_type,
    "alt_types": filtered_alt,   # 程序化过滤后的备选类型
    "title": chart_data.get("title", ""),
    "x_label": chart_data.get("x_label", ""),
    "y_label": chart_data.get("y_label", ""),
    "series": series,            # 确定性构建优先
    "table_data": {"headers": final_columns, "rows": final_rows[:100]},
}
```

**`_build_series_from_rows` 确定性构建**：不依赖 LLM 生成 series 数据（LLM 可能截断）。通过列类型启发式选择 x/y/group 维度，temporal 列排序，确保全量数据不丢失。

**`_compatible_chart_types` 程序化过滤**：基于实际数据形状（x 轴是分类/数值/时序，y 轴是否数值，unique x 数量）判断哪些图表类型有意义。LLM 输出的 `alt_types` 取交集后补全。例如 histogram 分箱数据的 x 是 `"0-500"` 等字符串 → 只保留 `bar`/`pie`。

**Histogram 意图检测**：`_is_histogram_intent()` 检测用户查询是否包含直方图/分布关键词。如果检测到 histogram 意图但 SQL 只返回 ≤5 行，记录 warning 日志。

**为什么不用 Plotly config？**
LLM 生成 `{type, series}` 的准确率 >> 生成复杂的 Plotly config。前端用 Recharts 渲染，完全控制暗色主题样式。

### Step 11: Critic Agent — 质量审核

```
文件：backend/agents/critic_agent.py
函数：critic_agent(state) → dict
```

```python
if retry_count >= 2:
    return {"critic_verdict": "pass", ...}  # 强制通过

response = await llm.ainvoke(critic_prompt)
parsed = json.loads(response.content)
# {"verdict": "pass", "feedback": "..."} 
# 或 {"verdict": "retry", "target": "sql", "feedback": "应该用 SUM 不是 AVG"}

# 程序化守卫（在 LLM 判定之后执行）：
# 1. _force_histogram_retry()：用户问直方图但 SQL 只返回 ≤5 行 → 强制 retry SQL
# 2. _override_false_positive_retry()：等价边界 / 单 SQL 已覆盖 → 降级为 pass
```

**重试机制**：
```
Critic → "retry", retry_target="sql" 或 "planner" 或 "both"
  → route_after_critic 根据 retry_target 路由回 sql_agent 或 planner
  → 重试路径缩短：SQL → Critic（跳过 Viz/Stats）
  → Critic 通过后 route_after_critic 检查 viz_result 是否已存在
  → 如无 viz_result → 走 viz_agent → stats_agent → report
  → 如有 viz_result → 直接 report
  → 最多 2 次重试（retry_count >= 2 时强制进入 report）
```

### Step 12: Report Agent — 结论生成

```
文件：backend/agents/report_agent.py
函数：report_agent(state) → dict
```

接收 `user_lang`、`sql_result`、`stats_result`、`critic_feedback` 等；注入 **`ranked_data_facts`**（#1–#3 事实，两位小数）；`REPORT_SYSTEM` 要求 **段落/列表式**结论文本，**不**重复管道表（与 Chart 面板 **Table** 分工）。`temperature=0`。

```python
return {
    "report": {
        "conclusion": conclusion,   # Markdown；前端 ChatMarkdown 渲染
        "should_record": bool(final_rows) and not error,
        "strategy_version": 1,
        "evidence": None,
    },
    "stream_events": [...],
}
```

### Step 13: SSE done 事件 → 前端更新

```
文件：frontend/src/hooks/useAnalysisStream.ts
```

```typescript
eventSource.addEventListener('done', (e) => {
  const data = JSON.parse(e.data)
  
  setReply(exchangeId, data.report.conclusion)   // chatStore → reply 出现
  setStatus(exchangeId, 'done')                   // chatStore → ThinkingBlock 折叠
  
  // 统一写入 resultsStore（不在中间 result 事件写入，防止 Critic 重试重复）
  if (data.viz_result) {
    resultsStore.finalizeChartRecord(chartRecordId, data)  // 两阶段：填充占位卡片
  } else {
    resultsStore.removeChartRecord(chartRecordId)          // 无图表：移除占位
  }
  if (data.sql_result) resultsStore.addSqlRecord(...)
  if (data.report.should_record) resultsStore.addReportRecord(...)
})

eventSource.addEventListener('error', () => {
  resultsStore.removeChartRecord(chartRecordId)   // 错误：移除占位卡片
})
```

### Step 14: React 渲染

Zustand store 更新 → 订阅组件自动重渲染：

```
chatStore.reply 更新     → ChatPanel → ConversationTurn → AnalystReply 淡入
chatStore.trace 更新     → ChatPanel → ThinkingBlock 折叠动画
resultsStore.chartRecords → ResultsPanel → ChartTab → Recharts 渲染
resultsStore.sqlRecords   → ResultsPanel → SqlTab 展示
resultsStore.reportRecords → ResultsPanel → ReportTab 展示
```

---

## 2. 核心设计模式

### 2.1 Zustand Store 模式

```typescript
// 创建 store
export const useSchemaStore = create<SchemaStore>((set, get) => ({
  datasets: [],
  systemMode: 'empty',
  
  // 同步 action — 直接 set
  reset: () => set({ datasets: [], systemMode: 'empty' }),
  
  // 异步 action — async 函数内多次 set
  uploadDataset: async (projectId, file) => {
    set({ uploading: true })
    const res = await fetch(`/api/projects/${projectId}/datasets`, ...)
    set({ datasets: [...get().datasets, newDataset], uploading: false })
  },
  
  // 跨 store 访问 — getState() 不在 selector 层
  selectOption: (datasetId, column, option) => {
    const projectId = useProjectStore.getState().activeProjectId
    fetch(`/api/projects/${projectId}/datasets/${datasetId}/decisions`, ...)
  },
}))

// 使用 store（React 组件内）
const datasets = useSchemaStore((s) => s.datasets)     // selector，精确订阅
const upload = useSchemaStore((s) => s.uploadDataset)   // action
```

**为什么用 Zustand 不用 Redux/Context？**
Zustand 不需要 Provider 包裹、不需要 dispatch/reducer 样板代码、selector 自动做浅比较避免多余渲染。`getState()` 可以在 store 外部同步访问（比如在 SSE hook 里）。

### 2.2 LangGraph State 模式

```python
class AgentState(TypedDict, total=False):
    # Input
    user_query: str
    user_lang: str               # BCP-47；sse 入口 detect_language
    session_id: str
    project_id: str
    
    # Dataset context
    active_tables: list[dict]       # [{name, columns, row_count}]
    quality_notes: list[str]        # 清洗决策文本
    
    # Planner output
    plan: list[str]                 # ["sql", "viz", "stats"]
    sql_task: str
    viz_task: str | None
    stats_task: str | None
    involved_columns: list[str]
    
    # Agent outputs
    sql_result: dict                # {steps, final_rows, final_columns, error, quality_warning, intent_contract}
    viz_result: dict | None
    stats_result: dict | None
    
    # Critic
    critic_verdict: str             # "pass" | "retry"
    critic_feedback: str
    retry_count: int
    retry_target: str | None        # "sql" | "planner" | "both"
    
    # Report
    report: dict | None
    should_record: bool
    
    stream_events: Annotated[list[dict], add]  # ← 关键：add reducer
```

**`Annotated[list, add]`** 的作用：
每个节点返回 `{"stream_events": [event1, event2]}`，LangGraph 不是替换而是**追加**到已有列表。这让所有节点的事件按顺序累积，不需要手动 merge。

**`total=False`** 的作用：
TypedDict 默认所有字段必填。`total=False` 让所有字段可选——pipeline 入口只需要提供 `user_query` 和 `project_id`，其他字段由各节点逐步填充。

### 2.3 项目切换的 Cache 模式

```typescript
// schemaStore 内部
_cache: Record<string, ProjectSchemaState>
_activeProjectId: string | null

switchProject: (projectId) => {
  // 1. 保存当前项目状态到 cache
  cache[state._activeProjectId] = {
    datasets: state.datasets,
    systemMode: state.systemMode,
    ...
  }
  
  // 2. 从 cache 恢复目标项目（或空状态）
  const restored = cache[projectId] || EMPTY_STATE
  set({ ...restored, _activeProjectId: projectId })
}
```

**为什么不从后端重新获取？**
用户在 Sidebar 频繁切换项目，每次都请求后端太慢。Cache 模式切换瞬间完成。上传/confirm 操作会自动同步到 cache。

### 2.4 SSE 事件设计

```
事件类型    时机             携带数据                                         前端处理
──────────────────────────────────────────────────────────────────────────────────────
progress    节点执行中/完成    {steps: [{agent, label, status}]}               更新 ThinkingBlock
result      SQL/Viz 中间产出  {type: "sql"|"viz", ...}                        仅更新 chat 中间展示
done        pipeline 结束     {report, sql_result, viz_result,                写入 resultsStore +
                               dataset_versions, stats_result}                finalizeChartRecord
error       任何阶段失败      {code, message, agent}                          显示错误 + removeChartRecord
```

**为什么 result 事件不写 resultsStore？**
Critic Agent 可能打回重试——SQL Agent 会重新执行，产出新的 result 事件。如果每次 result 都写 resultsStore，重试后会有重复记录。统一在 done（Critic 已通过）时写入。

---

## 3. 数据管道详解

### 3.1 文件上传 → DuckDB 的 4 步流程

```
CSV 文件 → parse_file() → infer_types() → scan_quality() → [用户决策] → apply_decisions() → DuckDB
```

```python
# Step 1: parse_file() — 读取文件，返回 pandas DataFrame
def parse_file(file_path: str, original_name: str) -> pd.DataFrame:
    # 支持 .csv, .xlsx, .xls, .txt（tab-delimited）
    # 列名：strip().lower().replace(' ', '_')
    # 删除全空行

# Step 2: infer_types() — 逐列推断真实类型
def infer_types(df) -> list[ColumnInference]:
    # 推断顺序：boolean → integer → year_like_integer → float → date
    # 每种类型有转换成功率阈值（如 boolean 需 95%）
    # 返回 ColumnInference dataclass 含 decision/inferred_type/conversion_options

# Step 3: scan_quality() — 检测数据质量问题
def scan_quality(df, column_inferences, analysis_mode) -> list[QualityIssue]:
    # issue_type: missing, outlier, unit_mismatch, percent_scale,
    #             currency_symbol, categorical
    # severity: "blocking" 或 "warning"
    # must_solve 标记必须解决的问题

# Step 4: apply_decisions() — 根据用户选择清洗数据
def apply_decisions(project_id, dataset_id, file_path, original_name,
                    decisions, column_types) -> TableRegistration:
    # 6 种 decision：coerce, drop_column, keep_as_text, fill_value,
    #                 remove_rows, skip（保持原样）
    # 清洗后注册到 DuckDB：conn.register(table_name, df) + CREATE TABLE AS SELECT *
    # 返回 TableRegistration 含 table_name, columns, row_count, preview
```

### 3.2 Blocking Issue 的用户决策流

```
前端 SchemaPanel                    后端 routes.py
─────────────                     ──────────────
显示 blocking issues     ←────    upload 返回 issues 列表
  ↓
用户选择每列的处理方式
  ↓
发送 PUT decisions      ────→    存储到 project["decisions"]
  ↓
点击 confirm            ────→    apply_decisions() + DuckDB 注册
  ↓
收到 active_tables      ←────    返回表名、列名、行数
  ↓
systemMode = 'chat'               可以开始分析了
```

### 3.3 Dataset Panel 重启恢复与快速复用

新增目标：开发调试时不重复上传同一批数据，且前后端重启后仍可直接恢复分析项目。

#### 前端恢复入口（UploadZone）

`SchemaPanel.tsx` 的 UploadZone 新增 debug 入口：`debug: choose existing dataset`。

点击后流程：

1. 请求 `GET /api/debug/projects`
2. 渲染可恢复项目列表（按 `updated_at` 倒序）
3. 用户选中后依次调用：
  - `projectStore.upsertProject(...)`
  - `projectStore.selectProject(projectId)`
  - `schemaStore.switchProject(projectId)`
  - `schemaStore.loadProjectSchema(projectId)`

这样可以在不上传文件的情况下重建 Dataset Panel 的核心状态（datasets、strategyVersion、systemMode）。

#### 后端恢复入口（routes bootstrap）

后端新增 `_bootstrap_project_from_db(project_id)`：

- 扫描 `data/processed/{project_id}.duckdb`
- 读取 `SHOW TABLES` + `PRAGMA table_info` 构建轻量 in-memory dataset 状态
- 标记 `confirmed=True`，并将 `strategy_version` 至少提升到 1

触发时机：

- `GET /api/projects/{project_id}/schema`
- `GET /api/analyze/stream`
- `GET /api/debug/projects`（批量发现 + 懒加载 bootstrap）

因此，即使后端内存态丢失，Dataset Panel 与分析流程也能从磁盘 DuckDB 自动恢复。

---

## 4. 面试常见问题

### Q: 为什么选择 DuckDB 而不是 SQLite 或 PostgreSQL？

DuckDB 是列式存储，分析查询（GROUP BY、聚合、窗口函数）比 SQLite 快 10-100 倍。不需要独立进程（嵌入式），一个 .duckdb 文件就是整个数据库。支持直接从 pandas DataFrame 导入，不需要逐行 INSERT。

### Q: LangGraph 在你的项目里解决了什么问题？

三个核心价值：
1. **条件路由** — `add_conditional_edges` 让 pipeline 根据运行时状态动态跳转（比如 Planner 决定不需要 viz 就跳过）
2. **状态传递** — `AgentState` TypedDict 让所有节点共享结构化数据，不需要自然语言传递（避免 LLM 转述丢失精度）
3. **重试循环** — Critic → retry → SQL Agent 的循环用条件边实现，最多 2 次，代码很简洁

### Q: SSE 相比 WebSocket 的优劣？

SSE 优势：原生浏览器支持（`EventSource`），自动重连，单向推送够用（我们不需要客户端在分析过程中发消息）。
SSE 劣势：只支持 GET（query 放 URL 参数），只能服务端→客户端。
我们的场景是"发一个 query，服务端逐步返回结果"，SSE 完美匹配。

### Q: 前端状态管理怎么做的？为什么有 6 个 store？

按职责拆分，避免一个 God Store：

| Store | 职责 | 大小 |
|-------|------|------|
| projectStore | 项目列表、活跃项目、项目 bootstrap | 小 |
| schemaStore | 数据集上传、类型推断、confirm、项目切换 cache | 中 |
| chatStore | 多项目多会话对话、exchange 管理、trace、reply | 中 |
| resultsStore | 图表/SQL/报告记录、两阶段 chart 管理、Tab 状态 | 中 |
| uiStore | Schema 面板折叠、侧边栏状态等 UI 状态 | 小 |
| datasetStore | 数据集版本管理、单元格编辑、快照/恢复 | 中 |

跨 store 通信用 `useStore.getState()` 在 action 内部访问，不在 selector 层引用其他 store（避免循环依赖和不可预测的渲染）。

### Q: 图表怎么从后端到前端渲染的？

```
1. submit 时: startChartRecord(query) → 占位卡片 (status='running')
2. Viz Agent (Python):
   ↓ LLM 选择 type/alt_types/title/x_label/y_label
   ↓ _build_series_from_rows() 确定性构建 series
   ↓ viz_result → SSE done event
3. done 到达:
   ↓ finalizeChartRecord(chartRecordId, data) → 填充占位卡片
4. ChartTab.tsx → ChartRenderer:
   ↓ seriesMeta + labelToKey 映射 (s_0, s_1...) 作为 Recharts dataKey
   ↓ 根据 activeType 选择 Recharts 组件 (Line/Bar/Area/Scatter/Pie)
   ↓ SortedTooltip 显示 xLabel: value + 各 series 值
```

类型切换（line/bar/pie/scatter）纯前端，不调后端——只改 `activeType`，Recharts 组件切换。前端用 `seriesMeta` 数组保存 `{key: 's_0', label: 'East', color: '#...'}` 映射关系。

### Q: Critic Agent 的重试是怎么实现的？

```python
# pipeline.py — 实际路由逻辑

def route_after_sql(state):
    if retry_count > 0:
        return "critic"  # 重试时跳过 Viz/Stats，直接验证修正后的 SQL

def route_after_critic(state):
    if verdict == "pass":
        if "viz" in plan and not state.get("viz_result"):
            return "viz_agent"  # 重试通过后补跑 Viz
        return "report"
    
    target_map = {"sql": "sql_agent", "planner": "planner", "both": "planner",
                  "viz": "viz_agent", "stats": "stats_agent"}
    return target_map.get(retry_target, "report")

def route_after_viz(state):
    if state.get("critic_verdict") == "pass":
        return "report"  # 补跑后直接出报告（Critic 已通过）
    return "stats_agent" or "critic"

# retry_count >= 2 时由 critic_agent 内部强制 verdict="pass"，非路由层控制
```

### Q: 导出功能怎么实现的？

```
前端纯 JS 实现，不依赖后端：

1. SVG 导出：从 Recharts DOM 提取 <svg>，clone + 注入背景色 + 注入标题（IBM Plex Mono, #3effa0）
   + 扩大 viewBox，translate 下移图形，添加 header rect + 分割线 → Blob → download
2. CSV 导出：tableData.headers + rows → 拼接字符串 → Blob → download
3. HTML 报告：buildHtml() 拼接完整 HTML（含内联 CSS），buildChartSvg() 从 series 数据生成 SVG
4. ZIP 打包：miniZip.ts 纯 JS 实现（STORE 方法 + CRC-32），不依赖任何库
```

### Q: 这个项目最复杂的部分是什么？

数据类型推断和用户决策流。看起来简单，但要处理：
- pandas 读入的类型 vs 实际类型（"123" 是数字还是 ID？）
- 推断顺序敏感（boolean → integer → year_like → float → date），每种有不同阈值
- 部分行可以转换、部分不行时怎么办（blocking/warning issue + 多种选项）
- 用户决策后重新 apply 到 DataFrame → 写入 DuckDB
- 数据集版本管理（快照、恢复、单元格编辑、导出）
- 清洗决策需要传递给所有后续 agent（quality_notes）

---

## 5. 代码阅读建议

### 推荐阅读顺序（由外到内）

```
第 1 层：入口和配置
  backend/api/main.py          ← FastAPI 启动，CORS，路由注册
  frontend/src/App.tsx          ← React 根组件，三栏布局
  frontend/vite.config.ts       ← 开发服务器配置，proxy

第 2 层：数据流骨架
  backend/api/routes.py         ← 所有 API 端点
  backend/api/sse.py            ← SSE 流式推送
  backend/graph/pipeline.py     ← LangGraph 图定义
  frontend/src/hooks/useAnalysisStream.ts  ← SSE 事件处理

第 3 层：Agent 逻辑
  backend/agents/planner.py     ← 意图理解 + 路由
  backend/agents/sql_agent.py   ← SQL 生成 + tool calling / text fallback
  backend/agents/viz_agent.py   ← 图表数据（LLM 选类型 + 确定性 series 构建）
  backend/agents/critic_agent.py ← 质量审核 + 重试路由
  backend/agents/report_agent.py ← 结论生成
  backend/agents/base.py        ← LLM 工厂 + provider 切换 + no_think()
  backend/config/prompts.py     ← 部分 prompt 集中管理（Planner/SQL）

第 4 层：数据处理
  backend/db/loader.py          ← 类型推断 + 清洗 + DuckDB 注册
  backend/db/sandbox.py         ← SQL 安全沙箱（正则黑名单，fetchall 无行数限制）
  backend/db/engine.py          ← DuckDB 连接管理（读写 + 只读）
  backend/db/versioning.py      ← 数据集版本管理（快照/恢复/导出）

第 5 层：前端组件
  frontend/src/stores/*.ts      ← 6 个 Zustand store
  frontend/src/components/chat/ChatPanel.tsx       ← 对话 UI
  frontend/src/components/schema/SchemaPanel.tsx   ← 数据上传
  frontend/src/components/results/chart/ChartTab.tsx ← 图表渲染（Recharts）
  frontend/src/components/results/dataset/*.tsx    ← 数据集管理 UI
```

### 修改一个 prompt 后怎么验证效果？

```bash
# 1. 改 prompts.py
# 2. 后端 --reload 自动重启
# 3. 前端刷新页面，问同一个问题
# 4. 看后端日志：
#    Planner decision: plan=..., direct=..., reason=...
#    Stats Agent: N tests, M outliers
#    Critic: verdict=..., feedback=...
#    Report Agent conclusion: ...
```

Planner 和 SQL Agent 的 prompt 在 `backend/config/prompts.py`。Viz/Stats/Critic/Report Agent 的 prompt 是内联在各自 agent 文件中的。

### 怎么新增一种图表类型（比如 heatmap）？

```
1. backend/agents/viz_agent.py → VIZ_SYSTEM prompt 的 "Available chart types" 加 "heatmap"
2. frontend/.../ChartTab.tsx → import HeatMapChart from recharts
3. ChartRenderer 组件 → 加一个 else if 分支
完成。不需要改 pipeline、store、SSE。
```

### 怎么新增一个 Agent（比如 Forecast Agent）？

```
1. backend/agents/forecast_agent.py → async def forecast_agent(state) → dict
2. backend/graph/pipeline.py → graph.add_node("forecast", forecast_agent)
                              → 加条件边连接到现有流程
3. backend/config/prompts.py → 加 FORECAST_SYSTEM prompt
4. backend/agents/planner.py → prompt 里加 "forecast" 选项
完成。前端不需要改（forecast 结果通过 report.conclusion 展示）。
```
