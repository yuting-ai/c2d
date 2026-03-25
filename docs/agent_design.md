
# c2d — Agent Design

本文档是每个 agent 的实现规格书，覆盖 prompt 结构、工具注册、决策逻辑、输入/输出格式。对应后端 `backend/agents/*.py` 和 `backend/config/prompts.py` 的直接编写依据。

架构总览见 architecture.md Section 5-7。

---

## 1. Pipeline 总览

```
用户 query
    │
    ▼
┌─────────┐
│ Planner │ ─→ plan: ["sql", "viz", "stats"] 或 direct_answer
└────┬────┘
     │
     ├─→ plan 为空 → Planner 直接回答 → END
     │
     ▼
┌──────────┐
│SQL Agent │ ← 必须先跑，产出数据
└────┬─────┘
     │ sql_result 就绪
     │ 条件路由
     ▼
┌───────────┐
│ Viz Agent │  ← plan 含 "viz" 且有数据时激活，否则跳过
└─────┬─────┘
      ▼
┌────────────┐
│Stats Agent │  ← plan 含 "stats" 时激活，否则跳过
└──────┬─────┘
       ▼
┌───────────┐
│  Critic   │ ─→ pass: 继续 / retry: 打回指定 worker
└─────┬─────┘    （最多 retry 2 次）
      ▼
┌───────────┐
│  Report   │ ─→ 结论 + evidence + should_record
└───────────┘
```

 **实际执行路径** （由 `pipeline.py` 条件路由控制）：

```python
route_after_planner:  plan 为空 → END | "sql" in plan → sql_agent
route_after_sql:      error/无数据 → report | "viz" in plan → viz_agent | "stats" in plan → stats_agent | → critic
route_after_viz:      "stats" in plan → stats_agent | → critic
route_after_critic:   pass → report | retry → 打回目标 agent
```

注：设计上 Viz 和 Stats 可以并行（互不依赖），当前实现为顺序执行（LangGraph 简化）。后续可改为 `fan-out` 并行执行。

---

## 2. Planner Agent

 **文件** ：`backend/agents/planner.py`

 **角色** ：理解用户意图，决定回答方式——直接回答（schema 元数据问题）或激活 worker agents（数据分析问题），执行 WARNING 列交叉检查。

 **工具** ：无（纯推理）

### 2.1 Prompt 结构

```
[System]
You are a data analysis planner. Your job is to understand the user's question
and decide how to answer it.

You have two options:

OPTION 1 — DIRECT ANSWER (no agents needed):
Use when the question can be answered from the table schema alone.
Examples: "what is this dataset about", "what columns are available",
"what does the X column mean", conceptual questions, clarifications.

OPTION 2 — ACTIVATE AGENTS (need to query data):
Use when the question requires actual data retrieval or computation.
Examples: "top 5 products by sales", "monthly revenue trend", "compare A vs B".

Available agents for Option 2:
- sql: Generates and executes SQL queries against DuckDB tables
- viz: Creates charts and visualizations (Plotly)
- stats: Runs statistical tests, detects outliers, computes significance

Available tables:
{active_tables}                    ← 从 AgentState.active_tables 注入

Data quality notes:
{quality_notes}                    ← 已应用的清洗决策

[User]
{user_query}

[Instructions]
Respond with a JSON object:

For OPTION 1 (direct answer):
{
  "plan": [],
  "direct_answer": "Your answer here based on schema context",
  "reasoning": "This is a meta/conceptual question"
}

For OPTION 2 (activate agents):
{
  "plan": ["sql", "viz"],           // 要激活的 agent 列表
  "sql_task": "...",                // SQL Agent 的任务描述
  "viz_task": "...",                // Viz Agent 的任务描述（如激活）
  "stats_task": "...",              // Stats Agent 的任务描述（如激活）
  "involved_columns": ["col1"],     // 本次分析涉及的列名
  "reasoning": "..."                // 决策推理过程（调试用）
}
```

### 2.2 决策逻辑

```python
async def planner_agent(state: AgentState) -> dict:
    # 1. 组装 prompt：注入 active_tables、quality_notes
    # 2. LLM 推理，解析 JSON 输出
    # 3. 判断回答方式

    plan = parsed.get("plan", [])
    direct_answer = parsed.get("direct_answer")

    # ── 直接回答路径：不需要任何 worker ──
    if not plan and direct_answer:
        return {
            "plan": [],
            "sql_result": {
                "steps": [], "final_rows": [], "final_columns": [],
                "error": None, "answer": direct_answer,
            },
            "stream_events": [progress_event],
        }

    # ── Worker 激活路径 ──
    # WARNING 交叉检查（Phase 4 实现）
    # Stats Agent 条件激活（Phase 4 实现）

    return {
        "plan": plan if plan else ["sql"],
        "sql_task": parsed.get("sql_task", state["user_query"]),
        "viz_task": parsed.get("viz_task"),
        "stats_task": parsed.get("stats_task"),
        "involved_columns": parsed.get("involved_columns", []),
        "stream_events": [progress_event],
    }
```

Pipeline 路由在 `pipeline.py` 中实现：

```python
def route_after_planner(state: AgentState) -> str:
    if not state.get("plan"):
        return END               # 直接回答，跳过所有 worker
    if "sql" in state["plan"]:
        return "sql_agent"
    return END
```

### 2.3 Stats 激活判断标准

| 用户问题模式          | 激活 Stats？ | 原因                     |
| --------------------- | ------------ | ------------------------ |
| "哪个地区增长最快"    | ✅           | 趋势判断需要 r²、p 值   |
| "A 和 B 有显著差异吗" | ✅           | 差异比较需要 t-test      |
| "有没有异常值"        | ✅           | 直接问异常检测           |
| "上月销售额多少"      | ❌           | 简单查询，数字本身是事实 |
| "Top 5 产品"          | ❌           | 排序结果，无需检验       |
| "各品类占比"          | ❌           | 描述性拆解，无统计判断   |

### 2.4 输出 → AgentState

```python
# 直接回答路径
state.plan = []
state.sql_result = {"answer": "这是一个视频游戏销售数据集..."}

# Worker 激活路径
state.plan = ["sql", "viz", "stats"]
state.sql_task = "Query monthly revenue by region for the past 12 months"
state.viz_task = "Create multi-region line chart showing monthly trends"
state.stats_task = "Test significance of regional growth trends, detect outliers"
```

### 2.5 SSE Trace 命名

所有 agent 推送的 SSE progress 事件中，`agent` 字段统一使用 `"analyst"`，不暴露内部 agent 名称给用户。步骤 label 使用自然语言描述：

```python
# Planner 推送
{"agent": "analyst", "label": "planning analysis", "status": "done"}

# SQL Agent 推送
{"agent": "analyst", "label": "querying data · step 1", "status": "active"}
{"agent": "analyst", "label": "querying data · 2 queries", "status": "done"}

# Report Agent 推送
{"agent": "analyst", "label": "writing conclusion", "status": "done"}

# Planner 直接回答
{"agent": "analyst", "label": "answering from schema context", "status": "done"}
```

前端显示为统一的 "analyst" 头像 + thinking block，用户感知上是在和一个分析师对话，不需要关心内部有几个 agent。

---

## 3. SQL Agent

 **文件** ：`backend/agents/sql_agent.py`

 **角色** ：自主生成 SQL，执行查询，处理报错并修正。

 **工具** ：`run_query`、`validate_sql`、`explain_query`

### 3.1 Prompt 结构

```
[System]
You are a SQL analyst. Generate DuckDB-compatible SQL to answer the given task.

Tables available:
{active_tables_with_schema}        ← 表名、列名、类型、样本值、null 率

Join relationships:
{join_keys}                        ← 已确认的 join key

Data quality notes:
{quality_notes}                    ← 已应用的清洗决策（如 "amount: non-numeric → null"）

Excluded columns (do NOT use):
{excluded_columns}                 ← 用户选择 exclude 的列

Rules:
- Use DuckDB SQL dialect (DATE_TRUNC, STRFTIME, etc.)
- Always qualify column names with table alias when joining
- Respect null handling decisions — if a column has nulls from cleaning,
  note this in your reasoning
- If a query fails, analyze the error and retry with a corrected version
- Maximum 3 tool calls per task

[Task]
{sql_task}                         ← 来自 Planner
```

### 3.2 Tool 定义

```python
@tool
def run_query(sql: str) -> dict:
    """Execute a SQL query against the DuckDB database.
  
    Args:
        sql: DuckDB-compatible SQL query string
      
    Returns:
        {"columns": [...], "rows": [...], "row_count": N, "execution_ms": N}
        On error: {"error": "error message", "sql": "original query"}
    """

@tool
def validate_sql(sql: str) -> dict:
    """Validate SQL syntax without executing. Use before complex queries.
  
    Returns:
        {"valid": true} or {"valid": false, "error": "syntax error at..."}
    """

@tool
def explain_query(sql: str) -> dict:
    """Get the query execution plan. Use to check if a query will be efficient.
  
    Returns:
        {"plan": "...execution plan text..."}
    """
```

### 3.3 Agent Loop（Tool Calling）

```python
async def sql_agent(state: AgentState) -> AgentState:
    messages = [system_prompt, HumanMessage(state.sql_task)]
    tools = [run_query, validate_sql, explain_query]
  
    max_iterations = 3
    for i in range(max_iterations):
        response = await llm.bind_tools(tools).ainvoke(messages)
      
        if not response.tool_calls:
            # LLM 决定不调用工具，直接返回推理结果
            break
      
        for tool_call in response.tool_calls:
            result = await execute_tool(tool_call)
            messages.append(ToolMessage(result, tool_call_id=...))
          
            # 推送 SSE progress
            emit_sse("progress", {
                "agent": "SQL Agent",
                "label": f"step {i+1}",
                "status": "done" if not result.get("error") else "active"
            })
      
        messages.append(response)
  
    # 提取最终 SQL 和结果
    return state.update(
        sql_result={
            "steps": collected_steps,    # 每步的 SQL + 结果
            "final_rows": last_result["rows"],
            "final_columns": last_result["columns"],
            "error": None
        }
    )
```

### 3.4 错误处理策略

```
第 1 次执行失败：
  → LLM 收到 error message → 分析原因 → 修正 SQL → 重试

第 2 次执行失败：
  → LLM 再次分析 → 可能换一种查询方式（如拆成子查询）→ 重试

第 3 次仍失败：
  → 放弃，返回 error → Critic Agent 标记失败 → 前端显示错误信息

常见错误模式：
  - 列名拼写错误 → LLM 对比 schema 修正
  - JOIN 缺失 → LLM 添加 JOIN clause
  - 类型不匹配 → LLM 添加 CAST
  - 空结果 → LLM 放宽 WHERE 条件或解释"没有符合条件的数据"
```

### 3.5 输出格式

```python
sql_result = {
    "steps": [
        {
            "title": "query · step 1 of 2",
            "sql": "SELECT region, DATE_TRUNC('month', sale_date) AS month...",
            "tag": "SQL Agent",
            "row_count": 36,
            "execution_ms": 8
        },
        {
            "title": "query · step 2 of 2",
            "sql": "WITH monthly AS (...) SELECT *, ROUND(...) AS mom_growth...",
            "tag": "SQL Agent",
            "row_count": 36,
            "execution_ms": 5
        }
    ],
    "final_rows": [[...], ...],
    "final_columns": ["region", "month", "total_revenue", "mom_growth"],
    "error": None
}
```

---

## 4. Viz Agent

 **文件** ：`backend/agents/viz_agent.py`

 **角色** ：根据 SQL 结果选择图表类型，输出结构化 series 数据供前端 Recharts 渲染。

 **工具** ：无（纯推理，输出结构化 JSON，不生成 Plotly config）

 **方案选型** ：采用方案 C（后端出结构化数据，前端用轻量库渲染），而非 Plotly config 或后端 SVG。LLM 生成简单 JSON 的准确率远高于复杂的 Plotly config，前端完全控制样式和交互。

### 4.1 Prompt 结构

```
[System]
You are a data visualization specialist. Based on the SQL query results,
choose the best chart type and output structured data for rendering.

Available chart types: line, area, bar, pie, scatter

Data from SQL query:
Columns: {columns}
Data (first 30 rows): {data_preview}
Total rows: {row_count}

User's original question: {user_query}

Rules:
- Choose the chart type that best communicates the data story
- Output alt_types: 2-3 alternative types that also make sense
- For time series → prefer line, alt: [area, bar]
- For categories (≤7) → prefer bar, alt: [pie]
- For categories (>7) → prefer bar, alt: []
- For two continuous variables → prefer scatter
- For composition/proportion → prefer pie, alt: [bar]

Respond with JSON only:
{
  "type": "line",
  "alt_types": ["area", "bar"],
  "title": "Monthly Revenue by Region",
  "x_label": "Month",
  "y_label": "Revenue",
  "series": [
    {"name": "East", "x": ["Jan", "Feb"], "y": [124800, 138200]}
  ]
}
```

### 4.2 条件激活

Pipeline 中 Viz Agent 的激活由两层控制：

```python
# 1. Planner 决定是否需要 viz
plan: ["sql", "viz"]  →  viz 在 plan 中

# 2. route_after_sql 检查数据可用性
def route_after_sql(state):
    if sql_result.error or not sql_result.final_rows:
        return "report"      # 无数据，跳过 viz
    if "viz" not in plan:
        return "critic"       # 不需要 viz
    return "viz_agent"        # 执行 viz
```

### 4.3 输出格式

```python
viz_result = {
    "type": "line",                    # LLM 选择的默认类型
    "alt_types": ["area", "bar"],      # 备选类型（table 由前端固定添加）
    "title": "Monthly Revenue by Region",
    "x_label": "Month",
    "y_label": "Revenue",
    "series": [                        # 前端 Recharts 直接消费
        {"name": "East", "x": ["Jan","Feb",...], "y": [124800, 138200, ...]},
        {"name": "North", "x": ["Jan","Feb",...], "y": [208400, 210100, ...]},
    ],
    "table_data": {                    # table 视图 + CSV 导出数据源
        "headers": ["month", "East", "North"],
        "rows": [["Jan", 124800, 208400], ...]
    }
}
```

### 4.4 前端渲染

前端使用  **Recharts** （~200KB，vs Plotly ~3MB）渲染，在 `ChartTab.tsx` 的 `ChartRenderer` 中根据 `activeType` 选择组件：

```
line    → <LineChart>     折线图
area    → <AreaChart>     面积图
bar     → <BarChart>      柱状图（单 series 每柱不同颜色）
pie     → <PieChart>      饼图
scatter → <ScatterChart>  散点图
table   → <DataTable>     表格视图（前端固定添加）
```

类型切换纯前端，不重新调后端。导出支持 SVG（图表模式）和 CSV（table 模式）。

---

## 5. Stats Agent

 **文件** ：`backend/agents/stats_agent.py`

 **角色** ：选择统计方法，用 scipy 执行检验，检测异常值。仅当 Planner 激活时才运行。

 **工具** ：无（LLM 决定测试计划，Python 直接用 scipy/numpy 执行）

### 5.1 两阶段执行

```
阶段 1：LLM 决定跑哪些测试（纯推理，输出 JSON 计划）
阶段 2：Python 按计划执行 scipy 函数（无 LLM 调用）
```

这比让 LLM 调用 tool 更可靠——LLM 只负责"选什么测试"，不负责"怎么执行"。

### 5.2 LLM 测试计划 Prompt

```
Available analyses:
- trend_test: Test if a numeric series has a significant trend (linear regression)
- compare_groups: Compare two or more groups (t-test or ANOVA)
- detect_outliers: Find values beyond 2σ from mean
- correlation: Test correlation between two numeric columns

Respond with JSON:
{
  "analyses": [
    {"type": "trend_test", "column_x": "year", "column_y": "count"}
  ]
}
```

### 5.3 执行逻辑

```python
# trend_test → scipy.stats.linregress
slope, intercept, r, p, se = sp_stats.linregress(x, y)
tests.append({"key": "trend significance", "value": f"p = {p:.4f}", "significant": p < 0.05})
tests.append({"key": "r² (linear fit)", "value": f"{r**2:.3f}"})

# compare_groups → scipy.stats.ttest_ind
t_stat, p = sp_stats.ttest_ind(group_a, group_b)

# detect_outliers → z-score > 2σ
z_scores = np.abs((values - mean) / std)
outlier_mask = z_scores > 2

# correlation → scipy.stats.pearsonr
r, p = sp_stats.pearsonr(x, y)
```

### 5.3 输出格式

```python
stats_result = {
    "tests": [
        {"key": "game count trend significance", "value": "p = 0.0012", "significant": True},
        {"key": "trend r² (linear fit)", "value": "0.847"},
        {"key": "trend direction", "value": "increasing (15.2/step)"},
    ],
    "outliers": [
        {"icon": "△", "text": "count: 2008 = 1428 (z = 2.3)"},
    ],
    "summary": {
        "count": {"mean": 584.2, "median": 502.0, "std": 312.8, "min": 9.0, "max": 1428.0}
    }
}
```

### 5.4 Evidence 生成规则

Stats Agent 的输出不直接渲染到前端。Report Agent 根据以下规则决定是否生成 evidence section：

```
stats_result.tests 非空  → 生成 evidence section（琥珀色卡片）
  → tests 逐条渲染，significant=true 绿色高亮
  → outliers 用 △ 标记

stats_result.tests 为空  → 不生成 evidence section
  → summary 数据由 Report Agent 融入结论文本
```

---

## 6. Critic Agent

 **文件** ：`backend/agents/critic_agent.py`

 **角色** ：审核 worker 输出的逻辑一致性和数据支撑，决定通过或打回重试。

 **工具** ：无（纯推理）

### 6.1 Prompt 结构

```
[System]
You are a data analysis critic. Review the analysis results and check for
logical consistency, data quality issues, and unsupported claims.

User's original question:
{user_query}

SQL results:
{sql_result}

Visualization:
{viz_result.type} chart with {len(viz_result.table_data.rows)} data points

Statistical analysis:
{stats_result}

Data quality context:
{quality_notes}                    ← 已应用的清洗决策

Retry context:
Attempt: {retry_count + 1} of 3
{critic_feedback if retry_count > 0}  ← 上次打回的原因（重试时）

[Instructions]
Check the following:
1. Does the SQL query correctly answer the user's question?
2. Are the numbers in the conclusion supported by the query results?
3. Is the chart type appropriate for the data?
4. Are statistical claims backed by test results?
5. Are there null value issues that need transparency notes?

Respond with JSON:
{
  "verdict": "pass" | "retry",
  "target": "sql" | "viz" | "stats",   // 打回哪个 agent（retry 时）
  "feedback": "...",                     // 打回原因 / 通过时的质量说明
  "transparency_notes": [                // 涉及 null 列时的透明度说明
    "channel has 149 null values (1.2%) excluded from this analysis"
  ],
  "reasoning": "..."                     // 审核推理过程（调试用）
}
```

### 6.2 审核检查清单

```
1. SQL 正确性
   - 查询的列和条件与问题匹配
   - JOIN 关系正确
   - 聚合粒度正确（月/季/年）
   - WHERE 条件没有遗漏

2. 数据支撑
   - 结论中的数字可以从 SQL 结果推导出来
   - 百分比计算正确（分母是什么）
   - 排名/排序与数据一致

3. 图表匹配
   - 图表类型与数据结构匹配
   - 坐标轴标签正确
   - 图例与数据系列对应

4. 统计严谨性
   - "显著"有 p 值支撑
   - "趋势"有 r² 支撑
   - 置信区间合理

5. 透明度
   - 涉及 keep_null 列 → 追加说明
   - 涉及 excluded 列 → 不应出现在结论中
```

### 6.3 重试逻辑

```python
async def critic_agent(state: AgentState) -> AgentState:
    if state.retry_count >= 2:
        # 超过重试上限，强制通过但标记为低置信度
        return state.update(
            critic_verdict="pass",
            critic_feedback="Passed after max retries — results may need manual verification"
        )
  
    result = await llm.ainvoke(critic_prompt)
    parsed = parse_json(result)
  
    if parsed["verdict"] == "retry":
        return state.update(
            critic_verdict="retry",
            critic_feedback=parsed["feedback"],
            retry_target=parsed["target"],    # 哪个 agent 需要重做
            retry_count=state.retry_count + 1
        )
  
    return state.update(
        critic_verdict="pass",
        critic_feedback=parsed["feedback"],
        transparency_notes=parsed.get("transparency_notes", [])
    )
```

### 6.4 打回路由

```
critic_verdict = "retry", target = "sql"
  → SQL Agent 重新执行，收到 critic_feedback 作为额外指令
  → Viz Agent 和 Stats Agent 等待新的 SQL 结果

critic_verdict = "retry", target = "viz"
  → Viz Agent 重新执行，数据不变，只改图表
  → SQL 和 Stats 结果保留

critic_verdict = "retry", target = "stats"
  → Stats Agent 重新执行
  → SQL 和 Viz 结果保留
```

---

## 7. Report Agent

 **文件** ：`backend/agents/report_agent.py`

 **角色** ：整合所有 worker 输出，生成自然语言结论。用户的语言跟随用户提问（中文问中文答）。

 **工具** ：无（Phase 3）；`write_file`（Phase 4 导出用）

### 7.1 Phase 3 实现（当前）

当前 Report Agent 只接收 SQL 结果，写出 2-4 句结论。一次 LLM 调用，不涉及 tool calling。

```
[System]
You are a data analyst writing a conclusion for your team.
You receive a user's question and the SQL query results. Write a clear, concise answer.

Rules:
- Answer the user's question directly in 2-4 sentences
- Highlight key numbers and trends
- If the data shows something surprising or noteworthy, mention it
- Use natural language, not bullet points
- If the query returned no results or errored, explain what happened
- Reply in the same language as the user's question

User's question:
{user_query}

Table context:
{active_tables}

SQL results:
{sql_summary}                      ← 列名 + 前 30 行 + SQL 语句
```

```python
async def report_agent(state: AgentState) -> dict:
    # 1. 从 sql_result 构建可读的数据摘要
    # 2. 一次 LLM 调用生成结论
    # 3. 返回 conclusion + should_record 判断

    return {
        "sql_result": {**sql_result, "answer": conclusion},
        "report": {
            "conclusion": conclusion,
            "should_record": bool(final_rows),
            "strategy_version": 1,
        },
        "should_record": bool(final_rows),
        "stream_events": [progress_event],
    }
```

### 7.2 Phase 4 扩展计划

Phase 4 Report Agent 将扩展为接收所有 worker 输出（SQL + Viz + Stats + Critic），生成结构化报告：

```
扩展输入：
  - sql_result      → 数据结论
  - viz_result      → 嵌入图表 SVG
  - stats_result    → evidence section（条件生成）
  - critic_feedback → 审核意见

扩展输出：
  - title           → 记录标题（≤10 words）
  - conclusion      → 结论文本
  - evidence        → {tests, anomalies} | null
  - should_record   → 是否追加到 report_records
  - chart_svg       → 嵌入图表
```

### 7.3 记录判断逻辑

```python
def should_record(state: AgentState, report_output: dict) -> bool:
    # 规则一：agent 自己的判断
    if not report_output["should_record"]:
        return False
  
    # 规则二：硬性条件
    has_sql = state.sql_result and not state.sql_result.get("error")
    has_viz = state.viz_result is not None
    has_stats = state.stats_result and len(state.stats_result.get("tests", [])) > 0
  
    return has_sql or has_viz or has_stats
```

### 7.4 完整输出格式（Phase 4 目标）

```python
# 完整输出（推送为 SSE record 事件 + done 事件）
report = {
    "id": 3,
    "title": "Online vs offline channel divergence",
    "query": state.user_query,
    "time": "14:45",
    "conclusion": "Online channel revenue is 38% higher than offline...",
    "critic_note": "Divergence trend confirmed. Recommend checking...",
    "chart_svg": state.viz_result["svg"],
    "chart_config": {
        "default_type": state.viz_result["type"],
        "alt_types": state.viz_result["alt_types"],
        "configs": {
            state.viz_result["type"]: state.viz_result["plotly_config"],
            **state.viz_result["alt_configs"]
        },
        "table_data": state.viz_result["table_data"]
    },
    "sql_steps": state.sql_result["steps"],
    "evidence": report_output["evidence"],  # null if no tests
    "starred": False,
    "strategy_version": state.strategy_version,
    "status": "done"
}
```

### 7.5 不记录时的输出

```python
# should_record = false → 仅推送 done 事件，不推送 record 事件
done_event = {
    "exchange_id": state.exchange_id,
    "report": {
        "conclusion": "The 'channel' column contains the sales channel...",
        "should_record": False,
        "strategy_version": state.strategy_version
    }
}
```

---

## 8. Base Agent

 **文件** ：`backend/agents/base.py`

提供 `get_llm()` 工厂函数，根据 settings 创建对应的 LLM 客户端。每个 agent 是独立的 async 函数，不使用类继承。

```python
from langchain_openai import ChatOpenAI
from backend.config.settings import settings

def get_llm(temperature: float = 0) -> ChatOpenAI:
    """Get LLM instance based on settings."""
    if settings.LLM_PROVIDER == "deepseek":
        return ChatOpenAI(
            model=settings.LLM_MODEL,
            api_key=settings.DEEPSEEK_API_KEY,
            base_url=settings.DEEPSEEK_BASE_URL,
            temperature=temperature,
        )
    elif settings.LLM_PROVIDER == "anthropic":
        return ChatOpenAI(
            model=settings.LLM_MODEL,
            api_key=settings.ANTHROPIC_API_KEY,
            base_url="https://api.anthropic.com/v1/",
            temperature=temperature,
        )
```

每个 agent 的签名统一为 `async def xxx_agent(state: AgentState) -> dict`，返回需要更新的 state 字段。LangGraph 自动合并返回值到 AgentState。

---

## 9. Tool Registry

 **文件** ：`backend/tools/registry.py`

集中管理所有工具的注册和路由。

```python
from backend.tools.sql_tools import run_query, validate_sql, explain_query
from backend.tools.viz_tools import plot_line, plot_bar, plot_scatter, plot_heatmap, plot_pie, plot_area
from backend.tools.stats_tools import t_test, correlation, detect_outliers, describe
from backend.tools.data_tools import write_file

# 按 agent 分组注册
TOOL_REGISTRY = {
    "sql": [run_query, validate_sql, explain_query],
    "viz": [plot_line, plot_bar, plot_scatter, plot_heatmap, plot_pie, plot_area],
    "stats": [t_test, correlation, detect_outliers, describe],
    "report": [write_file],
}

def get_tools(agent_name: str) -> list:
    """Get registered tools for an agent."""
    return TOOL_REGISTRY.get(agent_name, [])

async def execute(tool_name: str, args: dict) -> str:
    """Route and execute a tool call by name."""
    all_tools = {t.name: t for tools in TOOL_REGISTRY.values() for t in tools}
    tool = all_tools.get(tool_name)
    if not tool:
        raise ValueError(f"Unknown tool: {tool_name}")
    return await tool.ainvoke(args)
```

新增工具只需：

1. 在对应的 `*_tools.py` 文件中用 `@tool` 装饰器定义函数
2. 在 `registry.py` 中 import 并添加到对应 agent 的工具列表
3. Agent 自动获得新工具的能力（通过 schema 感知）

---

## 10. LangGraph Pipeline

 **文件** ：`backend/graph/pipeline.py`、`backend/graph/router.py`、`backend/graph/state.py`

### 10.1 Graph 结构

```python
from langgraph.graph import StateGraph, END

def build_pipeline():
    graph = StateGraph(AgentState)
  
    # 节点
    graph.add_node("planner", planner_agent)
    graph.add_node("sql_agent", sql_agent)
    graph.add_node("viz_agent", viz_agent)
    graph.add_node("stats_agent", stats_agent)
    graph.add_node("critic", critic_agent)
    graph.add_node("report", report_agent)
  
    # 入口
    graph.set_entry_point("planner")
  
    # Planner → SQL（质量检查通过后）
    graph.add_conditional_edges("planner", route_after_planner)
  
    # SQL → fan-out: Viz + Stats 并行（条件路由）
    graph.add_conditional_edges("sql_agent", route_after_sql)
  
    # Viz / Stats → Critic（reducer 合并后）
    graph.add_edge("viz_agent", "critic")
    graph.add_edge("stats_agent", "critic")
  
    # Critic → 条件路由
    graph.add_conditional_edges("critic", route_after_critic)
  
    # Report → END
    graph.add_edge("report", END)
  
    return graph.compile()
```

### 10.2 路由函数

```python
def route_after_planner(state: AgentState) -> str:
    """Planner → SQL Agent (or END if quality blocked)."""
    if state.get("quality_blocked"):
        return END  # 被 WARNING 列阻断，等待用户决策
  
    if "sql" in state.plan:
        return "sql_agent"
  
    return END  # 没有 SQL 任务（罕见，如纯概念问题）

def route_after_sql(state: AgentState) -> list[str]:
    """SQL 完成后 fan-out: Viz + Stats 并行。"""
    if state.sql_result and state.sql_result.get("error"):
        # SQL 失败，跳过 Viz/Stats，直接进 Critic 处理
        return ["critic"]
  
    agents = []
    if "viz" in state.plan:   agents.append("viz_agent")
    if "stats" in state.plan: agents.append("stats_agent")
  
    # 如果 Planner 只激活了 SQL（无 viz/stats），直接进 Critic
    return agents or ["critic"]

def route_after_critic(state: AgentState) -> str:
    """Critic routing: pass → report, retry → target worker."""
    if state.critic_verdict == "pass":
        return "report"
  
    # Retry — route back to the specific agent
    target_map = {
        "sql": "sql_agent",
        "viz": "viz_agent",
        "stats": "stats_agent"
    }
    return target_map.get(state.retry_target, "report")
```

### 10.3 State Reducer

```python
# AgentState 的 worker 输出字段使用 reducer 合并策略：
# SQL Agent 先行，其输出不涉及并行冲突
# Viz + Stats 并行时，每个 worker 只更新自己的字段
# reducer 策略：last-write-wins（每个字段只有一个 writer）

# sql_result   ← SQL Agent 写入（串行阶段，无冲突）
# viz_result   ← Viz Agent 写入（并行阶段）
# stats_result ← Stats Agent 写入（并行阶段）
# Viz 和 Stats 写入不同字段，不存在冲突
```

---

## 11. Prompt 管理

 **文件** ：`backend/config/prompts.py`

所有 prompt 模板集中管理，不散落在 agent 文件中。

```python
# prompts.py

PLANNER_SYSTEM = """You are a data analysis planner..."""

SQL_AGENT_SYSTEM = """You are a SQL analyst..."""

VIZ_AGENT_SYSTEM = """You are a data visualization specialist..."""

STATS_AGENT_SYSTEM = """You are a statistical analyst..."""

CRITIC_SYSTEM = """You are a data analysis critic..."""

REPORT_SYSTEM = """You are a report writer..."""

# 通用片段（多个 prompt 共用）
TABLE_SCHEMA_TEMPLATE = """
Table: {name} ({row_count} rows)
Columns:
{columns_formatted}
"""

QUALITY_NOTES_TEMPLATE = """
Data quality decisions applied:
{decisions_formatted}
"""
```

Agent 文件通过 import 引用：

```python
# sql_agent.py
from backend.config.prompts import SQL_AGENT_SYSTEM, TABLE_SCHEMA_TEMPLATE
```

修改 prompt 只需编辑 `prompts.py` 一个文件，不需要找遍所有 agent。配合 eval 框架，修改后立即跑回归测试验证效果。

---

## 12. 关键实现备注

**为什么 agent 之间通过 AgentState 传数据而不是自然语言？**
自然语言传递会引入 LLM 理解偏差——SQL Agent 输出的数字经过 Critic Agent 的自然语言转述后可能丢失精度。结构化的 `sql_result`、`viz_result`、`stats_result` 字段确保数据精确传递，每个 agent 读到的是原始结果而非二次解读。

**为什么 Planner 不调用工具？**
Planner 的职责是任务分解和路由，不涉及数据操作。如果 Planner 也能调用工具（如提前查询 schema），会模糊 Planner 和 SQL Agent 的边界。保持 Planner 纯推理，让它专注于"怎么拆解这个问题"，不操心"数据长什么样"。

**为什么 Stats Agent 是条件激活而不是每次都跑？**
Stats Agent 的输出用于生成 evidence section。如果每次都跑，简单查询（"上月销售额多少"）也会附带一堆 p 值和异常检测，对用户是噪音。Planner 通过问题模式判断是否需要统计支撑，只在有意义时激活。

**为什么 Critic 最多重试 2 次？**
无限重试会导致用户长时间等待。2 次重试足够修复常见错误（SQL 语法、列名拼写），如果 3 次仍失败，问题大概率出在用户问题本身（如请求的数据不存在），继续重试不会改善结果。超限后 Critic 强制通过并标记低置信度，让用户自己判断。

**为什么 prompt 集中管理而不是写在各 agent 文件里？**
一是修改方便——调 prompt 是最频繁的操作，集中在一个文件不需要在 6 个 agent 文件里来回跳。二是 eval 验证——改了 prompt 后跑 `eval/runner.py` 回归测试，能立刻看到哪些 case 受影响。三是避免重复——`TABLE_SCHEMA_TEMPLATE` 被 SQL Agent、Viz Agent、Stats Agent 共用，不需要在三个文件里各写一份。

**为什么 Planner 能直接回答而不是加一个 Router？**
Planner 已经有完整的 schema 上下文（表名、列名、行数、清洗决策），回答"这是什么数据"不需要额外信息，也不需要额外的 LLM 调用。在同一次调用里判断"直接回答"还是"激活 worker"，是"理解意图"的自然延伸。如果未来分类准确率不够，可以在前面加一层轻量 Router，Planner 的接口不变。

**为什么对用户统一展示为 "analyst" 而不是暴露各 agent 名字？**
用户不关心内部有几个 agent、各自叫什么。对用户来说，整个系统是"一个分析师在帮我做事"。trace 里显示 "planning analysis → querying data → writing conclusion" 比 "Planner done → SQL Agent active → Report Agent active" 更直观。前端只需要一个头像 + 一个 thinking block，不需要为每个 agent 画不同的 UI。

**为什么 Report Agent 是独立节点而不是让 SQL Agent 自己总结？**
SQL Agent 的 prompt 专注于"写出正确的 SQL 并执行"，如果同时要求"用自然语言总结结果"，两个目标会互相干扰——LLM 可能为了措辞好看而牺牲 SQL 正确性，或者为了 SQL 正确而给出干巴巴的总结（如 "Analysis complete."）。拆成两个节点，SQL Agent 只管查数据，Report Agent 拿到完整结果后专注写人话。Phase 4 扩展时，Report Agent 还会接收 Viz/Stats/Critic 的输出，职责天然适合在 pipeline 末尾。

---

## 小模型兼容性改造（2025-03）

### 背景

为支持本地 Ollama 部署（数据隐私需求），pipeline 针对 7B-14B 小模型做了一系列健壮性改造。小模型的主要失败模式：JSON 输出格式不规范、不支持 tool_calls、SQL 方言混淆、复杂查询推理能力不足。

### 新增文件

**`backend/agents/json_utils.py`**

健壮 JSON/SQL 提取工具，处理小模型的各种"脏"输出：
- `extract_json()` — 5 策略依次尝试：直接 parse → 去 fence → 去 `<think>` → 正则提取 → 修复语法
- `extract_sql()` — 从纯文本中提取 SQL（含 fence、无分号等变体）
- `sanitize_sql()` — 自动修复方言错误：`SELECT TOP N` → `LIMIT N`，`DATE_TRUNC('year', 'col')` 引号修正

### 各 Agent 改造

**Planner**
- 使用 `extract_json()` 替代 `json.loads()`，容忍格式不规范输出
- 新增 `_needs_viz()` 关键词检测：用户提到"绘制/图形/chart"等时强制在 plan 里注入 `viz`
- 新增 `_is_top_n_per_group()` 检测"每年 top5"类模式，在 `sql_task` 里注入窗口函数提示

**SQL Agent**
- 双模式执行：先尝试 tool_calls 模式（大模型），首次无响应自动切换文本提取模式（小模型）
- 文本模式用 `extract_sql()` + `sanitize_sql()` 解析并修正 SQL
- 新增 `_validate_result()` 程序化自检：执行后立即检测 NULL 率过高、全行重复等数据质量问题，发现问题直接在内部重试，不消耗 Critic LLM 调用
- Critic 重试时将完整 feedback 注入 system prompt，模型能针对性修复而非盲目重试

**Viz Agent / Critic Agent**
- 使用 `extract_json()` 替代手动 fence 清理 + `json.loads()`
- Viz Agent 增加最多 1 次重试机制，格式错误时给模型更强的 JSON 格式提示

### Pipeline 路由优化

- Critic 触发重试时路径缩短为 SQL → Critic（跳过 Viz），Critic 通过后再补跑 Viz
- Critic 最大重试次数从 2 次降为 1 次（小模型多次重试效果边际递减）
- `sql_result` 新增 `quality_warning` 字段，将程序化检查结果传给 Critic 参考

### SQL Prompt 增强

`SQL_AGENT_SYSTEM` 新增：
- 明确禁止 SQL Server / MySQL 方言（TOP、ISNULL、GETDATE 等）
- 新增 few-shot 示例，覆盖常用模式（top N、聚合、时间过滤）
- 重点标注 top-N-per-group 必须用 ROW_NUMBER() 窗口函数，不能用 GROUP BY + LIMIT
