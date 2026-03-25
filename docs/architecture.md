
# c2d — Architecture

c2d (chat to dataset) is a multi-agent data analysis system. Users upload datasets or connect databases, ask questions in natural language, and a pipeline of specialized agents collaborates to return SQL queries, charts, statistical analysis, and natural-language conclusions — all streamed in real time.

---

## 1. Product Positioning

### 核心形态：分析记录工具

c2d 的产品形态是 **分析记录工具** ，而非对话工具。用户来这里的目的是得到分析结论，Chat 是辅助输入方式，不是产品主体。

* **组织单元是"分析项目"** ，不是"对话 session"。左侧 Sidebar 展示的是分析项目列表，每个条目对应一份数据分析任务，有标题、数据集、时间信息。
* **主区域展示分析记录的积累** ，Chat 输入框始终在，但其作用是"向当前分析追加问题"，而不是"开启一段对话"。
* **右侧面板是当前选中分析记录的详情视图** ，跟随左侧选中状态联动，不是最新 query 的覆盖式输出。

### 两种发行版本

|              | 云端版（优先实现）   | 本地版（后续实现）     |
| ------------ | -------------------- | ---------------------- |
| 分析项目存储 | 服务器（PostgreSQL） | 本地文件系统（SQLite） |
| 数据文件     | 上传到云端（S3/OSS） | 本地直接读取           |
| 向量记忆     | Qdrant 云            | Qdrant 本地            |
| 用户鉴权     | 需要（多用户）       | 不需要（单机）         |
| UI 体验      | 完全一致             | 完全一致               |
| 跨设备访问   | 支持                 | 不支持                 |

两个版本共用全部 Frontend、Backend、Agent、Graph、Memory 逻辑，差异 **仅在 Data Adapter Layer** （见第 13 节）。

---

## 2. System Overview

```
User (Browser)
    │
    │  HTTP / SSE
    ▼
┌─────────────────────────────────────────┐
│              FastAPI (api/)             │
│   /analyze/stream  /datasets  /history  │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│          LangGraph Pipeline (graph/)    │
│                                         │
│   AgentState flows through nodes:       │
│                                         │
│   Planner → SQL → [Viz │ Stats] → Critic → Report  │
│                                         │
│   Routing is dynamic — Critic can       │
│   send flow back to workers for retry   │
└──────┬──────────────────────┬───────────┘
       │                      │
       ▼                      ▼
┌─────────────┐      ┌────────────────────┐
│  Tools      │      │  Memory System     │
│  (tools/)   │      │  (memory/)         │
│             │      │                    │
│  sql_tools  │      │  short_term  (ctx) │
│  viz_tools  │      │  long_term   (vec) │
│  stats_tools│      │  preferences (kv)  │
│  data_tools │      └────────────────────┘
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────┐
│         Data Adapter Layer (adapters/)  │
│                                         │
│   DatasetStorage  SessionStorage        │
│   VectorStorage   AuthProvider          │
│                                         │
│   ┌──────────────┬──────────────────┐   │
│   │  云端实现     │   本地实现        │   │
│   │  S3 / OSS    │   本地文件系统    │   │
│   │  PostgreSQL  │   SQLite         │   │
│   │  Qdrant云    │   Qdrant本地     │   │
│   └──────────────┴──────────────────┘   │
└──────┬──────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│              Data Layer (db/)           │
│                                         │
│   DuckDB  ←  loader  ←  data/uploads/  │
│                                         │
│   sandbox.py wraps all query execution  │
└─────────────────────────────────────────┘
```

---

## 3. Directory Structure

```
c2d/
├── backend/
│   ├── agents/         # 每个 agent 的推理逻辑
│   ├── graph/          # LangGraph 状态机和路由
│   ├── tools/          # 所有可调用工具 + 注册表
│   ├── memory/         # 三层记忆系统
│   ├── api/            # FastAPI 路由和 SSE 推送
│   ├── db/             # DuckDB 引擎、数据加载、沙箱
│   ├── adapters/       # Data Adapter Layer（云端/本地可替换实现）
│   │   ├── base.py     # 统一接口定义（抽象基类）
│   │   ├── cloud.py    # 云端实现（S3, PostgreSQL, Qdrant云）
│   │   └── local.py    # 本地实现（本地文件系统, SQLite, Qdrant本地）
│   └── config/         # 全局配置和 prompt 集中管理
├── eval/               # Evaluation 框架
├── frontend/           # React + Vite
├── tests/              # 单元 + 集成测试
├── docs/               # 设计文档
└── data/
    ├── uploads/        # 用户原始上传文件（已 gitignore）
    ├── processed/      # 清洗后的 DuckDB 文件（已 gitignore）
    └── exports/        # 用户导出报告（已 gitignore）
```

---

## 4. Request Lifecycle

一次用户提问从发出到返回的完整流程：

```
1. 用户在分析项目中输入问题，附带当前数据集 ID
2. POST /analyze/stream — 建立 SSE 连接
3. API 层从 Memory Manager 读取短期上下文和用户偏好
4. 组装初始 AgentState，交给 LangGraph pipeline
5. Planner Agent 拆解任务，决定激活哪些 worker agents
6. SQL Agent 先行执行：
     - 自主生成 SQL，执行查询，处理报错并修正
     - 通过 tools/registry.py 调用工具执行
7. SQL 结果就绪后，Viz Agent 和 Stats Agent 并行运行（fan-out）：
     - Viz Agent    → 基于 sql_result 选择图表类型，输出 alt_types 备选列表
     - Stats Agent  → 基于 sql_result 执行统计检验（条件激活）
8. reducer 合并所有 worker 输出到 AgentState
9. Critic Agent 审核结论：
     - 通过 → Report Agent 整合最终输出
     - 不通过 → 带原因打回指定 worker 重试（最多 2 次）
10. Report Agent 判断本次结果是否值得记录（见第 5 节），
    生成结构化结果并决定是否追加到分析项目的 report_records，
    结果携带当前 strategy_version 标记
11. SSE 将每个节点的进度事件和最终结果流式推送到前端
12. Memory Manager 将本次分析结果写入长期记忆，更新用户偏好
```

---

## 5. Agent Responsibilities

每个 agent 职责单一，不跨界。

| Agent            | 职责                                                                                                                                                                                      | 可调用的工具                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Planner`      | 理解用户意图，拆解为子任务，决定激活哪些 worker                                                                                                                                           | 无（只做推理）                                                                          |
| `SQL Agent`    | 自主生成 SQL，执行查询，处理报错并修正                                                                                                                                                    | `run_query`,`validate_sql`,`explain_query`                                        |
| `Viz Agent`    | 根据数据特征选择图表类型，生成 Plotly 图表配置，同时输出 `alt_types`（当前数据结构下合理的 2-3 个备选图表类型）供前端切换                                                               | `plot_line`,`plot_bar`,`plot_scatter`,`plot_heatmap`,`plot_pie`,`plot_area` |
| `Stats Agent`  | 选择统计方法，执行检验，检测异常值；只有当 Planner 判断问题涉及统计判断时才激活                                                                                                           | `t_test`,`correlation`,`detect_outliers`,`describe`                             |
| `Critic Agent` | 审核结论的逻辑一致性和数据支撑，决定是否重试；对涉及 keep_null 列的结论追加透明度说明                                                                                                     | 无（只做推理）                                                                          |
| `Report Agent` | 整合所有 worker 输出，判断是否值得记录，生成结构化报告；当 Stats Agent 产出了检验结果（tests 字段非空）时，生成 evidence section 内联展示（p 值、置信区间、异常点），不重复结论已有的数字 | `write_file`（导出 Markdown + SVG zip）                                               |

### Report Agent 的记录判断逻辑

Report Agent 对每次 query 的结果做判断， **只有产生了实质性分析结论的 query 才追加到 report_records** ：

```python
# 值得记录的情况（追加到 report_records）
- 执行了 SQL 查询并返回了数据结果
- 生成了图表
- 产出了统计检验结论

# 不记录的情况（仅在 chat 中回复，不进 report_records）
- 用户在问概念性问题（"这个字段是什么意思"）
- 用户在修改数据清洗决策
- 澄清性的追问（"你刚才说的 23% 是怎么算的"）
- 分析失败（Critic 打回超过 2 次仍未通过）
```

---

## 6. LangGraph State

所有 agent 共享一个 `AgentState` 对象，贯穿整个 pipeline。

```python
class AgentState(TypedDict):
    # 输入
    user_query: str
    session_id: str
    project_id: str        # 当前分析项目 ID

    # 数据集管理（两个字段严格区分）
    all_dataset_ids: list[str]    # 所有已上传的数据集，不论是否开启
    active_dataset_ids: list[str] # 用户当前开启的数据集，只有这里的才注入 prompt
                                  # 关闭数据集 → 从此列表移除，但不从 all_dataset_ids 移除

    # 数据集关联图（邻接表，仅记录已确认的 join key 关系）
    join_graph: dict
    join_keys: dict

    # 当前 session 已加载且已开启的表信息
    active_tables: list[dict]

    # 数据质量决策（所有数据集，不论是否开启，永久保留）
    data_quality_decisions: dict
    strategy_version: int         # 数据清洗策略版本号，每次 update 递增

    # Planner 输出
    plan: list[str]           # 激活的 agent 列表，如 ["sql", "viz"]
    retry_count: int          # 当前重试次数（Critic 控制，上限 2）

    # Worker 输出（由 reducer 合并）
    sql_result: dict          # {"query": ..., "rows": ..., "error": ...}
    viz_result: dict          # {"type": ..., "plotly_config": ..., "alt_types": ["area", "bar", "table"]}
    stats_result: dict        # {"tests": ..., "outliers": ..., "summary": ...}
                              # tests 非空时 → Report Agent 生成 evidence section
                              # tests 为空时 → summary 数据融入结论文本，不单独展示

    # Critic 输出
    critic_verdict: str       # "pass" | "retry"
    critic_feedback: str      # 打回时的具体原因

    # 最终输出
    report: dict              # 结构化报告，SSE 推送给前端，包含 strategy_version 标记
    should_record: bool       # Report Agent 判断是否追加到 report_records
    stream_events: list[dict] # 实时进度事件列表
```

---

## 7. Tool Calling Design

工具调用是本项目的核心技能点。与 Literal 的固定路由不同，c2d 中每个 worker agent 面对的是一个工具注册表，由 LLM 自主决定：

* **要不要调用工具** （也许直接推理就够了）
* **调哪个工具** （run_query vs explain_query）
* **用什么参数**
* **看到结果后下一步怎么做** （修正 SQL 再试 / 换图表类型）

```
Worker Agent Loop:
┌─────────────────────────────────────────────┐
│  LLM 收到任务描述 + 可用工具列表              │
│       │                                      │
│       ▼                                      │
│  决策：直接回答 or 调用工具                   │
│       │                                      │
│       ▼  (调用工具时)                         │
│  生成 tool_call { name, arguments }          │
│       │                                      │
│       ▼                                      │
│  registry.py 路由到对应函数执行               │
│       │                                      │
│       ▼                                      │
│  tool_result 返回给 LLM                      │
│       │                                      │
│       ▼                                      │
│  LLM 观察结果 → 继续调用 or 结束循环         │
└─────────────────────────────────────────────┘
```

工具注册方式使用 `@tool` 装饰器，schema 自动从类型注解和 docstring 生成，LLM 通过 schema 理解工具用途。

---

## 8. Memory System

三层记忆，各自解决不同的时间跨度问题。

```
┌─────────────────────────────────────────────────────────────┐
│                      Memory Manager                          │
│                                                              │
│  ┌────────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │  Short-term    │  │   Long-term      │  │ Preferences │ │
│  │                │  │                  │  │             │ │
│  │ 滑动窗口       │  │ Qdrant 向量库    │  │ JSON / KV   │ │
│  │ 最近 N 轮对话  │  │ 历史分析语义检索 │  │ 图表偏好    │ │
│  │ 防 token 溢出  │  │ 跨 session 记忆  │  │ 默认聚合粒度│ │
│  └────────────────┘  └──────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

* **Short-term** ：当前 session 的对话窗口，控制传给 LLM 的 token 数量，采用滑动窗口策略（保留最近 10 轮 + 系统摘要）
* **Long-term** ：历史分析结果向量化存储，新问题到来时语义召回相关历史，让 agent 知道"上次分析过类似问题"
* **Preferences** ：用户行为偏好，如喜欢折线图、默认按月聚合、top N 默认取 10，影响 Planner 的任务拆解决策

Memory 系统的价值体现在其效果上（agent 能记住偏好、召回历史），不需要向用户直接暴露内部状态。如需调试，通过独立的 debug 模式访问，不占用主界面 Tab 位置。

---

## 9. Frontend Layout & UI Design

### 整体布局

三栏结构，Sidebar 默认收起，Chat 与 Results Panel 按 40:60 比例分配页面宽度。所有面板宽度可拖拽调整，双击 resizer 恢复默认比例。

```
┌─────────────┬────────── 40% ──────────┬──────────── 60% ─────────────┐
│   Sidebar   │     Main (Chat)         │     Results Panel             │
│  （默认收起）│                         │                               │
│             │  Schema Panel            │  Tab: Schema                  │
│  分析项目列表│  （数据清洗阶段）        │  Tab: Chart (默认)            │
│             │                         │  Tab: SQL                     │
│  ★ 已收藏   │  Chat 区域              │  Tab: Report                  │
│  历史项目   │  （分析阶段，折叠式）    │                               │
│             │                         │  （所有 Tab 内容可折叠展开）    │
└─────────────┴─────────────────────────┴───────────────────────────────┘
```

Sidebar 收起后，40:60 比例相对于整个页面宽度。展开 Sidebar 后比例不变，Chat + Results 区域自动缩小适应。

### Sidebar：分析项目列表（默认收起）

* 默认收起，点击 topbar 汉堡按钮展开
* 每个条目显示：项目标题、数据集 tag（可多个）、创建时间
* 支持  **收藏标记** （星标图标 hover 显示）：收藏的项目置顶展示
* 点击条目 → 进入该分析项目

### Main 区域：两种模式

 **clean mode** （数据清洗阶段）：Schema Panel 占满主区域，Chat 隐藏
 **chat mode** （分析阶段）：Schema Panel 收起为 44px header（可重新展开修改策略），Chat 区域淡入

### Chat 区域：折叠式 Exchange

Chat 内容按 query 分组为折叠式 exchange 块：

* 每个 exchange = 用户提问 + agent trace + agent 回复
* **默认只展开最新一条** ，历史 exchange 折叠为一行摘要（#N · query 文字 · ▶）
* 点击折叠行展开/收起，展开时显示完整对话内容

### Results Panel：4 个 Tab

默认显示 Chart tab。

| Tab    | 内容                                 | 说明                         |
| ------ | ------------------------------------ | ---------------------------- |
| Schema | 当前数据集的列信息、类型、质量状态   | 辅助用户了解数据结构         |
| Chart  | 所有图表按时间叠加，每张图可切换类型 | 默认 Tab，流水账视角         |
| SQL    | 所有 SQL 查询按时间叠加              | 支持复制，供分析师验证或复用 |
| Report | 当前分析项目的结构化分析文档         | 精华版，可导出               |

 **Stats 不作为独立 Tab** ：当结论包含统计判断（"显著""趋势""异常"等判断性词汇）时，Report 记录下方生成 `▶ evidence` 可展开 section，内容为检验结果（p 值、置信区间、r²）和异常检测（超出正常范围的数据点）。纯事实查询（排序、Top N、简单聚合）不生成 evidence section。

### Chart / SQL / Report 的统一折叠模式

三个 Tab 内的记录条目均采用相同的折叠/展开模式：

```
默认状态：
  #1  Monthly revenue trend by region          ▶   （折叠，一行摘要）
  #2  What drove East's Q3 acceleration?       ▶   （折叠，一行摘要）
  #3  Compare online vs offline channel    ▶ ←     （展开，最新条目）
       ┌─────────────────────────────┐
       │  [图表 / SQL / 报告内容]      │
       └─────────────────────────────┘
```

* 点击摘要行 → 展开/收起内容
* 点击 ↗ 箭头 → 跳转到 Chat 对应消息位置（stopPropagation，不触发折叠）
* 展开时左侧显示绿色边框高亮

### Chart Tab：图表类型切换器

每张图表的 card 顶部有一排图表类型切换按钮，由 Viz Agent 根据数据结构推荐合理的备选类型：

```
 view  [📈 Line ✓] [📊 Area] [📊 Bar] [📋 Table]    recommended by agent
 ┌─────────────────────────────────────────────────┐
 │              当前选中类型的图表渲染                │
 └─────────────────────────────────────────────────┘
```

* **备选类型由 Viz Agent 的 `alt_types` 字段决定** ，不同数据结构推荐不同组合（趋势数据 → line/area/bar/table；占比数据 → bar/pie/table）
* **`table` 是唯一固定选项** ——不管什么数据，看原始表格永远有意义
* 点击按钮即时切换， **纯前端渲染** ，所有视图的数据在首次生成时已准备好，不重新调用 agent
* 当前选中的按钮高亮为绿色，hover 显示类型名称 tooltip
* 分析中（running）的条目暂无切换器，Viz Agent 完成后生成

### Chart Tab：图表导出

每张图表的 type bar 右侧提供两个导出按钮，用竖线与类型切换器分隔：

* **SVG** — 下载当前选中视图的 SVG 矢量文件，可直接拖入 PPT/Figma 无损缩放
* **data** — 将图表背后的原始数据以 TSV 格式（tab 分隔）复制到剪贴板，可直接粘贴到 Excel 继续加工

如果当前是 table 视图，SVG 导出会将表格渲染为 SVG 格式。复制成功后按钮短暂变绿显示 ✓ copied。

### Report Tab：结构化分析文档

Report Tab 是当前分析项目的可读文档，不是记录目录。每个 section 由 Report Agent 判断值得记录的 query 生成：

```
Monthly revenue trend by region
sales_2024.csv · products.csv · 3 analyses
[↓ export .md + svg]                          ← 全局导出

  #1  Monthly revenue trend by region    14:32    ▶
      （折叠：点击展开图表 + 结论 + critic + evidence）

  #2  What drove East's Q3 acceleration  14:38    ▶
      （折叠，无 evidence — 纯事实拆解）

  #3  Online vs offline channel          14:45    ▶ ← 展开
      ┌──────────────────────────────────────────┐
      │  [嵌入图表]                                │
      │  结论文字（关键数字高亮）                    │
      │  critic 审核框                             │
      │  ▶ evidence（条件展示，见下方）              │
      │                    [↓ export .md + svg]   │ ← 单 section 导出
      └──────────────────────────────────────────┘
```

### Evidence Section（条件展示）

evidence 的作用是回答"这个结论可信吗"，只有当结论包含**可被质疑的统计判断**时才生成：

```
展示 evidence 的场景：
  - 趋势判断："East 增长最快"      → r²、p 值证明趋势显著
  - 差异比较："Online 显著高于 Offline" → t-test p 值、置信区间
  - 异常标记："Q3 出现异常增长"     → 2σ 阈值、具体数据点

不展示的场景：
  - 简单查询："上个月华东区销售额多少"
  - 排序/Top N："销售额最高的 5 个产品"
  - 纯描述/拆解："各品类占比分别是多少"
```

判断逻辑在 Stats Agent 层面：只有实际产出了检验结果（`stats_result.tests` 非空）时，Report Agent 才生成 evidence section。内容分两块：

* **statistical tests** ：p 值、置信区间、r²（线性拟合度）——不重复结论里已有的数字
* **anomaly detection** ：超出 2σ 的数据点列表

### Report 导出

两级导出，均输出 zip 包（`.md` + `.svg`）：

* **全局导出** （Report header 的 `↓ export .md + svg` 按钮）：下载整个 report 的 zip，包含 `report.md`（Markdown 文件，图表用 `![Chart](chart-N.svg)` 引用）+ 所有 `chart-N.svg` 文件
* **单 section 导出** （每个 section 底部的 `↓ export .md + svg` 按钮）：下载该 section 的 zip，包含 `section.md` + 对应的 `chart-N.svg`

Markdown 是"可编辑中间格式"——用户拿到后改标题、调措辞、加判断，然后整合到自己的周报/PPT/邮件里。SVG 矢量图可直接拖入 Figma/PPT 无损缩放。用 VS Code 打开解压后的文件夹即可预览 Markdown + 内嵌图表。

### 右侧面板联动逻辑

联动方向： **右侧 → 左侧** （chart/sql/report 里的 ↗ 箭头触发 jumpToChat）

```
点击 Chart/SQL/Report 里任意 ↗ 箭头
  → 展开 Chat 中对应的 exchange（如果折叠状态）
  → 滚动到该 exchange 位置
  → 绿色边框闪烁高亮 1.8 秒
```

### 收藏体系

两层收藏，解决不同粒度的快速定位需求：

| 层级     | 入口                      | 作用                            |
| -------- | ------------------------- | ------------------------------- |
| 项目收藏 | Sidebar 条目的星标        | 跨时间快速找回重要的分析项目    |
| 记录收藏 | Report Tab 每条记录的星标 | 在长 session 内快速定位关键结论 |

---

## 10. Streaming (SSE)

前端通过 SSE 长连接实时接收 pipeline 执行状态。每个 LangGraph 节点执行时推送一个 `progress` 事件，最终结果推送 `done` 事件。

```
事件类型：
  progress         — agent 开始/完成某个节点（用于前端 AgentTrace 组件）
  quality_block    — Planner 发现 WARNING 列被当前问题涉及，需用户决策
  tool_call        — agent 调用了某个工具（可选，调试用）
  result           — 某个 worker 的中间结果（SQL、图表配置等）
  record           — Report Agent 判断 should_record=true，前端追加到 Report Tab
  strategy_update  — 用户更新了数据清洗策略，携带新版本号和受影响的记录列表
  done             — 完整的最终报告
  error            — 任意节点的异常
```

---

## 11. Data Flow

### 11.0 加载总流程

数据清洗触发时机遵循" **按问题严重程度分层触发** "原则，阻断的条件不是数据本身的问题，而是"有问题的数据是否会影响当前这次分析"。

**数据集状态机**

每个数据集有三种独立状态，系统模式由所有 active 数据集的状态共同决定：

```
inactive   — 关闭，不参与分析，不显示 Schema Tab
pending    — 开启但未完成数据清洗，需要用户决策
confirmed  — 开启且已完成数据清洗，可以参与分析

系统模式：
  chat mode  — 所有 active 数据集均为 confirmed
  clean mode — 至少一个 active 数据集为 pending
  empty      — 没有任何 active 数据集
```

**多数据集关联图（Join Graph）**

所有 active 数据集必须构成一个 **连通图** ：

```
节点 = 数据集
边   = 两个数据集之间存在已确认的 join key

合法状态（连通）：        不合法状态（断开）：
  1 —— 2 —— 3              1    3
  所有节点可互达             节点 3 孤立，无法与 1 关联
```

第 N 个数据集与已有数据集的关联检测结果分三类：

```
exact_match   — 列名相同，值域高度重叠（> 90%）→ 直接允许开启
candidate     — 列名不同但值域重叠 > 60%        → 弹出确认面板让用户选择
no_join       — 无任何关联                       → 拒绝开启，提示开新项目
```

关闭数据集时，做 **BFS 连通性检查** ，孤立节点级联关闭，向用户展示清晰提示。

### 11.1 阶段一：类型推断与自动转换

原始 CSV 所有列默认读取为字符串，`loader.py` 对每一列尝试类型推断。

**核心原则：无歧义转换由 Agent 决定，有歧义转换交给用户**

```python
def infer_type_conversions(col) -> ConversionDecision:
    result = try_infer(col)
    if result.confidence > 0.95 and result.format_consistent:
        return AutoConvert(dtype=result.dtype)
    elif result.confidence > 0.60 and not result.format_consistent:
        return AskUser(samples=result.conflicting_samples, options=result.conversion_options)
    else:
        return KeepAsString()
```

### 11.2 阶段二：数据质量扫描

```python
class Severity(Enum):
    BLOCKING = "blocking"  # 必须处理，阻止分析继续
    WARNING  = "warning"   # 标记展示，用户可忽略
    INFO     = "info"      # 静默记录，不展示
```

* `BLOCKING`：类型歧义，上传后立即强制处理
* `WARNING`：缺失率 > 30%、疑似分类编码列，等待意图判断
* `INFO`：缺失率 < 30%、离群值，静默记录

### 11.3 阶段三-A：Schema Panel（上传后立即展示）

* 按数据集分 Tab，Chat 区域隐藏
* BLOCKING → 红色，必须决策（选项：转换方式 / exclude this column）
* WARNING → 黄色，可跳过
* confirm 按钮 → 校验所有 active 数据集的 BLOCKING 均已决策
* 通过 → 所有 blocking 行折叠为绿色已解决状态（✓ 列名 · 选择项 · click to edit），tab badge 更新为 `✓ done`，section label 变为 `✓ resolved`，Schema Panel 收起，Chat 淡入
* 重新展开后用户看到的是已解决的干净状态，点击某行可展开重新编辑

**策略版本化（Strategy Versioning）**

首次确认后 `strategy_version = 1`，按钮文案变为 "↻ update decisions"（不禁用）。用户可随时重新展开 Schema Panel 修改清洗策略。

修改后再次确认时：

* `strategy_version` 递增
* **历史分析结果保留不变** ，在 Chart/Report 的锚点行追加版本标签（如 `v1`，amber 色），标注"Based on previous data strategy"
* Chat 区域追加系统消息："Data strategy updated to v2. Previous analyses (v1) remain unchanged — new strategy applies to future queries only."
* 新的 query 基于新策略执行，结果标记为当前版本

**重新展开 Schema Panel 时的提示**

底部 confirm 区域显示 amber 提示框："N analyses based on current strategy (vN). Changes will only apply to future analyses — existing results will be preserved with a version tag."

```
首次确认流程：
  用户选择清洗选项 → 点击 "confirm decisions & start analysis"
  → strategy_version = 1 → Schema Panel 收起 → Chat 淡入

策略更新流程：
  用户点击 Schema Panel header 展开 → 看到更新提示
  → 修改选项 → 点击 "↻ update & apply to future queries"
  → strategy_version++ → 旧记录打 tag → Chat 追加系统消息
  → Schema Panel 收起 → 后续 query 使用新策略
```

### 11.4 阶段三-B：提问后意图-数据交叉判断

用户提问后，Planner Agent 将涉及列与 WARNING 列表做交叉检查：

* WARNING 列 ∩ 涉及列 有交集 → 升级为阻断，弹出决策面板，暂停分析
* WARNING 列 ∩ 涉及列 无交集 → 完全静默，继续

### 11.5 阶段四：执行用户决策，注册 DuckDB 表

`apply_decisions()` 仅对 `active_dataset_ids` 执行，写入 DuckDB。
`data_quality_decisions` 按数据集嵌套保存（含 inactive 数据集，关闭时不丢弃）。

### 11.6 阶段五：运行时透明度（Critic Agent 兜底）

涉及列有 `keep_null` 决策 → 在结论末尾追加透明度说明：

```
⚠ Data integrity note:
  channel has 149 null values (1.2%) excluded from this analysis.
  Actual totals may be slightly higher.
```

### 11.7 完整数据流图

```
用户上传文件 / 切换数据集开关
       │
       ▼ 阶段零：数据集开关
  active_dataset_ids 更新
  关闭 → 前端隐藏该 Tab，后端保留 decisions，BFS 检查连通性
  开启 → 进入清洗流程，复用已有 decisions（如有）
       │
       ▼ 阶段一：infer_type_conversions()（仅 active 数据集）
       ▼ 阶段二：scan_quality()
       ▼ 阶段三-A：Schema Panel（上传后立即展示）
       ▼            首次确认 → strategy_version = 1
       ▼            后续更新 → strategy_version++，历史记录打版本 tag
       ▼ 阶段三-B：用户提问 → Planner 意图-数据交叉判断
       ▼ 阶段四：apply_decisions() → 注册 DuckDB 具名表
       │
       ├─→ active_tables（仅 active 数据集，含 excluded_cols）→ SQL Agent prompt
       │
       ▼ db/sandbox.py → tools/sql_tools.py → run_query()
       │
       ▼ Critic Agent（审核 + 透明度追加）
       │
       ▼ Report Agent（判断 should_record，整合输出）
       │
       ├─→ should_record=true  → 追加到 report_records，SSE 推送 record 事件
       └─→ should_record=false → 仅 chat 回复，不进 Report Tab
```

---

## 12. Data Retention

### 保留策略

数据文件和分析记录的生命周期分开管理：

| 内容                 | 保留策略         | 说明                            |
| -------------------- | ---------------- | ------------------------------- |
| 分析项目元数据       | 长期保留         | 纯文本，占用空间极小            |
| Chat 记录            | 长期保留         | 纯文本，占用空间极小            |
| Report 记录          | 长期保留         | 结构化 JSON，占用空间极小       |
| 原始上传文件         | 处理完成后可删除 | 已转入 DuckDB，原始文件不再需要 |
| 处理后的 DuckDB 文件 | 按策略保留       | 见下方                          |

### DuckDB 文件存储

CSV 转成 DuckDB 列存格式后通常压缩至原始文件的 30%～60%，百万行数据约 50～200 MB。

**保存处理后的 DuckDB 文件而非原始 CSV** 的优点：

* 保留了所有数据清洗决策，用户重新开启项目无需重新操作
* 列存格式查询更快
* 空间占用更小

**生命周期策略（云端版）：**

```
活跃项目（30 天内有访问）  → 保留 DuckDB 文件
非活跃项目（> 30 天无访问）→ 提示用户，可手动续期或删除
用户主动删除项目          → 立即清理 DuckDB 文件
```

数据清理时向用户发送通知，而不是静默删除。

---

## 13. Data Adapter Layer

Data Adapter Layer 是云端版和本地版的唯一差异点，定义统一接口，两个版本各自实现。

```python
# adapters/base.py

class DatasetStorage(ABC):
    """数据文件的读写"""
    @abstractmethod
    async def upload(self, file: bytes, filename: str, project_id: str) -> str: ...
    @abstractmethod
    async def get_path(self, dataset_id: str) -> str: ...
    @abstractmethod
    async def delete(self, dataset_id: str) -> None: ...

class SessionStorage(ABC):
    """分析项目和记录的持久化"""
    @abstractmethod
    async def create_project(self, user_id: str, title: str) -> Project: ...
    @abstractmethod
    async def get_projects(self, user_id: str) -> list[Project]: ...
    @abstractmethod
    async def append_record(self, project_id: str, record: ReportRecord) -> None: ...
    @abstractmethod
    async def get_records(self, project_id: str) -> list[ReportRecord]: ...
    @abstractmethod
    async def toggle_favorite(self, item_id: str, level: str) -> None: ...
    @abstractmethod
    async def get_strategy_version(self, project_id: str) -> int: ...
    @abstractmethod
    async def increment_strategy_version(self, project_id: str) -> int: ...
    @abstractmethod
    async def get_records_by_strategy(self, project_id: str, version: int) -> list[ReportRecord]: ...

class VectorStorage(ABC):
    """长期记忆的向量存储"""
    @abstractmethod
    async def upsert(self, session_id: str, vector: list[float], payload: dict) -> None: ...
    @abstractmethod
    async def search(self, query_vector: list[float], top_k: int) -> list[dict]: ...

class AuthProvider(ABC):
    """用户鉴权"""
    @abstractmethod
    async def get_current_user(self, token: str) -> User | None: ...
```

云端实现（`adapters/cloud.py`）：S3/OSS + PostgreSQL + Qdrant 云 + JWT 鉴权

本地实现（`adapters/local.py`）：本地文件系统 + SQLite + Qdrant 本地 + 无鉴权（直接返回默认用户）

Agent、Graph、Memory 层不直接 import 任何存储实现，只依赖 Adapter 接口，通过依赖注入在启动时注入对应实现。

---

## 14. Evaluation Framework

每次修改 agent 逻辑或 prompt 后，通过 `eval/runner.py` 跑回归测试，防止改了 A 坏了 B。

```
eval/cases/sql_cases.json       → 问题 + 期望 SQL（精确匹配或语义等价）
eval/cases/analysis_cases.json  → 问题 + 期望结论关键词

评估指标（eval/metrics.py）：
  - sql_accuracy         : 生成 SQL 的执行结果与 ground truth 一致率
  - conclusion_score     : 结论中关键信息的覆盖率（LLM-as-judge）
  - chart_validity       : 图表配置是否合法可渲染
  - retry_rate           : Critic 打回重试的比例（越低越好）
  - quality_block_rate   : Planner 触发 WARNING 升级阻断的比例
  - record_precision     : Report Agent 记录判断的准确率（该记录的记了，不该记的没记）
  - latency_p50/p95      : pipeline 端到端延迟
```

---

## 15. Tech Stack

| 层次       | 技术选型                          | 原因                               |
| ---------- | --------------------------------- | ---------------------------------- |
| LLM        | DeepSeek（开发） / Claude（测试） | 兼容 OpenAI 接口，`.env`一键切换 |
| Agent 框架 | LangGraph                         | 支持有状态图、fan-out、条件路由    |
| API 层     | FastAPI + SSE                     | 异步、流式推送、类型安全           |
| 数据引擎   | DuckDB                            | 零配置、列存储、分析查询极快       |
| 向量数据库 | Qdrant                            | 长期记忆语义检索，Docker 一键启动  |
| Embedding  | sentence-transformers             | 本地运行，无需额外 API 费用        |
| 统计计算   | scipy + pandas                    | 成熟的统计检验工具链               |
| 图表       | Plotly                            | 配置驱动，前后端共用 schema        |
| 前端       | React + Vite + Zustand            | 轻量状态管理，SSE hook 简单直接    |
| 云端存储   | S3/OSS + PostgreSQL               | 数据文件 + 项目记录持久化          |
| 本地存储   | 本地文件系统 + SQLite             | 无服务器依赖，本地版核心           |
| 测试       | pytest + pytest-asyncio           | 支持异步 agent 测试                |

---

## 16. Key Design Decisions

**为什么产品形态是"分析记录"而非"对话记录"？**
用户来这里的目的是得到分析结论，不是聊天。几天后回来，想找的是"上次关于华东区的分析"，而不是"上次我第三条消息问了什么"。以分析项目为组织单元，Report Tab 作为结构化目录，比时间线对话更符合分析工作的实际使用方式。

**为什么 Stats 不单独做成 Tab？**
Stats 的三类内容（检验结果、异常值、摘要统计）在不同问题下的重要性差异很大。当问题是"A 和 B 有显著差异吗"时，stats 是主结论；当问题只是"上个月哪个地区销售额最高"时，stats 是背景信息。把 Stats 作为 Report 记录内的可展开 section，比单独一个常驻 Tab 更符合实际信息权重。

**为什么 Memory 不做成 Tab？**
Memory 系统的价值体现在效果上，不需要用户查看内部状态。对普通用户来说，向量召回结果和偏好 KV 几乎不可读。真正有用的记忆透明度应该内联在 chat 中展示（如"基于你上次的分析，这次我也按月聚合"），而不是单独一个 Tab。

**为什么 Results Panel 跟随选中记录联动而非覆盖最新结果？**
分析工作是连续追问的过程，用户经常需要对比前后两次的结果。跟随选中记录联动，配合 Report Tab 作为目录，让用户能快速在不同分析结论间切换，而不用翻越对话记录。

**为什么保存 DuckDB 文件而非原始 CSV？**
DuckDB 列存格式比原始 CSV 小 40%～70%，查询速度快一个数量级。更重要的是，DuckDB 文件保留了所有数据清洗决策，用户几天后回来继续分析时无需重新操作 Schema Panel。

**为什么从架构阶段就设计 Data Adapter Layer？**
云端版和本地版的 UI 和 Agent 逻辑完全相同，差异只在数据存储。如果不在一开始就抽象出 Adapter 接口，等到要做本地版时，存储细节已经散落在各处，改起来代价很高。Adapter Layer 在架构阶段定义好接口，开发时只需实现云端版，本地版替换 Adapter 实现即可。

**为什么关闭数据集时做连通性检查（BFS）并级联关闭孤立节点？**
1—2—3 的链式关联中，关闭 2 之后 3 和 1 之间不再有任何 JOIN 路径，继续 active 会导致 SQL Agent 尝试笛卡尔积查询或报错。BFS 连通性检查是最小代价的解决方式，级联关闭时向用户展示清晰提示，避免用户不理解为什么某个数据集被自动关闭。

**为什么 must resolve 不提供 "keep as string" 选项？**
日期列保持 VARCHAR 会导致任何日期范围查询报错；数值列保持 VARCHAR 会导致所有聚合计算失败。正确的退出路径是 "exclude this column"——用户明确表示不使用该列，后端将其从 active_tables 中移除，Agent 完全感知不到该列的存在。

**为什么 Report Agent 要判断是否值得记录，而不是每次 query 都记录？**
用户在分析过程中会有很多辅助性的提问（解释字段含义、澄清上一条结论、修改数据决策），这些问题的回答不是分析结论，塞进 Report Tab 只会稀释真正有价值的记录，让用户更难找到想要的内容。

**为什么数据清洗策略允许修改（update）而不是锁死（lock）？**
分析过程中用户对数据的理解会加深，清洗策略需要跟着调整是正常场景。比如一开始用 mean 填充缺失值，后来发现数据有偏，想改为 median——这不应该需要重新开始整个项目。策略版本化设计（方案二）让历史结果保留并打标签，新策略只影响后续分析，兼顾了可追溯性和灵活性。不选方案一（重跑全部历史）是因为计算成本高，且用户可能只想看"新策略下的新结论"，并不想覆盖之前的结果。

**为什么 Chart / SQL / Report 都采用折叠/展开模式，默认只展开最新一条？**
分析工作是追问式的，3-5 轮后如果所有内容全部展开，右侧面板会变得很长，用户需要大量滚动才能找到最新结果。折叠模式让最新结果始终在视野内，历史记录作为一行摘要保留上下文，需要时点击展开即可。这和 chat 区域的折叠逻辑一致，用户心智模型统一。

**为什么图表类型切换由 agent 推荐而不是固定选项？**
不是所有图表类型对所有数据都有意义。趋势数据可以是折线图/面积图/柱状图，但饼图就不合理；占比数据可以是饼图/柱状图，但折线图没意义。固定选项会导致大量无效按钮。Viz Agent 在生成图表时通过 `alt_types` 字段推荐当前数据结构下合理的 2-3 个备选，这个判断对 LLM 来说很轻量。`table` 是唯一固定选项——看原始数据永远有意义。

**为什么 Sidebar 默认收起，Chat 和 Results 比例是 40:60？**
产品形态是分析记录工具，用户大部分时间在当前项目内工作，不需要常驻导航。Results Panel 承载的是分析结果（图表、SQL、报告），是核心产出物，应该占更大空间。Chat 只是输入方式和过程记录，40% 足够。需要切换项目时点击汉堡按钮展开 Sidebar 即可。

**为什么用"evidence"而不是"stats"？**
"stats" 暗示统计摘要（均值、增长率），但实际内容是"结论背后的技术证据"——p 值说明差异是否显著，置信区间说明结论的可信度，异常点列表说明哪些数据被特别关注。用户展开这个 section 的心理预期是"这个结论靠谱吗"，不是"给我看更多数字"。"evidence" 准确传达了这个定位。

**为什么 evidence 不是每次都展示？**
evidence 的作用是回答"这个结论可信吗"，只有当结论包含可被质疑的统计判断时才有存在必要。"East 增长最快"需要 p 值证明趋势显著；"销售额最高的 5 个产品"不需要——排序结果本身就是事实。每次都展示会产生大量无意义的统计噪音，稀释真正需要验证的结论。判断逻辑在 Stats Agent 层面：只有 `stats_result.tests` 非空时 Report Agent 才生成 evidence section。

**为什么 Report 导出格式是 Markdown + SVG 的 zip，而不是 PDF 或 docx？**
Report 的定位是"分析半成品"，用户拿到后一定会改标题、调措辞、加判断，再整合到自己的文档里。Markdown 是最轻量的可编辑中间格式——任何编辑器都能打开，粘贴到 Notion/飞书/Confluence 自动渲染，Pandoc 一步转 docx/PDF。SVG 矢量图可直接拖入 Figma/PPT 无损缩放。PDF 不可编辑，和"用户一定会改"的场景矛盾。

**为什么 Chart 提供 Copy data（TSV 剪贴板）？**
图表的视觉效果由 Viz Agent 自动生成，但用户可能对配色、样式、标注不满意，想用自己习惯的工具重新画。Copy data 把图表背后的原始数据以 TSV 格式复制到剪贴板，粘贴到 Excel/Google Sheets 后用户可以自由调整。这比导出 CSV 文件再手动打开少两步操作。

---

## 15. 本地 LLM 支持（Ollama）

### 15.1 背景

出于数据隐私考虑，支持通过 Ollama 将模型部署在本地运行，数据不离开用户设备。在线 API（DeepSeek）和本地模型可通过 `.env` 或运行时 API 随时切换，无需重启服务。

### 15.2 Provider 配置

`.env` 中通过 `LLM_PROVIDER` 指定：

```
LLM_PROVIDER=ollama          # 本地模式
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=qwen3:8b

# LLM_PROVIDER=deepseek      # 在线模式
```

运行时切换（无需重启）：
```
PUT /llm/provider?provider=ollama&model=qwen3:8b
GET /llm/status
```

### 15.3 推荐模型

| 用途 | 推荐模型 | 说明 |
|------|---------|------|
| 综合最优（本地）| `qwen3:8b` | thinking 模式处理复杂 SQL，性价比最高 |
| 备选更大模型 | `qwen3:30b-a3b` | MoE 架构，激活参数仅 3B，~20GB VRAM |
| 在线高精度 | DeepSeek API | 复杂分析首选，schema 信息发送给 API 但数据不离开本地 |

实测：`qwen3:8b` 开启 thinking 模式可正确生成窗口函数（ROW_NUMBER OVER PARTITION BY），处理 top-N-per-group 等复杂查询。

### 15.4 Thinking 模式分配策略

Qwen3 默认开启 thinking 模式（`<think>` 推理链），会增加延迟。各 Agent 按任务性质区分：

| Agent | Thinking | 原因 |
|-------|----------|------|
| SQL Agent | ✅ 开启 | 需要推导窗口函数、CTE 等复杂逻辑 |
| Critic Agent | ✅ 开启 | 需要推理 SQL 语义是否正确回答了问题 |
| Planner | ❌ `/no_think` | 意图分类 + JSON 输出，无需推理 |
| Viz Agent | ❌ `/no_think` | 格式化 JSON 输出，无需推理 |
| Report Agent | ❌ `/no_think` | 自然语言总结，无需推理 |

实现：`backend/agents/base.py` 的 `no_think()` 函数在检测到 Qwen3 模型时自动在 system prompt 前追加 `/no_think`，对非 Qwen3 模型为 no-op。
