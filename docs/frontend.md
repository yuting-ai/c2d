
# c2d — Frontend Implementation

本文档覆盖前端实现层面的具体设计，是 architecture.md Section 9（UI Design）的 implementation 对照。architecture.md 负责"是什么、为什么"，本文档负责"怎么实现"。

技术栈：React + Vite + Zustand + TypeScript

---

## 0. 近期前端改动（截至 2026-03-26）

### 0.1 Schema 交互与状态

- 新增分析模式状态：`analysisMode = simple | advanced`，并持久化到 localStorage。
- 上传时携带 `analysis_mode` 到后端，保证模式阈值前后端一致。
- `allResolved()` 逻辑扩展：除 blocking 外，还要求 must-solve warning 已处理。
- warning 决策 key 改为 issue 级别（`warningKey`），避免同列多 warning 冲突。

### 0.2 Warning 展示升级

- warning UI 从平铺改为按列分组显示。
- warning 项增加 must-solve 视觉标记，并计入顶部/底部 must resolve 计数。
- advanced 模式新增"选项后自动折叠"交互：
  - 选中后折叠为绿色 `✓` 摘要条
  - 摘要显示列名 + 已选策略
  - 点击摘要可重新展开编辑

### 0.3 Simple 模式提醒

- 查询前风险提醒从原生 `window.confirm` 升级为自定义弹窗。
- 弹窗支持"本会话不再提醒"开关。

### 0.4 类型徽章视觉

- 新增统一 dtype 徽章组件风格：text / number / date / bool / other。
- 使用轻量图标前缀（如 `T`、`#`、`🗓`、`⊙`）提升可读性。

### 0.5 Chart 渲染改进

- 引入 `seriesMeta` / `labelToKey` 内部 key 系统（`s_0`/`s_1`），避免 series 重名冲突。
- Y 值通过 `toFiniteNumber` 归一化，确保非数值不阻塞渲染。
- `SortedTooltip` 改用 `p.name`（fallback `p.dataKey`）过滤和显示，修复 tooltip 在 line/area/bar 图上不显示的问题。
- Tooltip header 同时展示 x 轴标签和值（如 `jp_sales: 0.99`），与 scatter tooltip 对齐。
- SVG 导出注入标题（深色主题 header band + 绿色 accent 文字）、背景色和分隔线。
- 滑块显示条件收紧：仅 `(line || area) && xIsTemporal && chartData.length > 20 && !swapAxes`。
- 支持 X/Y 轴交换（swap axes）功能。
- Bar chart 非 temporal x 轴时按总值降序排列。

### 0.6 Chart 渲染进阶与 BI 模式（2026-03-27）

- **Overview/Detail 双模式（BI 风格）**：
  - Scatter、Line、Bar 图表新增 `mode: overview` / `mode: detail` 切换按钮。
  - Overview 模式执行**真正的聚合计算**（按 x 值分组 → `mean(y)`），替代原来的简单抽样。
  - Detail 模式显示完整原始数据点。
  - 按钮在数据量低于阈值（5000 点）时自动禁用。
  - Scatter tooltip 在 Overview 模式下标注 `avg(yLabel)`。
- **Backend alt_types 兼容性过滤**：Viz Agent 新增 `_compatible_chart_types()`，基于数据形状（x 分类/数值/时序）程序化过滤备选图表类型。前端 `allTypes` 直接使用过滤后的 `altTypes`，不再出现无意义的选项（如 histogram 数据不显示 scatter/line）。
- **Table 视图阈值**：`TABLE_VIEW_MAX_ROWS = 50`。超过 50 行时 `table` 选项不显示。设计目的为截图/报告用途，非交互。超阈值时自动切回默认图表类型。
- **缩放功能**：100%–500% 水平缩放，用于查看密集数据细节。缩放控件：`-` / `100%` / `+`。
- **Y 轴格式化**：`formatYAxisTick` 函数 — 数值型自动缩写为 K/M/B，非数值型截断超长标签（>10 字符加 `…`）。
- **Bar 图排序逻辑**：`sortedBarData` — x 轴为纯数值时按升序排列；非数值时按所有 series y 值总和降序排列。
- **X-ticks 自适应**：`X_TICKS_AUTO_OFF_THRESHOLD = 20`。整数轴 span ≤ 20 时默认显示全部刻度，否则稀疏。提供 `x ticks: sparse/all` 手动切换按钮。
- **Interactive Legend**：Bar 图启用 `InteractiveLegend`（点击隐藏/显示 series，双击 solo）。
- **Scatter X 轴完整性**：`scatterXStats` 计算 min/max/ticks/span，确保整数轴完整覆盖数据范围。
- **Y 轴标注居中**：自定义 `renderCenteredYAxisLabel` 通过 SVG `viewBox` 计算实现真正的垂直居中。
- **Line/Area/Bar 数据源统一**：三类图统一使用 `sampledSeriesData` 作为渲染输入，避免同一查询在不同图形下出现数据源不一致。
- **Area 时间轴修复**：`chartData` 构建阶段对 `x` 做 numeric-like 归一化（如 `"2016"` → `2016`），并在归一化后去重；Area 的 `XAxis` 也统一使用 `lineBarXStats` 的 `domain/ticks`，修复 area 横轴按索引显示的问题。

### 0.7 Dataset Tab 与版本化

- 新增 `DatasetTab` 组件（含 `DataGrid`、`VersionPanel`）。
- 新增 `datasetStore.ts`——管理数据集预览、排序、列选择、单元格编辑、版本快照。
- 所有 record 类型（Chart/SQL/Report）携带 `datasetVersions` 标记。

### 0.8 布局重构

- 移除 `<MainColumn>`，ChatPanel 移入独立 `chat-drawer-wrap`，由 `chatDrawerOpen` 控制。
- 新增 `<IconSidebar>` 组件。
- 新增 `<ErrorBoundary>` 包裹 ChatPanel 和 ResultsPanel。
- ChatStore 重构为多项目多会话架构（`sessionsByProject`）。

### 0.9 Markdown 渲染（结论 / 报告）（2026-03-28）

- **依赖**：`react-markdown`、`remark-gfm`（列表、自动链接等；**数据表以 Chart 面板 Table 为准**）。包管理可用 **pnpm** 或 **npm**（`frontend/package.json`）。
- **`ChatMarkdown.tsx`**：`ReactMarkdown` + `remarkPlugins={[remarkGfm]}`，根节点 class **`c2d-markdown`**。
- **使用位置**：
  - **聊天**：`ChatPanel` → 分析师回复走 `<ChatMarkdown text={ex.reply} />`。
  - **报告面板**：`ReportTab.tsx` 中每条记录的 `conclusion` 同样用 `<ChatMarkdown />`。
- **产品与分工**：**完整查询结果网格**在 **Results → Chart → `table` 视图**（`ChartTab` / `DataTable`）；**Report / 聊天结论**定位为 **文字提炼**（加粗、`-` 列表），后端 `REPORT_SYSTEM` 已禁止在结论中重复管道表或把表放进 \`\`\` 代码块，避免与 Table 视图冲突。
- **样式**：`globals.css` 内 `.c2d-markdown`（段落、列表、`table/th/td`、`pre/code`、`.report-conclusion-md` 横向滚动）。

---

## 1. Component Tree

```
<App>
├── <Topbar>
│
├── <div.layout>
│   ├── <IconSidebar>                      ← 图标侧边栏
│   │
│   ├── <div.sidebar-wrap>                 ← 可折叠
│   │   └── <Sidebar>
│   │       ├── <NewAnalysisBtn>
│   │       ├── <SidebarSection label="★ Starred">
│   │       │   └── <ProjectItem> ×N
│   │       ├── <SidebarSection label="Today / Yesterday / Last 7 days">
│   │       │   └── <ProjectItem> ×N
│   │       └── <RecentSessions>           ← session 管理 UI
│   │
│   ├── <Resizer side="left">              ← 仅 sidebarOpen 时显示
│   │
│   ├── <div.chat-drawer-wrap>             ← 由 chatDrawerOpen 控制
│   │   └── <ErrorBoundary>
│   │       └── <ChatPanel>
│   │           ├── <ChatMessages>
│   │           │   └── <ConversationTurn> ×N
│   │           │       ├── <MsgUser>          ← 右对齐气泡
│   │           │       └── <MsgAnalyst>       ← 左对齐，analyst 头像
│   │           │           ├── <AnalystHeader>
│   │           │           └── <AnalystContent>
│   │           │               ├── <ThinkingBlock>
│   │           │               ├── <TypingDots>
│   │           │               ├── <AnalystReply>
│   │           │               └── <SqlPreviewGroup>
│   │           └── <InputArea>
│   │               ├── <HintChips>
│   │               └── <InputRow>
│   │
│   ├── <Resizer side="left">              ← 仅 chatDrawerOpen 时显示
│   │
│   └── <div.main>
│       └── <div.results-panel>
│           └── <ErrorBoundary>
│               └── <ResultsPanel>
│                   ├── <TabBar>            ← dataset / schema / chart / sql / report
│                   └── <TabContent>
│                       ├── <DatasetTab>
│                       │   ├── <DataGrid>
│                       │   └── <VersionPanel>
│                       ├── <SchemaTab>
│                       ├── <ChartTab>
│                       │   └── <ChartEntry> ×N
│                       │       ├── <EntryAnchor>
│                       │       ├── <RunningStateCard>  ← status='running' 占位
│                       │       └── <EntryBody>
│                       │           └── <ChartCard>
│                       │               ├── <ChartTypeBar>
│                       │               │   ├── <TypeButton> ×N
│                       │               │   ├── <SwapAxesBtn>
│                       │               │   └── <ExportGroup>
│                       │               │       ├── <SVGExportBtn>
│                       │               │       └── <CopyDataBtn>
│                       │               ├── <InteractiveLegend>
│                       │               ├── <ChartRenderer>
│                       │               │   └── line/area/bar/pie/scatter → Recharts
│                       │               │       └── <SortedTooltip xLabel="...">
│                       │               ├── <RangeSlider>  ← 条件渲染
│                       │               └── <DataTable>    ← table 视图
│                       │
│                       ├── <SqlTab>
│                       │   └── <SqlEntry> ×N
│                       │       └── <SqlCard> ×N
│                       │
│                       └── <ReportTab>
│                           ├── <ReportHeader>
│                           │   └── <GlobalExportBtn>
│                           └── <ReportEntry> ×N
│                               ├── <EntryAnchor>
│                               └── <EntryBody>
│                                   ├── <EmbeddedChart>
│                                   ├── <Conclusion>
│                                   ├── <EvidenceToggle>
│                                   │   └── <EvidenceBody>
│                                   └── <EntryExportBtn>
```

---

## 2. Zustand Store 结构

按关注点拆分为 6 个独立 store，互不直接依赖。组件通过 selector 订阅需要的 slice，避免不必要的重渲染。

### 2.1 Project Store

管理分析项目列表和当前选中项目。

```typescript
interface Project {
  id: string
  title: string
  datasetNames: string[]
  createdAt: string
  starred: boolean
  time: string
  editable?: boolean
}

interface ProjectStore {
  projects: Project[]
  activeProjectId: string | null

  selectProject: (id: string | null) => void
  toggleStar: (id: string) => void
  createProject: (title: string, datasetName: string) => string
  updateProjectTitle: (id: string, title: string) => void
  addDatasetToProject: (projectId: string, datasetName: string) => void
  upsertProject: (project: Project) => void
}
```

### 2.2 Schema Store

管理数据集状态机、数据清洗决策、策略版本、项目切换缓存。

```typescript
interface ColumnInfo {
  name: string
  original_type: string
  inferred_type: string | null
  null_pct: number
  sample_values: string[]
}

interface DatasetState {
  id: string
  name: string
  rowCount: number
  columnCount: number
  sizeBytes: number
  columns: ColumnInfo[]
  blockingIssues: BlockingIssue[]
  warningIssues: WarningIssue[]
  autoConverted: AutoConverted[]
  confirmed: boolean
}

interface BlockingIssue {
  key: string
  column: string
  original_type: string
  inferred_type: string
  description: string
  samples: string[]
  options: { value: string; label: string }[]
  selectedOption: string | null
  resolved: boolean
}

interface WarningIssue {
  key: string
  column: string
  col_type: string
  issue_type: string
  severity: string
  must_solve: boolean
  description: string
  options: { value: string; label: string }[] | null
  selectedOption: string | null
}

interface ActiveTable {
  name: string
  columns: string[]
  excluded_columns: string[]
  row_count: number
}

interface SchemaStore {
  analysisMode: 'simple' | 'advanced'
  datasets: DatasetState[]
  strategyVersion: number
  systemMode: 'empty' | 'clean' | 'chat'
  uploading: boolean
  confirming: boolean
  error: string | null
  activeTables: ActiveTable[]

  _cache: Record<string, ProjectSchemaState>
  _activeProjectId: string | null

  allResolved: () => boolean
  setAnalysisMode: (mode: 'simple' | 'advanced') => void
  switchProject: (projectId: string) => void
  loadProjectSchema: (projectId: string) => Promise<void>
  uploadDataset: (projectId: string, file: File) => Promise<void>
  selectOption: (datasetId: string, column: string, option: string) => void
  selectWarningOption: (datasetId: string, warningKey: string, option: string) => void
  confirmSchema: (projectId: string) => Promise<void>
  reset: () => void
}
```

`systemMode` 的派生逻辑：

```typescript
// 无数据集 → 'empty'
// 所有数据集 confirmed → 'chat'
// 否则 → 'clean'
```

### 2.3 Chat Store

管理多项目多会话的对话内容。每个项目有独立的 session 列表，每个 session 内含 exchanges。

```typescript
interface TraceStep {
  agent: string
  label: string
  status: 'done' | 'active' | 'waiting'
}

interface SqlStep {
  title: string
  sql: string
  tag: string
}

interface Exchange {
  id: number
  query: string
  trace: TraceStep[] | null
  reply: string | null
  sqlSteps: SqlStep[]
  status: 'pending' | 'streaming' | 'done' | 'error'
  error: string | null
}

interface ChatSession {
  id: string
  title: string
  createdAt: string
  messageCount: number
  exchanges: Exchange[]
}

interface ChatStore {
  sessionsByProject: Record<string, ChatSession[]>
  activeSessionIdByProject: Record<string, string | null>

  initProjectSession: (projectId: string) => void
  getSessionsForProject: (projectId: string) => ChatSession[]
  getActiveSessionId: (projectId: string) => string | null
  getActiveExchanges: (projectId: string) => Exchange[]
  createSession: (projectId: string) => string
  selectSession: (projectId: string, sessionId: string) => void
  addExchange: (projectId: string, query: string) => { exchangeId: number; sessionId: string }
  updateTrace: (projectId: string, sessionId: string, id: number, steps: TraceStep[]) => void
  addSqlSteps: (projectId: string, sessionId: string, id: number, steps: SqlStep[]) => void
  setReply: (projectId: string, sessionId: string, id: number, reply: string) => void
  setStatus: (projectId: string, sessionId: string, id: number, status: Exchange['status']) => void
  setError: (projectId: string, sessionId: string, id: number, error: string) => void
}
```

**对话式 UI 渲染策略**：所有 exchange 平铺展示，不折叠。每轮渲染为：用户气泡（右）→ analyst 头像 + thinking block + reply（左）。ThinkingBlock 在分析完成后自动折叠为一行 "✓ N steps completed"，点击可展开查看。

**视觉流转**：

1. 发送 → exchange 状态 `pending` → analyst 头像 + 绿色跳动圆点
2. 首条 SSE progress → 状态 `streaming` → ThinkingBlock 出现，步骤逐条滑入
3. 后续 SSE progress → trace 步骤实时更新（done/active/waiting 状态）
4. SSE done → 状态 `done` → reply 淡入，ThinkingBlock 自动折叠（600ms 延迟）
5. SQL 预览显示为可折叠标签 "▶ SQL · N queries"

### 2.4 Results Store

管理右侧面板所有 Tab 的数据和 UI 状态。

```typescript
interface ChartSeries {
  name: string
  x: (string | number)[]
  y: number[]
}

interface ChartRecord {
  id: number
  requestId: number | null
  query: string
  type: string
  altTypes: string[]
  activeType: string
  title: string
  xLabel: string
  yLabel: string
  series: ChartSeries[]
  tableData: { headers: string[]; rows: any[][] } | null
  status: 'done' | 'running'
  datasetVersions: Record<string, string>
}

interface SqlRecord {
  id: number
  query: string
  steps: { title: string; sql: string; tag: string }[]
  status: 'done' | 'running'
  datasetVersions: Record<string, string>
}

interface EvidenceData {
  tests: { key: string; value: string; significant?: boolean }[]
  anomalies: { icon: string; text: string }[]
}

interface ReportRecord {
  id: number
  query: string
  time: string
  conclusion: string
  chartData: ChartRecord | null
  sqlSteps: { title: string; sql: string; tag: string }[]
  evidence: EvidenceData | null
  starred: boolean
  status: 'done' | 'running'
  datasetVersions: Record<string, string>
}

interface ResultsStore {
  activeTab: 'dataset' | 'schema' | 'chart' | 'sql' | 'report'
  hasOpenedDatasetTab: boolean
  chartRecords: ChartRecord[]
  sqlRecords: SqlRecord[]
  reportRecords: ReportRecord[]
  expandedChart: number | null
  expandedSql: number | null
  expandedReport: number | null

  setActiveTab: (tab: string) => void
  markDatasetTabOpened: () => void
  addChartRecord: (record: ChartRecord) => void
  startChartRecord: (query: string) => number
  finalizeChartRecord: (id: number, record: Partial<ChartRecord>) => void
  removeChartRecord: (id: number) => void
  switchChartView: (id: number, type: string) => void
  toggleChartEntry: (id: number) => void
  addSqlRecord: (record: SqlRecord) => void
  toggleSqlEntry: (id: number) => void
  addReportRecord: (record: ReportRecord) => void
  toggleReportEntry: (id: number) => void
  toggleReportStar: (id: number) => void
}
```

**Chart 两阶段渲染**：`submit` 时立即调用 `startChartRecord(query)` 创建 `status='running'` 的占位卡片（`RunningStateCard`），用户在等待时能看到正在处理的指示。`done` 事件到达后调用 `finalizeChartRecord(id, data)` 填充真实数据。如果分析失败则 `removeChartRecord(id)` 清除占位。

### 2.5 UI Store

管理纯 UI 状态：sidebar 开关、chat drawer 开关、schema panel 状态。

```typescript
interface UIStore {
  sidebarOpen: boolean
  chatDrawerOpen: boolean
  schemaPanelOpen: boolean

  toggleSidebar: () => void
  toggleChatDrawer: () => void
  setChatDrawerOpen: (open: boolean) => void
  toggleSchemaPanel: () => void
  setSchemaPanelOpen: (open: boolean) => void
}
```

### 2.6 Dataset Store

管理 Dataset Tab 的数据预览、排序、列选择、单元格编辑和版本管理。

```typescript
interface PreviewData {
  columns: string[]
  colTypes: Record<string, string>
  rows: any[][]
  total: number
  offset: number
  limit: number
  versionId: string | null
}

interface VersionEntry {
  version_id: string
  created_at: number
  description: string
  table_name: string
  is_current: boolean
}

interface PendingEdit {
  datasetId: string
  rowIndex: number
  column: string
  value: string
}

interface DatasetStore {
  activeDatasetId: string | null
  previews: Record<string, PreviewData>
  loading: boolean
  sortCol: string | null
  sortDir: 'asc' | 'desc'
  selectedCols: Record<string, Set<string>>
  pendingEdits: PendingEdit[]
  versions: Record<string, VersionEntry[]>
  versionsLoading: boolean
  saving: boolean
  lastSavedAt: number | null

  setActiveDataset: (projectId: string, datasetId: string) => void
  fetchPreview: (projectId: string, datasetId: string, opts?) => Promise<void>
  loadMore: (projectId: string, datasetId: string) => Promise<void>
  setSort: (projectId: string, datasetId: string, col: string) => void
  toggleCol: (datasetId: string, col: string) => void
  clearSelectedCols: (datasetId: string) => void
  applyEdit: (projectId: string, datasetId: string, rowIndex: number, column: string, value: string) => void
  fetchVersions: (projectId: string, datasetId: string) => Promise<void>
  restoreVersion: (projectId: string, datasetId: string, versionId: string) => Promise<void>
  exportCsv: (projectId: string, datasetId: string, filename: string) => void
}
```

单元格编辑后 3 秒 debounce 自动创建版本快照（`POST /api/projects/{pid}/datasets/{did}/versions/snapshot`）。

---

## 3. SSE Hook 设计

### 3.1 useAnalysisStream

核心 hook，管理 SSE 连接和事件分发到各 store。使用 `useChatStore.getState()` 直接访问 store actions（不通过 hook selector）。

```typescript
function useAnalysisStream() {
  const activeRun = useRef<{ eventSource: EventSource; chartRecordId: number } | null>(null)

  const submit = useCallback((query: string, projectId: string) => {
    // 1. 清理旧连接和占位 chart record（如有）
    if (activeRun.current) {
      activeRun.current.eventSource.close()
      useResultsStore.getState().removeChartRecord(activeRun.current.chartRecordId)
    }

    // 2. 创建对话交换（多项目多会话）
    const { exchangeId, sessionId } = useChatStore.getState().addExchange(projectId, query)

    // 3. 创建 running 状态的 chart 占位卡片
    const chartRecordId = useResultsStore.getState().startChartRecord(query)

    // 4. 建立 SSE 连接
    const eventSource = new EventSource(
      `/api/analyze/stream?project_id=${projectId}&query=${encodeURIComponent(query)}`
    )
    activeRun.current = { eventSource, chartRecordId }

    // 5. progress 事件 → 更新 trace
    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data)
      useChatStore.getState().updateTrace(projectId, sessionId, exchangeId, data.steps)
    })

    // 6. result 事件 → 仅处理 SQL steps 到 chat（viz 忽略，防 critic retry 重复）
    eventSource.addEventListener('result', (e) => {
      const data = JSON.parse(e.data)
      if (data.type === 'sql' && data.steps) {
        useChatStore.getState().addSqlSteps(projectId, sessionId, exchangeId, data.steps)
      }
    })

    // 7. done 事件 → 统一写入 resultsStore
    eventSource.addEventListener('done', (e) => {
      const data = JSON.parse(e.data)
      const { setReply, setStatus } = useChatStore.getState()
      setReply(projectId, sessionId, exchangeId, data.report.conclusion)
      setStatus(projectId, sessionId, exchangeId, 'done')

      const datasetVersions = data.dataset_versions || {}

      // Chart — finalize 或 remove
      if (data.viz_result?.series) {
        useResultsStore.getState().finalizeChartRecord(chartRecordId, {
          /* mapped chart data + datasetVersions */
        })
      } else {
        useResultsStore.getState().removeChartRecord(chartRecordId)
      }

      // SQL
      if (data.sql_result?.steps?.length) {
        useResultsStore.getState().addSqlRecord({
          query, steps: data.sql_result.steps, datasetVersions,
        })
      }

      // Report
      if (data.report?.should_record) {
        useResultsStore.getState().addReportRecord({
          query, conclusion: data.report.conclusion,
          chartData: data.viz_result ? /* mapped */ null : null,
          sqlSteps: data.sql_result?.steps || [],
          evidence: data.report.evidence || null,
          datasetVersions,
        })
      }
      eventSource.close()
      activeRun.current = null
    })

    // 8. error 事件
    eventSource.addEventListener('error', (e) => {
      const { setError } = useChatStore.getState()
      setError(projectId, sessionId, exchangeId,
        e instanceof MessageEvent ? JSON.parse(e.data).message : 'Connection lost')
      useResultsStore.getState().removeChartRecord(chartRecordId)
      eventSource.close()
      activeRun.current = null
    })
  }, [])

  return { submit }
}
```

**导出辅助函数**：`detectSimpleModeRisk(query, datasets)` — 检查用户 query 是否涉及有 warning issue 的列，返回 `SimpleModeRiskReminder | null`。

### 3.2 事件分发映射

SSE 事件与 store action 的完整映射关系：

```
SSE event         → Store action                          → UI 变化
─────────────────────────────────────────────────────────────────────────
progress          → chatStore.updateTrace()                → ThinkingBlock 步骤实时更新
result (sql)      → chatStore.addSqlSteps()                → Chat 内 SqlPreviewGroup 数据填充
result (viz)      → （忽略，防止 Critic 重试时重复）       → —
done              → chatStore.setReply() + setStatus()     → AnalystReply 淡入，ThinkingBlock 折叠
                  → resultsStore.finalizeChartRecord()     → Chart Tab 占位卡片填充数据
                  → resultsStore.addSqlRecord()            → SQL Tab 新增条目
                  → resultsStore.addReportRecord()         → Report Tab 新增 section（含 evidence）
error             → chatStore.setError()                   → analyst-error 显示
                  → resultsStore.removeChartRecord()       → 移除占位卡片
```

**关键设计**：所有 `resultsStore` 的写入统一在 `done` 事件中执行（`finalizeChartRecord` 除外，它在 `submit` 时创建占位）。中间 `result` 事件只更新 chat 显示。这确保 Critic Agent 重试后不会产生重复的图表/SQL/报告记录。

### 3.3 SSE 连接管理

当前实现无自动重连逻辑。error 事件直接设置错误状态、清理资源、关闭连接。通过 `activeRun` ref 跟踪当前 EventSource 和 chartRecordId，支持在新 submit 时清理旧连接。

---

## 4. 交互逻辑实现

### 4.1 折叠/展开（统一模式）

Chart entry、SQL entry、Report entry 各自内联实现 toggle 逻辑：

```typescript
// 在 ResultsStore 中：
toggleChartEntry: (id) => set(s => ({ expandedChart: s.expandedChart === id ? null : id }))
toggleSqlEntry: (id) => set(s => ({ expandedSql: s.expandedSql === id ? null : id }))
toggleReportEntry: (id) => set(s => ({ expandedReport: s.expandedReport === id ? null : id }))
```

组件层通过 `expanded === record.id` 判断是否渲染 body。

### 4.2 图表类型切换

纯前端状态，不触发后端请求：

```typescript
switchChartView: (id, type) => set(state => ({
  chartRecords: state.chartRecords.map(r =>
    r.id === id ? { ...r, activeType: type } : r
  )
}))
```

组件根据 `activeType` 渲染对应的 Recharts 组件。`table` 视图渲染 `<DataTable>` 组件，其余渲染 `<ResponsiveContainer>` 包裹的 Recharts 图表。

### 4.3 Chart 数据处理（seriesMeta / labelToKey）

ChartTab 的 `ChartRenderer` 内部使用 `seriesMeta` 和 `labelToKey` 系统防止 series 名称冲突：

```typescript
// seriesMeta：为每个 series 生成唯一内部 key
const seriesMeta = normalizedSeries.map((s, idx) => ({
  key: `s_${idx}`,           // 内部 key，用于 Recharts dataKey
  label: deduped(s.name),    // 显示 label，重名时加 #n 后缀
  source: s,                 // 原始 series 数据
}))

// labelToKey：display label → internal key 的映射
const labelToKey = new Map(seriesMeta.map(m => [m.label, m.key]))

// chartData：使用内部 key 存值
chartData = xValues.map((x, i) => ({
  x,
  ...Object.fromEntries(seriesMeta.map(m => [m.key, toFiniteNumber(m.source.y[i])]))
}))
```

Recharts 组件的 `dataKey` 使用内部 key（`s_0`），`name` 使用 display label，确保渲染正确。

### 4.4 SortedTooltip

自定义 tooltip 组件，同时展示 x 轴和 y 轴信息：

```typescript
<SortedTooltip
  xLabel={xAxisLabel}     // x 轴标签名（如 "jp_sales"）
  visibleSeries={visible} // 当前可见的 series display labels
  colorByName={colorMap}  // display label → 颜色映射
/>
```

内部使用 `String(p.name ?? p.dataKey)` 过滤和显示 payload，确保匹配 `visibleSeries` 中的 display label。Header 格式为 `xLabel: formattedValue`（如 `jp_sales: 0.99`），x 轴标签颜色 `#6b7280`，值颜色 `#8a8c94`。

### 4.5 范围滑块（RangeSlider）

```typescript
const showRangeControls =
  (activeType === 'line' || activeType === 'area') &&
  xIsTemporal &&
  chartData.length > 20 &&
  !swapAxes
```

`xIsTemporal` 要求所有 x 值都通过 temporal 检测（使用 `every()` 而非 `some()`），确保仅对纯时间序列显示范围控制。

### 4.6 策略版本更新

`confirmSchema(projectId)` 是异步操作，调用后端 `POST /api/projects/{projectId}/confirm`，从响应获取 `strategy_version` 和 `active_tables`。

### 4.7 Dataset Panel 新增能力（2026-03）

本次新增聚焦在「测试效率」和「重启可恢复性」：不需要重复上传同一份数据，也可以在前后端重启后快速恢复项目。

1. Upload Zone 新增 debug 入口（`debug: choose existing dataset`）
2. 点击后调用后端 `GET /api/debug/projects`，列出本地 `data/processed/proj_*.duckdb`
3. 选择项目后执行恢复链路：
  - `projectStore.upsertProject(project)`：将恢复项目合并到 Sidebar 列表
  - `projectStore.selectProject(projectId)`：切换当前项目
  - `schemaStore.switchProject(projectId)`：切换 schema 本地 cache 上下文
  - `schemaStore.loadProjectSchema(projectId)`：从后端拉取 schema，重建 Dataset Panel
4. 恢复完成后按 `systemMode` 自动控制 panel 展开状态：
  - `chat`：默认收起（只保留 header）
  - 其他：保持展开，继续决策

### 4.8 `loadProjectSchema` 的恢复语义

`schemaStore.loadProjectSchema(projectId)` 是 Dataset Panel 的恢复入口。其职责不是复用上传时的原始扫描结果，而是将「已确认数据集」最小可用信息恢复到前端：

1. `datasets[]`：`id/name/row_count/column_count/columns/confirmed`
2. `strategy_version`
3. `system_mode`
4. `active_tables`

恢复后的 dataset 采用以下约定：

- `blockingIssues/warningIssues/autoConverted` 置空（这些属于上传时扫描上下文，不保证长期持久化）
- `confirmed` 由后端返回值驱动
- `systemMode` 优先使用后端 `system_mode`，缺失时按 `datasets.length` 兜底

### 4.9 Dataset Panel 后续能力续记（2026-03-26）

以下为 4.7/4.8 之后新增的 Dataset Panel 与清洗交互能力：

1. warning 决策粒度从列级升级为 issue 级（`column:issue_type`），同列多个 warning 可分别处理
2. warning 区按列分组渲染，降低重复列噪音
3. 类型徽章统一为 `TypePill`，文本/数字/日期/布尔采用差异化视觉与图标前缀
4. 推断为 `DOUBLE` 的列在 warning/blocking 区统一显示数字类型（`#`）

### 4.10 分析模式（simple / advanced）

SchemaStore 新增：

- `analysisMode: 'simple' | 'advanced'`
- localStorage 持久化（键：`c2d.analysisMode`）

模式化行为：

1. simple：上传后自动应用默认策略并自动 confirm
2. advanced：保留人工决策，must-solve warning 未处理前禁止 confirm

### 4.11 warning 交互升级（advanced）

advanced 下 warning 选项交互新增"已解决自动折叠"模式：

1. 选择任一处理选项后，warning 条目折叠为绿色 `✓` 摘要
2. 摘要显示列名 + 当前已选策略
3. 点击摘要可重新展开编辑

该行为与 blocking row 的已解决态交互对齐，减少长面板滚动负担。

### 4.12 must-solve 阻塞统计

`allResolved()` 的前端语义扩展为：

1. blocking issue 全部 resolved
2. must-solve warning 全部已选策略

顶部状态条和 footer 的 must resolve 计数，统一纳入上述两类未决项。

### 4.13 查询前提醒（simple）

simple 模式新增查询前风险提醒：

1. query 命中高风险列（missing/outlier warning）时触发提醒
2. 提醒使用自定义弹窗（替代原生 confirm）
3. 支持"本会话不再提醒"

---

## 5. 导出逻辑

### 5.1 Chart 导出

SVG 导出包含标题注入、深色背景和主题样式：

```typescript
function exportChart(chartEl: SVGElement, rec: ChartRecord) {
  if (rec.activeType === 'table') {
    // Table 模式 → CSV 导出
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    triggerDownload(new Blob([csv]), filename)
    return
  }

  // SVG 模式
  const clone = chartEl.cloneNode(true) as SVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  // 注入深色背景
  const bg = createSVGRect({ fill: '#09090b', width: '100%', height: '100%' })
  clone.insertBefore(bg, clone.firstChild)

  // 注入标题（扩展 viewBox 高度 +44px）
  const titleText = (rec.title || rec.query || '').trim()
  if (titleText) {
    // 1. 扩展 viewBox
    // 2. 将现有图形内容下移 44px（<g transform="translate(0 44)">）
    // 3. 插入 header band（深色 rect + 分隔线）
    // 4. 插入标题文本（IBM Plex Mono, #3effa0, 13px, 600 weight）
  }

  const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' })
  triggerDownload(blob, filename)
}
```

Copy data 使用 `navigator.clipboard.writeText().then()` 将 tableData 序列化为 TSV，复制成功后显示 "✓ copied" 反馈。

### 5.2 Report 导出

使用纯 JS 的 miniZip 构建器生成 zip（STORE 压缩，含 CRC-32 校验）。Report 导出实际使用 HTML+SVG zip 格式（非 Markdown），HTML 单文件自包含暗色主题样式。

### 5.3 miniZip

纯 JS zip 构建器，STORE 方法（不压缩），含 CRC-32 校验以兼容 macOS Archive Utility。位于 `frontend/src/utils/miniZip.ts`。

---

## 6. 数据流总览

一次完整的用户提问 → 结果展示的前端数据流：

```
用户输入 query
    │
    ▼
InputArea.onSubmit()
    │
    ├─→ chatStore.addExchange(projectId, query)  → exchange 创建（pending 状态）
    │     返回 { exchangeId, sessionId }           → analyst 头像 + 绿色跳动圆点出现
    │
    ├─→ resultsStore.startChartRecord(query)      → Chart Tab 出现 running 占位卡片
    │
    ▼
useAnalysisStream.submit(query, projectId)
    │
    ├─→ SSE 连接建立（EventSource）
    │
    ▼  progress event（Planner 完成）
    │
    ├─→ chatStore.updateTrace(projectId, sessionId, exchangeId, steps)
    │                                       → ThinkingBlock 出现，步骤逐条滑入
    │
    ▼  progress event ×N（SQL Agent 执行中）
    │
    ├─→ chatStore.updateTrace(...)          → ThinkingBlock 步骤实时更新
    │
    ▼  result(sql) event
    │
    ├─→ chatStore.addSqlSteps(...)          → SQL 步骤数据存入 exchange
    │
    ▼  done event
    │
    ├─→ chatStore.setReply() + setStatus()  → AnalystReply 淡入，ThinkingBlock 折叠
    ├─→ resultsStore.finalizeChartRecord()  → Chart Tab 占位卡片填充数据
    ├─→ resultsStore.addSqlRecord()         → SQL Tab 新增条目
    ├─→ resultsStore.addReportRecord()      → Report Tab 新增 section（含 evidence）
    ▼
SSE 连接关闭
```

---

## 7. 文件结构

```
frontend/src/
├── components/
│   ├── layout/
│   │   ├── Topbar.tsx
│   │   ├── Sidebar.tsx
│   │   ├── IconSidebar.tsx         ← 图标侧边栏
│   │   ├── Resizer.tsx
│   │   ├── MainColumn.tsx
│   │   └── ResultsPanel.tsx
│   │
│   ├── schema/
│   │   └── SchemaPanel.tsx          ← 包含 UploadZone, DatasetContent,
│   │                                   BlockingRow (内联组件)
│   │
│   ├── chat/
│   │   └── ChatPanel.tsx            ← 包含 ConversationTurn, ThinkingBlock,
│   │                                   SqlPreviewGroup, HintChip (内联组件)
│   │
│   ├── results/
│   │   ├── chart/
│   │   │   └── ChartTab.tsx         ← Recharts 渲染 + 类型切换 + SVG/CSV 导出
│   │   │                               (含 ChartEntry, ChartRenderer, DataTable,
│   │   │                                SortedTooltip, InteractiveLegend,
│   │   │                                RunningStateCard, VersionBadge 内联)
│   │   ├── dataset/
│   │   │   ├── DatasetTab.tsx       ← 数据集预览入口
│   │   │   ├── DataGrid.tsx         ← 可编辑数据表格
│   │   │   └── VersionPanel.tsx     ← 版本历史面板
│   │   ├── sql/
│   │   │   └── SqlTab.tsx           ← SQL 记录列表 + 可折叠代码块
│   │   └── report/
│   │       └── ReportTab.tsx        ← 结构化报告 + evidence + 嵌入图表
│   │                                   + HTML+SVG zip 导出
│   │
│   └── ErrorBoundary.tsx            ← 错误边界组件
│
├── stores/
│   ├── projectStore.ts
│   ├── schemaStore.ts              ← 含 _cache 项目切换机制
│   ├── chatStore.ts                ← 多项目多会话架构
│   ├── resultsStore.ts             ← 含 startChartRecord/finalizeChartRecord
│   ├── uiStore.ts
│   └── datasetStore.ts             ← 数据集预览/编辑/版本管理
│
├── hooks/
│   ├── useAnalysisStream.ts         ← SSE 连接管理 + detectSimpleModeRisk
│   └── useResizer.ts                ← 拖拽调整面板宽度
│
├── styles/
│   ├── globals.css                  ← CSS 变量、reset、全局动画
│   ├── layout.css                   ← 布局、sidebar、topbar、resizer
│   ├── schema.css                   ← Schema Panel、blocking row、upload zone
│   └── chat.css                     ← 对话气泡、ThinkingBlock、typing dots
│
├── utils/
│   └── miniZip.ts                   ← 纯 JS zip 构建器（CRC-32，无依赖）
│
├── App.tsx
└── main.tsx
```

---

## 8. 关键实现备注

**为什么 store 之间不直接互相引用？**
避免循环依赖和不可预测的更新顺序。跨 store 的联动（如 confirmSchema 触发后端调用、Sidebar 切换项目时调用 schemaStore.switchProject）通过 `useStore.getState()` 在 action 内部访问，不在 selector 层做。

**为什么聊天用对话气泡而不是折叠式 exchange 列表？**
折叠列表更像日志查看器，交互割裂——展开/折叠点击频繁，信息流不连贯。对话气泡让用户感觉在和"一个分析师"聊天：用户消息右对齐，analyst 回复左对齐（带头像），thinking 过程内联在对话流里。多轮对话自然滚动，不需要手动展开/折叠。

**为什么 ThinkingBlock 完成后自动折叠？**
thinking 步骤是过程信息，用户关心的是结论。完成后 600ms 延迟自动折叠为 "✓ 3 steps completed" 一行，让结论紧跟在用户提问下方，减少视觉干扰。但保留点击展开——需要查看执行细节时随时可以打开。

**为什么 schemaStore 用 _cache 机制做项目切换？**
用户可能在多个项目间来回切换，每次切换需要恢复对应项目的数据集状态（已上传的文件、blocking issues 的决策、confirm 状态）。`_cache: Record<projectId, ProjectSchemaState>` 在切换前保存当前状态，切换后恢复目标状态。比每次切换都重新请求后端快得多，也避免了重复上传。

**为什么用 Recharts 而不是 Plotly？**
Viz Agent 输出结构化 series 数据（x/y 数组 + 图表类型），前端用 Recharts 渲染。Recharts 约 200KB（vs Plotly 约 3MB），前端完全控制暗色主题样式，类型切换纯前端不调后端。LLM 生成简单 JSON `{type, series}` 的准确率远高于生成复杂的 Plotly config（嵌套深、字段多、拼写敏感）。

**为什么 resultsStore 只在 done 事件添加记录？**
中间 `result` 事件只更新 chatStore（显示在对话中），不添加到 resultsStore。因为 Critic Agent 可能打回重试——如果中间就添加，重试后会叠加出多份图表/SQL 记录。统一在 `done` 事件处理，此时 Critic 已通过，数据是最终版本。

**为什么 Chart 使用 seriesMeta/labelToKey 内部 key 系统？**
Recharts 的 `dataKey` 用于从 `chartData` 对象取值。如果直接用 series display name（如 "Revenue"）作为 key，当名称包含特殊字符或有重复名称时会导致渲染失败。内部 key（`s_0`/`s_1`）保证唯一且安全，display label 通过 `name` prop 单独传递。

**为什么 SortedTooltip 用 p.name 而不是 p.dataKey？**
Recharts 的 tooltip payload 中 `p.dataKey` 是内部 key（`s_0`），`p.name` 是 display label（`Revenue`）。`visibleSeries` 中存储的是 display label，因此匹配和显示都需要用 `p.name`。

**为什么 Report 导出用 HTML+SVG zip 而不是 Markdown？**
Markdown 无法嵌入图表（只能引用外部文件路径，但 MD 阅读器不一定支持相对路径 SVG）。HTML 单文件自包含暗色主题样式，`<img src="chart-N.svg">` 引用同目录 SVG，浏览器打开就是完整报告。zip 确保目录结构完整。

**为什么 SSE 用 EventSource 而不是 fetch + ReadableStream？**
EventSource 原生支持事件类型分发，和 FastAPI 的 SSE 端点直接对接，不需要手动解析 `data:` 前缀。缺点是只支持 GET，但分析请求的 query 参数放 URL 里完全够用。

**为什么 Report evidence 字段可以为 null？**
null 意味着这条记录不需要 evidence section（纯事实查询）。组件层 `{record.evidence && <EvidenceSection ... />}` 即可条件渲染，不需要额外的 flag 字段。
