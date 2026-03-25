# c2d — Technical Deep Dive

面试用技术文档。从代码层面追踪数据流，解释每个模块的实现逻辑和设计决策。

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
const exchangeId = addExchange(query)  // chatStore 创建新 exchange，状态 = pending

const url = `/api/analyze/stream?project_id=${projectId}&query=${encodeURIComponent(query)}`
const eventSource = new EventSource(url)  // 浏览器原生 SSE 连接
```

**为什么用 EventSource 而不是 fetch？**
EventSource 自带事件类型分发（`addEventListener('progress', ...)`），不需要手动解析 SSE 格式。缺点是只支持 GET，但 query 参数放 URL 够用。

**为什么 exchange 的初始状态是 pending？**
pending → 前端显示 typing dots。收到第一条 SSE 事件后变 streaming → typing dots 被 ThinkingBlock 替代。

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
    project = _get_project(project_id)          # 从内存字典获取项目
    active_tables = build_table_context(project) # 构建表结构上下文
    
    return EventSourceResponse(
        run_analysis_stream(project_id, query, active_tables, quality_notes)
    )
```

**关键点**：`EventSourceResponse` 来自 `sse-starlette`，接收一个 async generator，每个 yield 的 dict 自动序列化为 SSE 格式（`event: xxx\ndata: {...}\n\n`）。

### Step 5: Pipeline 执行 → 逐节点流式推送

```
文件：backend/api/sse.py
函数：run_analysis_stream()
```

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
graph.add_edge("stats_agent", "critic")                      # 固定边
graph.add_conditional_edges("critic", route_after_critic)    # → report 或 retry
graph.add_edge("report", END)
```

**条件路由函数** 读取 AgentState 中的 `plan`、`sql_result`、`critic_verdict` 字段决定下一步。这是 LangGraph 的核心模式——节点之间的跳转逻辑在编译时定义，运行时根据 state 动态决定。

### Step 7: Planner Agent — 意图理解

```
文件：backend/agents/planner.py
函数：planner_agent(state) → dict
```

```python
# 1. 构建 prompt（注入表结构和清洗决策）
system = PLANNER_SYSTEM.format(active_tables=tables_text, quality_notes=quality_notes)

# 2. 一次 LLM 调用
response = await llm.ainvoke([SystemMessage(system), HumanMessage(query)])

# 3. 解析 JSON 输出
parsed = json.loads(response.content)
# 可能是 {"plan": ["sql", "viz"], "sql_task": "..."} 
# 或者   {"plan": [], "direct_answer": "这是一个..."}
```

**Planner 的两条路径**：
- `plan` 非空 → 返回 `sql_task` 等字段，pipeline 继续
- `plan` 为空 + `direct_answer` 非空 → 直接填充 `sql_result.answer`，pipeline 跳到 END

**为什么 Planner 能直接回答？**
它已经有表结构上下文（列名、行数、类型），"这是什么数据集" 类问题不需要查数据。省一次 SQL Agent 调用。

### Step 8: SQL Agent — Tool Calling 循环

```
文件：backend/agents/sql_agent.py
函数：sql_agent(state) → dict
```

```python
tools = create_sql_tools(conn)        # 创建绑定 DuckDB 连接的 run_query tool
llm_with_tools = llm.bind_tools(tools) # LangChain 的 tool binding

for iteration in range(MAX_ITERATIONS):  # 最多 3 轮
    response = await llm_with_tools.ainvoke(messages)
    
    if not response.tool_calls:
        break  # LLM 觉得够了，不再调工具
    
    for tc in response.tool_calls:
        result = await tool_map[tc["name"]].ainvoke(tc["args"])
        messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))
```

**Tool Calling 的工作原理**：
1. LLM 收到消息 + tool schema → 决定调用 `run_query(sql="SELECT ...")`
2. 我们执行 tool，把结果作为 `ToolMessage` 追加到 messages
3. LLM 看到结果 → 决定是否再调一次（比如修正 SQL 错误）或者停止

**SQL 沙箱**（`backend/db/sandbox.py`）：
```python
FORBIDDEN_PATTERNS = [DROP, ALTER, CREATE, INSERT, UPDATE, DELETE, ...]

def execute_sandboxed(conn, sql):
    for pattern in FORBIDDEN_PATTERNS:
        if pattern.search(sql): return {"error": "Forbidden"}
    result = conn.execute(sql)  # DuckDB 执行
```

所有 SQL 经过正则检查，只允许 SELECT。

### Step 9: DuckDB 查询

```
文件：backend/db/engine.py
```

```python
class DuckDBEngine:
    _connections: dict[str, duckdb.DuckDBPyConnection] = {}
    
    def get_connection(self, project_id: str):
        if project_id not in self._connections:
            db_path = f"data/processed/{project_id}.duckdb"
            self._connections[project_id] = duckdb.connect(db_path, read_only=True)
        return self._connections[project_id]
```

**每个项目一个 .duckdb 文件**，在 confirm 阶段由 `loader.py` 的 `apply_decisions()` 创建。
**连接池**：同一个 project_id 复用连接，避免重复打开文件。`read_only=True` 确保查询不会修改数据。

### Step 10: Viz Agent — 图表数据生成

```
文件：backend/agents/viz_agent.py
函数：viz_agent(state) → dict
```

```python
# 从 sql_result 构建数据预览
data_preview = format_rows(final_columns, final_rows[:30])

# LLM 选择图表类型 + 组装 series 数据
response = await llm.ainvoke([SystemMessage(VIZ_SYSTEM), HumanMessage("Generate chart data")])
chart_data = json.loads(response.content)

viz_result = {
    "type": "bar",
    "alt_types": ["pie"],
    "series": [{"name": "PS2", "x": [...], "y": [...]}],
    "table_data": {"headers": [...], "rows": [...]}
}
```

**为什么不用 Plotly config？**
LLM 生成 `{type, series}` 的准确率 >> 生成复杂的 Plotly `{data: [{x, y, mode, marker}], layout: {xaxis, yaxis, margin}}`。
前端用 Recharts 渲染，完全控制暗色主题样式。

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
```

**重试机制**：
```
Critic → "retry", target="sql"
  → pipeline 路由回 sql_agent
  → SQL Agent 重新执行（收到 critic_feedback）
  → 重新走 Viz → Stats → Critic
  → 最多 2 次重试
```

### Step 12: Report Agent — 结论生成

```
文件：backend/agents/report_agent.py
函数：report_agent(state) → dict
```

接收所有前序结果（sql_result + stats_result + critic_feedback），一次 LLM 调用生成结论。

```python
return {
    "sql_result": {**sql_result, "answer": conclusion},  # 把结论写入 answer 字段
    "report": {
        "conclusion": conclusion,
        "evidence": evidence,      # None 如果没有 stats tests
        "should_record": True,
    },
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
  if (data.viz_result) resultsStore.addChartRecord(...)
  if (data.sql_result) resultsStore.addSqlRecord(...)
  if (data.report.should_record) resultsStore.addReportRecord(...)
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
    user_query: str
    plan: list[str]
    sql_result: dict
    viz_result: dict | None
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
事件类型    时机           携带数据                     前端处理
─────────────────────────────────────────────────────────────────
progress    节点执行中/完成  {steps: [{agent, label, status}]}  更新 ThinkingBlock
result      SQL/Viz 产出    {type: "sql"|"viz", ...}          仅更新 chat 展示
done        pipeline 结束   {report, sql_result, viz_result}   写入 resultsStore
error       任何阶段失败    {code, message, agent}             显示错误
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
def parse_file(file_path: str) -> pd.DataFrame:
    if ext == '.csv': return pd.read_csv(path)
    if ext in ('.xlsx', '.xls'): return pd.read_excel(path)

# Step 2: infer_types() — 逐列推断真实类型
def infer_types(df) -> list[ColumnInference]:
    for col in df.columns:
        # pandas 读入的全是 object/string
        # 尝试转换：能转 float? 能转 date? 有多少失败的行？
        if try_numeric(col): inferred = "DOUBLE"
        elif try_date(col): inferred = "DATE"
        else: inferred = "VARCHAR"
        
        # 失败率 = 0 → auto_converted（自动转换，不需要用户确认）
        # 失败率 > 0 且 < threshold → blocking issue（需要用户选择处理方式）

# Step 3: scan_quality() — 检测数据质量问题
# null 百分比、唯一值数量、可能的 ID 列等

# Step 4: apply_decisions() — 根据用户选择清洗数据
def apply_decisions(df, decisions):
    for col, option in decisions.items():
        if option == "coerce": df[col] = pd.to_numeric(df[col], errors='coerce')
        elif option == "exclude": df = df.drop(columns=[col])
        elif option == "keep_as_text": pass  # 保持 VARCHAR
    
    # 写入 DuckDB
    conn.execute("CREATE TABLE ... AS SELECT * FROM df")
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

### Q: 前端状态管理怎么做的？为什么有 4 个 store？

按职责拆分，避免一个 God Store：

| Store | 职责 | 大小 |
|-------|------|------|
| projectStore | 项目列表、活跃项目 | 小 |
| schemaStore | 数据集上传、类型推断、confirm、项目切换 cache | 中 |
| chatStore | 对话消息、trace、reply | 中 |
| resultsStore | 图表/SQL/报告记录、Tab 状态 | 中 |

跨 store 通信用 `useStore.getState()` 在 action 内部访问，不在 selector 层引用其他 store（避免循环依赖和不可预测的渲染）。

### Q: 图表怎么从后端到前端渲染的？

```
Viz Agent (Python)
  ↓ LLM 输出 JSON: {type: "bar", series: [{name, x, y}]}
  ↓
SSE done event
  ↓ 前端解析 viz_result
  ↓
resultsStore.addChartRecord()
  ↓
ChartTab.tsx → ChartRenderer
  ↓ 根据 activeType 选择 Recharts 组件
  ↓
<BarChart data={chartData}>
  <Bar dataKey={seriesName} fill={color} />
</BarChart>
```

类型切换（line/bar/pie）纯前端，不调后端——只改 `activeType`，Recharts 组件切换。

### Q: Critic Agent 的重试是怎么实现的？

```python
# pipeline.py
def route_after_critic(state):
    if state["critic_verdict"] == "pass":
        return "report"        # 继续到 Report Agent
    target = state["retry_target"]  # "sql" / "viz" / "stats"
    return target_map[target]  # 路由回对应节点

# LangGraph 的条件边让这变成了一个合法的"回路"
# sql_agent → viz → stats → critic → sql_agent（如果 retry）
# 但 retry_count 限制最多 2 次，critic_agent 里强制 pass
```

### Q: 导出功能怎么实现的？

```
前端纯 JS 实现，不依赖后端：

1. SVG 导出：从 Recharts DOM 提取 <svg>，clone + 注入背景色 → Blob → download
2. CSV 导出：tableData.headers + rows → 拼接字符串 → Blob → download
3. HTML 报告：buildHtml() 拼接完整 HTML（含内联 CSS），buildChartSvg() 从 series 数据生成 SVG
4. ZIP 打包：miniZip.ts 纯 JS 实现（STORE 方法 + CRC-32），不依赖任何库
```

### Q: 这个项目最复杂的部分是什么？

数据类型推断和用户决策流。看起来简单，但要处理：
- pandas 读入的类型 vs 实际类型（"123" 是数字还是 ID？）
- 部分行可以转换、部分不行时怎么办（blocking issue + 3 种选项）
- 用户决策后重新 apply 到 DataFrame → 写入 DuckDB
- 多数据集时要检测 join key（待实现）
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
  backend/agents/sql_agent.py   ← SQL 生成 + tool calling
  backend/agents/viz_agent.py   ← 图表数据
  backend/agents/report_agent.py ← 结论生成
  backend/config/prompts.py     ← 所有 prompt 集中管理

第 4 层：数据处理
  backend/db/loader.py          ← 类型推断 + 清洗
  backend/db/sandbox.py         ← SQL 安全沙箱
  backend/db/engine.py          ← DuckDB 连接池

第 5 层：前端组件
  frontend/src/stores/*.ts      ← 4 个 Zustand store
  frontend/src/components/chat/ChatPanel.tsx       ← 对话 UI
  frontend/src/components/schema/SchemaPanel.tsx   ← 数据上传
  frontend/src/components/results/chart/ChartTab.tsx ← 图表渲染
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

所有 prompt 在 `backend/config/prompts.py` 一个文件里，改一个字就能测效果。

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
