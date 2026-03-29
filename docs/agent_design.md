
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

**实际执行路径**（由 `pipeline.py` 条件路由控制）：

```python
route_after_planner:  plan 为空 → END | "sql" in plan → sql_agent
route_after_sql:      error/无数据 → report | retry_count>0 → critic（跳过 Viz/Stats）
                      | "viz" in plan → viz_agent | "stats" in plan → stats_agent | → critic
route_after_viz:      "stats" in plan → stats_agent | → critic
                      Critic 通过后如 viz 被跳过 → 补跑 viz_agent
route_after_critic:   pass → report（或补跑 viz） | retry → 打回目标 agent
```

注：Viz 和 Stats 是**顺序执行**（非并行 fan-out），Viz 先于 Stats。Critic 触发重试时路径缩短为 SQL → Critic（跳过 Viz/Stats），Critic 通过后再补跑 Viz。

### 1.1 查询语言 `user_lang`（pipeline 入口一次检测）

- **位置**：`backend/api/sse.py` → `run_analysis_stream()` 在组装 `initial_state` 之前调用 `backend/graph/language.py` 的 `detect_language(query)`。
- **依赖**：`pyproject.toml` / `environment.yml` 中的 `langdetect`；未安装时模块仍可加载，`detect_language` 回退为 `"en"`。
- **行为**：问句中含足够 **CJK 统一表意文字** 时，先用「仅汉字子串」再 `langdetect`，减轻中英混合（如 `genre`、`total_sales`）导致的误判；结果写入 `state["user_lang"]`（BCP-47，如 `zh-cn`、`en`）。
- **使用**：Planner、SQL、Viz、Stats、Critic、Report 的 **system prompt** 均通过 `{user_lang}`（或等价说明）约束**自然语言输出**语言；**指令文本本身为英文**，与输出语言分离。

### 1.2 图表绘制与「和真实数据对齐」（工程侧修复要点）

以下能力在 **`viz_agent.py`**、**`sql_agent.py`**、**`critic_agent.py`** 与前端 **`ChartTab`** 中配合生效；细节见本文 **§4**、**§6** 与 **`frontend.md` §0.6**。

| 问题现象 | 主要手段 |
|----------|----------|
| 图表 series 与 SQL 行对不上、LLM 乱填点 | **`_build_series_from_rows()`**：由列类型启发式 **确定性** 从 `final_rows` 构图；LLM 只选 `type` / `title` / `x_label` / `y_label` / `alt_types`（经下项过滤）。 |
| 直方图/分箱数据却出现 scatter、line 等无意义切换项 | **`_compatible_chart_types()`**：按 x/y 形状与基数算兼容类型，与 LLM 的 `alt_types` **取交集**；前端 `allTypes` 只用过滤后的列表。 |
| 用户要分布/直方图但 SQL 只返回极少行 | **`_is_histogram_intent()`** 打日志；**Critic `_force_histogram_retry()`**：直方图意图且 `len(final_rows) ≤ 5` 时 **强制 retry SQL**，要求分箱查询。 |
| 排名结果与「按谁排序」不一致 | **Critic / Report（DATA_FACTS）** 与人工核对为主；SQL 侧已 **取消** 对窗口 `ORDER BY` 必须含 `DESC` 的硬校验及对结果集的分区 rank–指标一致性自检，避免误杀合法 DuckDB 写法。 |

### 1.3 总结性语言与「和真实数据对齐」（Report + SQL）

| 问题现象 | 主要手段 |
|----------|----------|
| 报告编造排名、写「常年第一」但与逐年数据矛盾 | **`ranked_data_facts`**（**§7.2**）：由代码从排序后的 SQL 结果生成各组 **#1–#3** 文本块，注入 Report system prompt，作为 **DATA_FACTS 权威事实**；`REPORT_SYSTEM` 禁止与 DATA_FACTS 冲突的笼统表述，并硬性要求 **先逐年（逐组）核对第一名** 后才可用 *consistently / 一直* 类措辞。 |
| 表格数字与查询结果不一致 | DATA_FACTS 中主指标 **两位小数**（`_format_fact_cell`），prompt 要求在 **正文** 中照抄；**不在 Report 中重复管道表格**（完整表在 Chart 面板 **Table** 视图）。 |
| 合法 SQL 因评分列大量 NULL 被误判失败、间接导致乱改 SQL | **SQL `_validate_result`** 对 critic/metacritic/avg*score 等列 **跳过** 高 NULL 比例判失败；其余列 NULL 阈值已放宽（**§3.3**）。 |

**架构层索引**：`architecture.md` §5 表格与下文「图表与结论文本的数据一致性」摘要。

---

## 2. Planner Agent

**文件**：`backend/agents/planner.py`

**角色**：理解用户意图，决定回答方式——直接回答（schema 元数据问题）或激活 worker agents（数据分析问题）。

**工具**：无（纯推理）

**Prompt 位置**：`backend/config/prompts.py` → `PLANNER_SYSTEM`

### 2.1 Prompt 结构

Prompt 占位符：`{user_lang}`、`{active_tables}`、`{quality_notes}`（`backend/config/prompts.py` → `PLANNER_SYSTEM`，SECTION 0 说明输出语言须匹配 `user_lang`）

输出格式：

```json
// OPTION 1 — 直接回答
{
  "plan": [],
  "direct_answer": "Your answer here",
  "reasoning": "This is a meta/conceptual question"
}

// OPTION 2 — 激活 agents
{
  "plan": ["sql", "viz"],
  "sql_task": "...",
  "involved_columns": ["col1"],
  "reasoning": "..."
}
```

注：Prompt 模板中 OPTION 2 输出字段为 `plan`、`sql_task`、`involved_columns`、`reasoning`。`viz_task` 和 `stats_task` 由 planner 代码从 `parsed.get()` 读取但 prompt 不显式引导输出。

### 2.2 决策逻辑

```python
async def planner_agent(state: AgentState) -> dict:
    # Retry 时将 critic_feedback 注入 system prompt（target 为 planner/both 时）
    # 使用 extract_json() 解析 LLM 输出（容忍格式不规范）

    # 安全网：
    # - _needs_viz(query)：检测可视化关键词 → 确保 plan 包含 "viz"
    # - 确保 "sql" 在 plan 中
    # - _is_top_n_per_group(query)：检测 "top N per group" → 注入窗口函数 hint

    # 直接回答路径
    if not plan and direct_answer:
        return {"plan": [], "sql_result": {"answer": direct_answer}, ...}

    # Worker 激活路径
    return {
        "plan": plan,
        "sql_task": parsed.get("sql_task", state["user_query"]),
        "viz_task": parsed.get("viz_task"),
        "stats_task": parsed.get("stats_task"),
        "involved_columns": parsed.get("involved_columns", []),
        "stream_events": [progress_event],
    }
```

Pipeline 路由：

```python
def route_after_planner(state: AgentState) -> str:
    if not state.get("plan"):
        return END
    if "sql" in state["plan"]:
        return "sql_agent"
    return END
```

### 2.3 输出 → AgentState

```python
# 直接回答路径
state.plan = []
state.sql_result = {"answer": "这是一个视频游戏销售数据集..."}

# Worker 激活路径
state.plan = ["sql", "viz", "stats"]
state.sql_task = "Query monthly revenue by region for the past 12 months"
```

### 2.4 SSE Trace 命名

所有 agent 推送的 SSE progress 事件中，`agent` 字段统一使用 `"analyst"`，不暴露内部 agent 名称给用户。

---

## 3. SQL Agent

**文件**：`backend/agents/sql_agent.py`

**角色**：自主生成 SQL，执行查询，处理报错并修正。

**工具**：`run_query`（唯一工具，通过 `create_sql_tools(conn)` 工厂函数创建，绑定 DuckDB 连接）

**Prompt 位置**：`backend/config/prompts.py` → `SQL_AGENT_SYSTEM`

### 3.1 Prompt 结构

Prompt 占位符：`{user_lang}`、`{active_tables}`、`{quality_notes}`、`{intent_contract}`、`{duckdb_refs}`

其中 `duckdb_refs` 来自本地离线知识源 `doc/duckdb_official/quick_reference.md`（由 `backend/knowledge/duckdb_retriever.py` 检索并注入），用于在不联网场景下提供 DuckDB 语法参考。

`run_query` 工具返回格式化的文本字符串（非 dict），包含查询结果的文本表格。

### 3.2 双模式执行

```python
async def sql_agent(state: AgentState) -> dict:
    # 模式 1：Tool-calling（大模型）
    # 先尝试 llm.bind_tools([run_query])
    # 如果 LLM 不支持 tool_calls → 自动切换模式 2

    # 模式 2：Text fallback（小模型）
    # 用 extract_sql() + sanitize_sql() 从纯文本提取并修正 SQL
    # 然后手动调用 run_query
```

### 3.3 SQL 预检校验

代码内置 `_validate_sql_candidate()` 和 `_validate_sql_against_contract()`：
- 单语句限制
- 表名校验（只允许 active_tables 中的表）；**CTE 白名单**：用正则从 `WITH ... AS (` 提取所有 CTE 名称，校验时不会将其误判为未知表（修复了 P-B 查询中 `ranked`、`ranked_agg` 被拒绝的问题）
- Intent contract 比对（时间过滤、top-N、per-group 检测）；契约字段由 **Planner 的英文 `sql_task`** 解析（`sql_task` 为空时才退回 `user_query`），**代码中不含任何自然语言关键词表（含中文）**。**`per_group`** 仅由「每年 / each year / per year …」等多桶语义短语触发，**不会**把 `sql_task` 里教学用的 `PARTITION BY` 字样当作用户意图；**单日历年切片 + top-N**（如 *for the year 2020, top 3 …*）会显式 **`per_group=False`**，预检不要求窗口 `PARTITION BY`。

补充：表名校验已修复 `EXTRACT(YEAR FROM release_date)` 误判问题。校验只识别 `FROM/JOIN <table>` 形式的真实表引用，不再把表达式里的 `FROM release_date` 当作表名。

**重复 SQL 检测**：text/tool 两个执行分支均在每次生成 SQL 后计算 `_normalize_sql_fingerprint()`（去空白、转小写），与上一轮 `last_sql_fp` 对比。若相同，注入 `[!] CRITICAL` 升级消息，强制模型尝试根本不同的写法，避免无效重试浪费 token。

**Schema 列类型透传**：`active_tables` 中每张表新增 `col_dicts: [{name, type}]`，SQL Agent prompt 里展示 `column_name (TYPE)` 格式，帮助模型正确选择聚合函数和类型转换。

**结果自检 `_validate_result()`**（text 模式在重试链中仍可能据此提示模型；tool 模式仅打日志、不阻断）：
- 列极端 NULL（>95% 且行数 >5）时判失败；**`_is_optional_sparse_metric_column()`** 仍跳过 critic / metacritic / avg*score 等评分类稀疏列。
- 不再做「分区内 rank=1 是否等于主指标极值」的程序化校验（易误判，改由 Critic/人审）。
- **`_build_result`**：优先采用最后一次 `is_error=False` 且重执行成功的步骤；若无，则回退到 **`executed=True`** 的最后一次 **沙箱执行成功** 的 SQL（避免第三轮校验失败导致整轮无结果）。

### 3.4 输出格式

```python
sql_result = {
    "steps": [
        {
            "title": "query · step 1 of 2",
            "sql": "SELECT region, DATE_TRUNC('month', sale_date) AS month...",
            "tag": "SQL Agent",
            "result_preview": "...",
            "is_error": False,
        }
    ],
    "final_rows": [[...], ...],
    "final_columns": ["region", "month", "total_revenue"],
    "error": None,
    "quality_warning": "...",     # 程序化检查结果，传给 Critic 参考
    "intent_contract": {...},     # 意图契约，用于确定性校验
}
```

---

## 4. Viz Agent

**文件**：`backend/agents/viz_agent.py`

**角色**：根据 SQL 结果选择图表类型，输出结构化 series 数据供前端 Recharts 渲染。

**工具**：无（纯推理，输出结构化 JSON）

**Prompt 位置**：`backend/agents/viz_agent.py` 内部 `VIZ_SYSTEM`（inline 定义，不在 `prompts.py` 中）。占位符含 `{user_lang}`，约束图表标题与轴标签语言。

### 4.1 确定性 Series 构建

代码优先使用 `_build_series_from_rows(columns, rows)` 确定性地从完整数据构建 series，而非依赖 LLM 输出的 series：

```python
def _build_series_from_rows(columns, rows) -> list[dict]:
    # 启发式确定 y 列（rightmost numeric, measure 关键词加分）
    # x 轴优先选 temporal → categorical → numeric
    # 如有额外 categorical 维度 → 分组多 series
    # temporal x 轴按时间排序
```

LLM 只负责选择图表类型（type）、标题（title）、标签（x_label/y_label）和备选类型（alt_types），series 数据由确定性算法生成。

### 4.2 条件激活

```python
def route_after_sql(state):
    if sql_result.error or not sql_result.final_rows:
        return "report"
    if retry_count > 0:
        return "critic"      # 重试时跳过 Viz
    if "viz" in plan:
        return "viz_agent"
    ...
```

### 4.3 Programmatic alt_types 过滤

`_compatible_chart_types(series, primary_type)` 根据实际数据形状程序化判断哪些图表类型兼容：

| 数据特征 | 兼容图表类型 |
|---|---|
| x 分类文本（如 `"0-500"` bin 范围）+ y 数值 | bar, pie（≤10 个 unique x） |
| x 时序（年份/日期）+ y 数值 | line, area, bar |
| x, y 都是连续数值 | scatter, line, bar, area（≤30 unique x） |

LLM 输出的 `alt_types` 与兼容列表取交集并补全，确保用户只看到语义合理的图表切换选项。

### 4.4 Histogram 意图检测

`_is_histogram_intent(user_query)` 检测用户查询是否包含直方图/分布关键词（中英文）。如果检测到 histogram 意图但 SQL 仅返回 ≤5 行数据，记录 warning 日志提示 SQL 可能返回了汇总统计而非正确的分箱数据。

### 4.5 输出格式

```python
viz_result = {
    "type": "line",
    "alt_types": ["area", "bar"],   # 经 _compatible_chart_types 过滤
    "title": "Monthly Revenue by Region",
    "x_label": "Month",
    "y_label": "Revenue",
    "series": [
        {"name": "East", "x": ["Jan","Feb",...], "y": [124800, 138200, ...]},
    ],
    "table_data": {
        "headers": ["month", "East", "North"],
        "rows": [["Jan", 124800, 208400], ...]  # 限制 rows[:100]
    }
}
```

### 4.6 重试机制

最多重试 1 次（共 2 次尝试），格式错误时给模型更强的 JSON 格式提示。

### 4.7 前端渲染

前端使用 **Recharts**（~200KB）渲染，在 `ChartTab.tsx` 的 `ChartRenderer` 中根据 `activeType` 选择组件。

---

## 5. Stats Agent

**文件**：`backend/agents/stats_agent.py`

**角色**：选择统计方法，用 scipy 执行检验，检测异常值。仅当 Planner 激活时才运行。

**工具**：无（LLM 决定测试计划，Python 直接用 scipy/numpy 执行）

**Prompt 位置**：`backend/agents/stats_agent.py` 内部 `STATS_SYSTEM`（inline 定义）。占位符含 `{user_lang}`，约束分析描述语言。

### 5.1 两阶段执行

```
阶段 1：LLM 决定跑哪些测试（纯推理，输出 JSON 计划）
阶段 2：Python 按计划执行 scipy 函数（无 LLM 调用）
```

Data preview 使用 `final_rows[:20]`（20 行）。

### 5.2 输出格式

```python
stats_result = {
    "tests": [
        {"key": "trend significance", "value": "p = 0.0012", "significant": True},
        {"key": "trend r² (linear fit)", "value": "0.847"},
    ],
    "outliers": [
        {"icon": "△", "text": "count: 2008 = 1428 (z = 2.3)"},
    ],
    "summary": {
        "count": {"mean": 584.2, "median": 502.0, "std": 312.8}
    }
}
```

---

## 6. Critic Agent

**文件**：`backend/agents/critic_agent.py`

**角色**：审核 worker 输出的逻辑一致性和数据支撑，决定通过或打回重试。

**工具**：无（纯推理）

**Prompt 位置**：`backend/agents/critic_agent.py` 内部 `CRITIC_SYSTEM`（inline 定义）。占位符含 `{user_lang}`，约束 `feedback` / `transparency_notes` 语言。

### 6.1 Prompt 内容

Critic Prompt 检查 3 项：
1. SQL 正确性（查询是否正确回答了问题）
2. 数字合理性（结论中的数字是否有数据支撑）
3. 统计支撑（统计声明是否有检验结果支持）

Prompt 包含 SQL 结果和 Stats 结果上下文，不包含 Viz 信息。

输出 JSON：
```json
{
  "verdict": "pass" | "retry",
  "target": "sql" | "planner" | "both",
  "feedback": "...",
  "transparency_notes": ["..."]
}
```

### 6.2 Retry target 和路由

```python
# Critic 可打回的目标：
"sql"     → SQL Agent 重新执行
"planner" → Planner 重新规划
"both"    → Planner + SQL 都重做
```

```python
def route_after_critic(state: AgentState) -> str:
    if state["critic_verdict"] == "pass":
        # 如果之前跳过了 viz，补跑
        if "viz" in plan and viz_result is None:
            return "viz_agent"
        return "report"

    target_map = {
        "sql": "sql_agent",
        "planner": "planner",
        "both": "planner",
        "viz": "viz_agent",
        "stats": "stats_agent",
    }
    return target_map.get(state["retry_target"], "report")
```

### 6.3 重试逻辑

```python
async def critic_agent(state: AgentState) -> dict:
    if state.get("retry_count", 0) >= 2:
        return {"critic_verdict": "pass", ...}  # 强制通过

    # ...审核逻辑...

    if verdict == "retry":
        return {
            "critic_verdict": "retry",
            "critic_feedback": feedback,
            "retry_target": target,
            "retry_count": state.get("retry_count", 0) + 1,
            "viz_result": None,      # 清空，准备重新生成
            "stats_result": None,
        }
```

### 6.4 Histogram 意图守卫

`_force_histogram_retry()` 在 LLM 判定之后、假阳性过滤之前执行：

- 检测用户查询是否包含直方图/分布关键词（中英文）
- 如果检测到 histogram 意图但 `len(final_rows) <= 5`，强制 verdict 为 `retry`，target 为 `sql`
- 反馈内容明确指示 SQL Agent 使用 `width_bucket()` 生成分箱数据

这是最后一道防线：即使 Planner 和 SQL Agent 都未正确生成分箱 SQL，Critic 会自动拦截并要求重做。

### 6.5 数据稀疏性守卫

`_override_null_sparsity_retry()` 在 `_force_histogram_retry()` 之后、`_override_false_positive_retry()` 之前运行：

当 Critic LLM 给出 `verdict="retry"` 时，程序化检测这种情况是否属于**数据集本身稀疏**（而非 SQL 逻辑错误）：

触发条件（需同时满足）：
- 结果行数 ≥ 3
- 存在 ≥ 60% 值为 NULL 的指标列（metric column）
- SQL 包含 `GROUP BY` 且包含聚合函数（`SUM/COUNT/AVG/MIN/MAX`）
- 至少存在一个非稀疏列（确认维度列有数据，即只是指标缺失）

满足以上条件时，强制将 `verdict` 降级为 `"pass"`，feedback 说明数据源缺失，不触发重试。

**典型场景**：`video_games_sales_1980_2024_raw` 的 `total_sales` 在 2021-2024 区间 98-100% 为 NULL（原始数据集缺失），Critic 不应将其判断为 SQL 写法错误。

**守卫执行顺序**（Critic agent 内部）：

```
_force_histogram_retry()          # 最优先：histogram 意图守卫
  ↓
_override_null_sparsity_retry()   # 数据稀疏性：SQL 正确但数据缺失 → pass
  ↓
_override_false_positive_retry()  # 等价时间边界 / 无需拆分查询
  ↓
_override_sum_and_avg_both_requested()  # 多指标合规检查
```

### 6.6 假阳性过滤

`_override_false_positive_retry()` 确定性过滤假阳性重试：
- Case 1：等价时间边界（`> N` vs `>= N+1`）
- Case 2：Critic 要求拆分查询但单 SQL 已包含所有必需维度

---

## 7. Report Agent

**文件**：`backend/agents/report_agent.py`

**角色**：整合所有 worker 输出，生成 **Markdown 短文**（前端用 `react-markdown` + `remark-gfm` 渲染 **加粗/列表** 等；**不**在结论里重复 GFM 数据表——完整网格在 Chart 面板的 **Table** 视图）。

**工具**：无

**Prompt 位置**：`backend/agents/report_agent.py` 内部 `REPORT_SYSTEM`（inline，**指令为英文**；`{user_lang}` 约束全文输出语言）

### 7.1 输入来源

Report Agent 接收：
- `user_lang`：BCP-47 语言码（pipeline 入口检测）
- `sql_result`：SQL 查询步骤和结果
- `stats_result`：统计检验结果（tests + outliers）
- `critic_feedback`：审核意见
- `active_tables`：表结构上下文
- `user_query`：用户原始问题

LLM 调用使用 `temperature=0`（与其它 worker 一致）。

### 7.2 DATA_FACTS 与列启发式

- 代码构建 **`ranked_data_facts`** 文本块注入 system prompt：按 **分组列 + 主指标列 + 标签列** 生成各组 `#1/#2/#3`（常量 `DATA_FACTS_TOP_RANKS = 3`；组内行数不足则少于 3 条）。
- 主指标在 `_find_year_and_measure_columns()` 等启发式中按常见 BI 列名（sales、cnt、revenue…）打分选取；分组键优先年份列，否则 `_GROUP_DIM_HINTS` + 基数启发式。
- 事实行中数值经 **`_format_fact_cell`** 格式化为 **两位小数**，供模型抄入表格。

### 7.3 输出结构（Prompt 约束，非代码强制）

`REPORT_SYSTEM` 要求 **Part 1–5**：标题+范围两行；**Part 2 仅为段落/列表**（禁止管道表与用 \`\`\` 包「表」），与 Chart 区 **Table** 视图分工；DATA_FACTS 仍约束排名与两位小数；趋势 ≤3 句（含 consistently 硬规则）；可选脚注。错误/空结果时简化结构。

### 7.4 脚注

稀疏性、截断、数据局限等说明仅由 **`REPORT_SYSTEM` Part 4（可选脚注）** 与模型根据 `sql_summary` / DATA_FACTS 自行写出；**不再**在代码里按领域或年份追加固定句子。

### 7.5 返回格式

```python
return {
    "report": {
        "conclusion": conclusion,       # Markdown 字符串
        "should_record": bool(final_rows) and not error,
        "strategy_version": 1,
        "evidence": None,               # 当前常为 None；检验详情可由前端从 stats 展示
    },
    "stream_events": [progress_event],
}
```

（`sql_result` 的合并与 `answer` 字段以 `pipeline`/路由实现为准；结论主体在 `report.conclusion`。）

---

## 8. Base Agent

**文件**：`backend/agents/base.py`

提供 `get_llm()` 工厂函数和 LLM 管理工具。每个 agent 是独立的 async 函数，不使用类继承。

```python
def get_llm(temperature: float = 0) -> ChatOpenAI:
    """根据 provider 创建 LLM 实例。支持 deepseek / ollama / anthropic。"""
    # 所有 provider 设置 max_tokens=4096

def no_think(system_content: str) -> str:
    """Qwen3 模型时在 system prompt 前加 /no_think，其他模型 no-op。"""

def set_provider(provider: str, model: str | None) -> None:
    """运行时切换 LLM provider，通过模块级 _runtime_provider/_runtime_model 覆盖 .env 配置。"""

def get_current_provider() -> dict:
    """返回 {provider, model, base_url}。"""
```

---

## 9. Tool Registry

**文件**：`backend/tools/sql_tools.py`

当前唯一已实现的工具是 `run_query`，通过工厂函数动态创建：

```python
def create_sql_tools(conn) -> list:
    """创建绑定了 DuckDB 连接的 SQL 工具列表。"""

    @tool
    def run_query(sql: str) -> str:
        """Execute a SQL query against the DuckDB database."""
        result = execute_sandboxed(conn, sql)
        return formatted_text_table(result)

    return [run_query]
```

SQL Agent 在执行时调用 `create_sql_tools(conn)` 获取绑定了当前项目连接的工具实例。

---

## 10. LangGraph Pipeline

**文件**：`backend/graph/pipeline.py`、`backend/graph/state.py`

### 10.1 Graph 结构

```python
from langgraph.graph import StateGraph, END

def build_pipeline():
    graph = StateGraph(AgentState)

    graph.add_node("planner", planner_agent)
    graph.add_node("sql_agent", sql_agent)
    graph.add_node("viz_agent", viz_agent)
    graph.add_node("stats_agent", stats_agent)
    graph.add_node("critic", critic_agent)
    graph.add_node("report", report_agent)

    graph.set_entry_point("planner")

    graph.add_conditional_edges("planner", route_after_planner)
    graph.add_conditional_edges("sql_agent", route_after_sql)
    graph.add_conditional_edges("viz_agent", route_after_viz)
    graph.add_edge("stats_agent", "critic")
    graph.add_conditional_edges("critic", route_after_critic)
    graph.add_edge("report", END)

    return graph.compile()
```

注：`viz_agent` 使用条件边（`route_after_viz`）而非固定边，支持 stats 跳转和 post-retry 补跑逻辑。所有路由函数在 `pipeline.py` 中定义（无单独的 `router.py` 文件）。

### 10.2 路由函数

```python
def route_after_planner(state) -> str:
    if not state.get("plan"):
        return END
    if "sql" in state["plan"]:
        return "sql_agent"
    return END

def route_after_sql(state) -> str:
    if error or no_data:
        return "report"
    if retry_count > 0:
        return "critic"          # 重试时跳过 Viz/Stats
    if "viz" in plan:
        return "viz_agent"
    if "stats" in plan:
        return "stats_agent"
    return "critic"

def route_after_viz(state) -> str:
    if "stats" in plan:
        return "stats_agent"
    return "critic"

def route_after_critic(state) -> str:
    if verdict == "pass":
        if "viz" in plan and viz_result is None:
            return "viz_agent"   # 补跑 viz
        return "report"
    return target_map[retry_target]
```

### 10.3 State Reducer

Viz 和 Stats 顺序执行，不存在并行冲突。唯一使用 reducer 的字段是 `stream_events: Annotated[list[dict], add]`，每个节点的事件自动追加。

---

## 11. Prompt 管理

**文件**：`backend/config/prompts.py`

当前集中在 `prompts.py` 中的模板（**正文为英文**；通过 `{user_lang}` 约束自然语言输出语种）：

```python
PLANNER_SYSTEM = """..."""       # 含 SECTION 0 user_lang；intent 分条为英文（用户可用任意语言提问）
SQL_AGENT_SYSTEM = """..."""     # 含 user_lang；DuckDB 模板与 top-N per group 等
TABLE_SCHEMA_TEMPLATE = """...""" # 通用表结构模板片段
```

以下模板 **inline 定义在各 agent 文件中**（非集中管理），均含 **`{user_lang}`** 或与语言相关的英文说明：

```
VIZ_SYSTEM     → viz_agent.py
STATS_SYSTEM   → stats_agent.py
CRITIC_SYSTEM  → critic_agent.py
REPORT_SYSTEM  → report_agent.py
```

---

## 12. 关键实现备注

**为什么 agent 之间通过 AgentState 传数据而不是自然语言？**
自然语言传递会引入 LLM 理解偏差。结构化的 `sql_result`、`viz_result`、`stats_result` 字段确保数据精确传递。

**为什么 Planner 不调用工具？**
Planner 的职责是任务分解和路由，不涉及数据操作。保持纯推理，让它专注于"怎么拆解这个问题"。

**为什么 Critic 最多重试 2 次？**
无限重试会导致用户长时间等待。2 次重试足够修复常见错误，如果 3 次仍失败，问题大概率出在用户问题本身。

**为什么 Viz Agent 用确定性构建而非依赖 LLM 输出 series？**
`_build_series_from_rows` 通过启发式算法确定性地构建 series 数据，避免 LLM 在数据映射时出错（尤其是小模型）。LLM 只负责选择图表类型和标签等元信息。

**为什么 Critic 重试时跳过 Viz/Stats？**
重试路径缩短为 SQL → Critic，减少延迟。Critic 通过后再补跑 Viz，避免在错误的 SQL 结果上浪费 Viz/Stats 计算。

**为什么 prompt 没有全部集中在 prompts.py？**
设计目标是集中管理，但当前仅 Planner 和 SQL Agent 的 prompt 在 `prompts.py` 中，其余 4 个 agent 的 prompt inline 在各自文件中。

---

## 小模型兼容性改造（2025-03）

### 背景

为支持本地 Ollama 部署（数据隐私需求），pipeline 针对 7B-14B 小模型做了一系列健壮性改造。

### 新增文件

**`backend/agents/json_utils.py`**

健壮 JSON/SQL 提取工具：
- `extract_json()` — 5 策略依次尝试：直接 parse → 去 fence → 去 `<think>` → 正则提取 → 修复语法
- `extract_sql()` — 从纯文本中提取 SQL
- `sanitize_sql()` — 自动修复 DuckDB 方言错误，三级修复链：

  | 顺序 | 函数 | 修复内容 |
  |------|------|----------|
  | 1 | `_fix_aggregate_in_orderby()` | 将窗口函数 `OVER` 子句中 `ORDER BY SUM(col)` 替换为 `ORDER BY alias`（DuckDB 要求聚合表达式在 `OVER` 中不能展开） |
  | 2 | `_fix_window_in_grouped_cte()` | 当单个 CTE 同时含 `GROUP BY` 和窗口函数时，自动拆分为两个 CTE：`{name}_agg`（聚合层）和 `{name}`（窗口层，`FROM {name}_agg`）；同时将窗口 `PARTITION BY` 中的原始表达式（如 `YEAR(release_date)`）替换为聚合层输出的别名（`year`） |
  | 3 | 后续扩展 | 预留入口，可继续添加针对特定 DuckDB Binder Error 的修复规则 |

  辅助函数：
  - `_find_matching_paren(s, open_pos)` — 找到与指定位置 `(` 匹配的 `)` 位置，处理嵌套和引号
  - `_split_select_items(select_list)` — 按顶层逗号切分 SELECT 列表（忽略函数括号内的逗号）
  - `_select_item_output_name(item)` — 提取 SELECT 项的输出名（别名优先；无 AS 则用列名；函数返回 None）

### 各 Agent 改造

- **Planner**：使用 `extract_json()`，新增 `_needs_viz()` 和 `_is_top_n_per_group()` 安全网；`active_tables` 传入 `col_dicts: [{name, type}]` 提供列类型信息
- **SQL Agent**：双模式执行（tool-calling + text fallback），新增 `_validate_result()` 程序化自检；CTE 白名单修复假拒绝；重复 SQL 指纹检测防止无效重试循环
- **Viz Agent**：使用 `extract_json()`，最多 1 次重试
- **Critic Agent**：使用 `extract_json()`，新增假阳性过滤；新增 `_override_null_sparsity_retry()` 数据稀疏性守卫；Critic prompt 新增数据稀疏性规则

### Pipeline 路由优化

- Critic 触发重试时路径缩短为 SQL → Critic（跳过 Viz/Stats），Critic 通过后再补跑 Viz
- `sql_result` 新增 `quality_warning` 字段，将程序化检查结果传给 Critic 参考

### Thinking 模式分配（Qwen3）

| Agent | Thinking | 原因 |
|-------|----------|------|
| SQL Agent | ✅ 开启 | 需要推导窗口函数、CTE 等复杂逻辑 |
| Critic Agent | ✅ 开启 | 需要推理 SQL 语义是否正确 |
| Planner | ❌ `/no_think` | 意图分类 + JSON 输出 |
| Viz Agent | ❌ `/no_think` | 格式化 JSON 输出 |
| Report Agent | ❌ `/no_think` | 自然语言总结 |
