
# c2d — Frontend Implementation

本文档覆盖前端实现层面的具体设计，是 architecture.md Section 9（UI Design）的 implementation 对照。architecture.md 负责"是什么、为什么"，本文档负责"怎么实现"。

技术栈：React + Vite + Zustand + TypeScript

---

## 1. Component Tree

```
<App>
├── <Topbar>
│   ├── <SidebarToggle>
│   ├── <Logo>
│   ├── <DatasetToggleGroup>          ← 数据集开关，联动 Schema Store
│   │   └── <DatasetToggleItem> ×N
│   └── <TopbarRight>
│       ├── <AgentBadge>              ← 显示 agent 状态（pulse dot）
│       └── <ExportButton>
│
├── <Layout>                           ← flex row，三栏容器
│   ├── <Sidebar>                      ← 默认 collapsed
│   │   ├── <NewAnalysisBtn>
│   │   ├── <SidebarSection label="★ Starred">
│   │   │   └── <ProjectItem> ×N
│   │   └── <SidebarSection label="Today / Yesterday / ...">
│   │       └── <ProjectItem> ×N
│   │
│   ├── <Resizer side="left">
│   │
│   ├── <MainColumn>                   ← flex: 4（40%）
│   │   ├── <SchemaPanel>              ← clean mode 占满，chat mode 收起为 header
│   │   │   ├── <SchemaPanelHeader>
│   │   │   ├── <DatasetTabs>
│   │   │   ├── <DatasetContent>
│   │   │   │   ├── <DatasetOverview>
│   │   │   │   ├── <BlockingSection>
│   │   │   │   │   └── <BlockingRow> ×N  ← resolved / unresolved 状态
│   │   │   │   ├── <WarningSection>
│   │   │   │   └── <AutoConvertedSection>
│   │   │   └── <ConfirmWrap>
│   │   │       ├── <StrategyNotice>   ← 重新展开时显示
│   │   │       └── <ConfirmButton>
│   │   │
│   │   └── <ChatPanel>               ← chat mode 时显示，对话式 UI
│   │       ├── <ChatMessages>
│   │       │   └── <ConversationTurn> ×N  ← 每轮：用户气泡 + analyst 回复
│   │       │       ├── <MsgUser>          ← 右对齐气泡
│   │       │       └── <MsgAnalyst>       ← 左对齐，analyst 头像
│   │       │           ├── <AnalystHeader>     ← 绿色 A 头像 + "analyst"
│   │       │           └── <AnalystContent>
│   │       │               ├── <ThinkingBlock>  ← trace 步骤，完成后自动折叠
│   │       │               ├── <TypingDots>     ← 绿色跳动圆点（pending/streaming）
│   │       │               ├── <AnalystReply>   ← 结论文本
│   │       │               └── <SqlPreviewGroup> ← 可折叠 SQL 预览
│   │       └── <InputArea>
│   │           ├── <HintChips>
│   │           └── <InputRow>
│   │
│   ├── <Resizer side="right">
│   │
│   └── <ResultsPanel>                ← flex: 6（60%）
│       ├── <TabBar>                   ← schema / chart / sql / report
│       └── <TabContent>
│           ├── <SchemaTab>
│           ├── <ChartTab>
│           │   └── <ChartEntry> ×N    ← 折叠式
│           │       ├── <EntryAnchor>
│           │       └── <EntryBody>
│           │           └── <ChartCard>
│           │               ├── <ChartTypeBar>
│           │               │   ├── <TypeButton> ×N
│           │               │   └── <ExportGroup>
│           │               │       ├── <SVGExportBtn>
│           │               │       └── <CopyDataBtn>
│           │               └── <ChartViews>
│           │                   └── <ChartView> ×N   ← line/area/bar/pie/table
│           │
│           ├── <SqlTab>
│           │   └── <SqlEntry> ×N      ← 折叠式，共用 EntryAnchor
│           │       └── <SqlCard> ×N   ← 可能多步 SQL
│           │
│           └── <ReportTab>
│               ├── <ReportHeader>
│               │   └── <GlobalExportBtn>
│               └── <ReportSection> ×N ← 折叠式
│                   ├── <SectionAnchor>
│                   └── <SectionBody>
│                       ├── <EmbeddedChart>
│                       ├── <Conclusion>
│                       ├── <CriticNote>
│                       ├── <EvidenceToggle>  ← 条件渲染
│                       │   └── <EvidenceBody>
│                       │       ├── <StatGrid>
│                       │       └── <AnomalyList>
│                       └── <SectionExportBtn>
```

---

## 2. Zustand Store 结构

按关注点拆分为 5 个独立 store，互不直接依赖。组件通过 selector 订阅需要的 slice，避免不必要的重渲染。

### 2.1 Project Store

管理分析项目列表和当前选中项目。

```typescript
interface Project {
  id: string
  title: string
  datasetNames: string[]
  createdAt: string
  starred: boolean
}

interface ProjectStore {
  // State
  projects: Project[]
  activeProjectId: string | null

  // Actions
  setProjects: (projects: Project[]) => void
  selectProject: (id: string) => void
  toggleStar: (id: string) => void
  createProject: () => Promise<string>  // 返回新 project ID
}
```

### 2.2 Schema Store

管理数据集状态机、数据清洗决策、策略版本。

```typescript
interface DatasetState {
  id: string
  name: string
  rowCount: number
  active: boolean
  confirmed: boolean
  columns: ColumnInfo[]
  blockingIssues: BlockingIssue[]
  warningIssues: WarningIssue[]
  autoConverted: AutoConversion[]
}

interface BlockingIssue {
  key: string           // "dsIdx-issueIdx"
  column: string
  type: string
  description: string
  options: string[]
  selectedOption: string | null
  resolved: boolean
}

interface SchemaStore {
  // State
  datasets: DatasetState[]
  joinGraph: Record<string, string[]>
  joinKeys: Record<string, JoinResult>
  strategyVersion: number
  systemMode: 'empty' | 'clean' | 'chat'

  // Derived
  allResolved: () => boolean

  // Actions
  toggleDataset: (idx: number) => void    // 含 join graph 校验 + BFS 连通性
  selectOption: (issueKey: string, option: string) => void
  confirmSchema: () => void               // 首次确认 or 策略更新
  unresolveIssue: (issueKey: string) => void

  // Internal
  _checkConnectivity: (closedIdx: number) => number[]  // BFS，返回孤立节点
  _updateSystemMode: () => void
}
```

`systemMode` 的派生逻辑：

```typescript
function deriveSystemMode(datasets: DatasetState[]): SystemMode {
  const active = datasets.filter(d => d.active)
  if (active.length === 0) return 'empty'
  return active.every(d => d.confirmed) ? 'chat' : 'clean'
}
```

### 2.3 Chat Store

管理对话内容。采用对话式 UI（非折叠列表），每个 exchange 是一轮完整的问答。

```typescript
interface Exchange {
  id: number
  query: string
  trace: TraceStep[] | null        // null = 还没有 trace
  reply: string | null             // null = 还在分析
  sqlSteps: SqlStep[]              // SQL 查询步骤（可折叠展示）
  status: 'pending' | 'streaming' | 'done' | 'error'
  error: string | null
}

interface TraceStep {
  agent: string                    // 统一为 "analyst"
  label: string                    // 自然语言描述，如 "querying data · step 1"
  status: 'done' | 'active' | 'waiting'
}

interface SqlStep {
  title: string
  sql: string
  tag: string
}

interface ChatStore {
  // State
  exchanges: Exchange[]

  // Actions
  addExchange: (query: string) => number
  updateTrace: (id: number, steps: TraceStep[]) => void
  addSqlSteps: (id: number, steps: SqlStep[]) => void
  setReply: (id: number, reply: string) => void
  setStatus: (id: number, status: Exchange['status']) => void
  setError: (id: number, error: string) => void
  toggleExchange: (id: number) => void
  expandExchange: (id: number) => void
}
```

 **对话式 UI 渲染策略** ：所有 exchange 平铺展示，不折叠。每轮渲染为：用户气泡（右）→ analyst 头像 + thinking block + reply（左）。ThinkingBlock 在分析完成后自动折叠为一行 "✓ N steps completed"，点击可展开查看。

 **视觉流转** ：

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
  query: string
  type: string                               // line, area, bar, pie, scatter
  altTypes: string[]                         // agent 推荐的备选（table 由前端固定添加）
  activeType: string                         // 当前选中的类型
  title: string
  xLabel: string
  yLabel: string
  series: ChartSeries[]                      // Recharts 直接消费的结构化数据
  tableData: { headers: string[], rows: any[][] } | null
  status: 'done' | 'running'
}

interface SqlRecord {
  id: number
  query: string
  steps: { title: string, sql: string, tag: string }[]
  status: 'done' | 'running'
}

interface EvidenceData {
  tests: { key: string, value: string, significant?: boolean }[]
  anomalies: { icon: string, text: string }[]
}

interface ReportRecord {
  id: number
  query: string
  time: string
  conclusion: string
  chartData: ChartRecord | null              // 嵌入 Report 的迷你图表数据
  sqlSteps: { title: string, sql: string, tag: string }[]
  evidence: EvidenceData | null              // null = 无 stats tests，不展示
  starred: boolean
  status: 'done' | 'running'
}

interface ResultsStore {
  // State
  activeTab: 'schema' | 'chart' | 'sql' | 'report'
  chartRecords: ChartRecord[]
  sqlRecords: SqlRecord[]
  reportRecords: ReportRecord[]
  expandedChart: number | null
  expandedSql: number | null
  expandedReport: number | null

  // Actions
  setActiveTab: (tab: string) => void
  addChartRecord: (record: ChartRecord) => void
  switchChartView: (id: number, type: string) => void
  toggleChartEntry: (id: number) => void
  addSqlRecord: (record: SqlRecord) => void
  toggleSqlEntry: (id: number) => void
  addReportRecord: (record: ReportRecord) => void
  toggleReportEntry: (id: number) => void
  toggleReportStar: (id: number) => void
}
```

 **重要** ：所有 `addXxxRecord` 调用统一在 `done` 事件中执行，不在中间的 `result` 事件中添加。这避免了 Critic Agent 重试时图表/SQL 记录重复叠加。

### 2.5 UI Store

管理纯 UI 状态：sidebar 开关、resizer 宽度、schema panel 状态。

```typescript
interface UIStore {
  // Sidebar
  sidebarOpen: boolean
  toggleSidebar: () => void

  // Schema Panel
  schemaPanelOpen: boolean
  toggleSchemaPanel: () => void

  // Active dataset tab in schema panel
  activeDsTab: number
  switchDsTab: (idx: number) => void
}
```

---

## 3. SSE Hook 设计

### 3.1 useAnalysisStream

核心 hook，管理 SSE 连接和事件分发到各 store。

```typescript
function useAnalysisStream() {
  const addExchange = useChatStore(s => s.addExchange)
  const updateTrace = useChatStore(s => s.updateTrace)
  const addSqlSteps = useChatStore(s => s.addSqlSteps)
  const setReply = useChatStore(s => s.setReply)
  const setStatus = useChatStore(s => s.setStatus)
  const setError = useChatStore(s => s.setError)

  const submit = useCallback((query: string, projectId: string) => {
    const exchangeId = addExchange(query)
    const eventSource = new EventSource(
      `/api/analyze/stream?project_id=${projectId}&query=${encodeURIComponent(query)}`
    )

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data)
      updateTrace(exchangeId, data.steps)
    })

    // result events — only update chat display, NOT resultsStore
    // (prevents duplication during Critic retries)
    eventSource.addEventListener('result', (e) => {
      const data = JSON.parse(e.data)
      if (data.type === 'sql') addSqlSteps(exchangeId, data.steps)
      // viz result events ignored here — handled in done event
    })

    // done event — all results finalized, safe to populate resultsStore
    eventSource.addEventListener('done', (e) => {
      const data = JSON.parse(e.data)
      setReply(exchangeId, data.report.conclusion)
      setStatus(exchangeId, 'done')

      // Add to Chart Tab (from viz_result)
      if (data.viz_result?.series) {
        useResultsStore.getState().addChartRecord(mapChartData(query, data.viz_result))
      }
      // Add to SQL Tab
      if (data.sql_result?.steps?.length) {
        useResultsStore.getState().addSqlRecord({ query, steps: data.sql_result.steps })
      }
      // Add to Report Tab (if should_record)
      if (data.report?.should_record) {
        useResultsStore.getState().addReportRecord({
          query, conclusion: data.report.conclusion,
          chartData: data.viz_result ? mapChartData(query, data.viz_result) : null,
          sqlSteps: data.sql_result?.steps || [],
          evidence: data.report.evidence || null,
        })
      }
      eventSource.close()
    })

    eventSource.addEventListener('error', (e) => {
      setError(exchangeId, e instanceof MessageEvent ? JSON.parse(e.data).message : 'Connection lost')
      eventSource.close()
    })
  }, [])

  return { submit }
}
```

### 3.2 事件分发映射

SSE 事件与 store action 的完整映射关系：

```
SSE event         → Store action                          → UI 变化
─────────────────────────────────────────────────────────────────────────
progress          → chatStore.updateTrace()                → ThinkingBlock 步骤实时更新
result (sql)      → chatStore.addSqlSteps()                → Chat 内 SqlPreviewGroup 数据填充
result (viz)      → （忽略，防止 Critic 重试时重复）       → —
done              → chatStore.setReply() + setStatus()     → AnalystReply 淡入，ThinkingBlock 折叠
                  → resultsStore.addChartRecord()          → Chart Tab 新增条目
                  → resultsStore.addSqlRecord()            → SQL Tab 新增条目
                  → resultsStore.addReportRecord()         → Report Tab 新增 section（含 evidence）
error             → chatStore.setError()                   → analyst-error 显示
```

 **关键设计** ：所有 `resultsStore` 的写入统一在 `done` 事件中执行。中间 `result` 事件只更新 chat 显示。这确保 Critic Agent 重试后不会产生重复的图表/SQL/报告记录。
quality_block     → schemaStore (TBD)                      → Schema Panel 弹出决策
error             → chatStore.setError()                   → analyst-error 显示

```

注意：Phase 3 中 SQL 步骤存储在 `chatStore.exchanges[].sqlSteps`，随对话展示。Phase 4 扩展后同时推送到 `resultsStore` 的 SQL Tab。

### 3.3 SSE 重连策略

```typescript
// 连接断开时自动重连，最多 3 次，间隔递增
const RETRY_DELAYS = [1000, 3000, 8000]

eventSource.addEventListener('error', () => {
  if (retryCount < RETRY_DELAYS.length) {
    setTimeout(() => reconnect(), RETRY_DELAYS[retryCount])
    retryCount++
  } else {
    setStatus(exchangeId, 'error')
  }
})
```

---

## 4. 交互逻辑实现

### 4.1 jumpToChat（右侧 → 左侧联动）

Chart / SQL / Report 的 ↗ 按钮触发，用 `stopPropagation` 隔离折叠交互。

```typescript
function jumpToChat(exchangeId: number) {
  const chatStore = useChatStore.getState()

  // 1. 展开对应的 exchange（如果折叠）
  chatStore.expandExchange(exchangeId)

  // 2. 滚动到该 exchange
  const el = document.getElementById(`cx-${exchangeId}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  // 3. 闪烁高亮 1.8 秒
  el?.classList.add('chat-flash')
  setTimeout(() => el?.classList.remove('chat-flash'), 1800)
}
```

### 4.2 折叠/展开（统一模式）

Chat exchange、Chart entry、SQL entry、Report section 共用一套折叠逻辑，差异只在 store 字段名：

```typescript
// Generic toggle — 用于所有折叠式面板
function createToggle(expandedKey: string) {
  return (id: number) => set(state => ({
    [expandedKey]: state[expandedKey] === id ? null : id
  }))
}

// 在 ResultsStore 中：
toggleChartEntry: createToggle('expandedChart'),
toggleSqlEntry: createToggle('expandedSql'),
toggleReportSection: createToggle('expandedReport'),
```

组件层通过 `expanded === record.id` 判断是否渲染 body。

### 4.3 图表类型切换

纯前端状态，不触发后端请求：

```typescript
// ResultsStore
switchChartView: (id, type) => set(state => ({
  chartRecords: state.chartRecords.map(r =>
    r.id === id ? { ...r, activeType: type } : r
  )
}))
```

组件根据 `activeType` 渲染对应的 Plotly config 或 table data。`table` 视图渲染 `<ChartTable>` 组件，其余渲染 `<Plot>` 组件。

### 4.4 策略版本更新

`confirmSchema()` 的前端侧逻辑：

```typescript
// SchemaStore
confirmSchema: () => {
  const isUpdate = get().strategyVersion > 0

  // 校验所有 blocking 已解决
  if (!get().allResolved()) return

  // 标记已确认
  set(state => ({
    datasets: state.datasets.map(d =>
      d.active ? { ...d, confirmed: true } : d
    ),
    strategyVersion: state.strategyVersion + 1,
    systemMode: 'chat'
  }))

  // 如果是更新（非首次），标记旧记录
  if (isUpdate) {
    const newVersion = get().strategyVersion
    useResultsStore.getState().markOutdated(newVersion)
  }
}
```

`markOutdated` 在 ResultsStore 中给 `strategyVersion < newVersion` 的记录打标签，组件层渲染为 amber 色版本 tag。

---

## 5. 导出逻辑

### 5.1 Chart 导出

```typescript
// SVG 下载 — 克隆当前图表 SVG，设置 xmlns，触发 download
function exportChartSVG(chartEl: SVGElement, filename: string) {
  const clone = chartEl.cloneNode(true) as SVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' })
  triggerDownload(blob, filename)
}

// Copy data — 将 tableData 序列化为 TSV，写入剪贴板
function copyChartData(record: ChartRecord) {
  if (!record.tableData) return
  const { headers, rows } = record.tableData
  const tsv = [headers.join('\t'), ...rows.map(r => r.join('\t'))].join('\n')
  navigator.clipboard.writeText(tsv)
}
```

### 5.2 Report 导出

使用纯 JS 的 miniZip 构建器生成 zip（STORE 压缩，含 CRC-32 校验），包含 `.md` + `.svg` 文件。

```typescript
// 全局导出
function exportFullReport(records: ReportRecord[], title: string) {
  const files: ZipFile[] = []
  let md = `# ${title}\n\n---\n\n`

  records.forEach((rec, i) => {
    md += buildSectionMd(rec, i + 1)
    md += '---\n\n'
    if (rec.chartSvg) {
      files.push({ name: `chart-${i + 1}.svg`, content: rec.chartSvg })
    }
  })

  files.unshift({ name: 'report.md', content: md })
  const zip = miniZip(files)
  triggerDownload(new Blob([zip]), `${slugify(title)}.zip`)
}

// 单 section 导出
function exportSection(record: ReportRecord) {
  const files: ZipFile[] = []
  files.push({ name: 'section.md', content: buildSectionMd(record, record.id) })
  if (record.chartSvg) {
    files.push({ name: `chart-${record.id}.svg`, content: record.chartSvg })
  }
  const zip = miniZip(files)
  triggerDownload(new Blob([zip]), `${slugify(record.query)}.zip`)
}
```

### 5.3 buildSectionMd

```typescript
function buildSectionMd(record: ReportRecord, index: number): string {
  let md = `## ${index}. ${record.query}\n\n`
  md += `*${record.time}*\n\n`

  if (record.chartSvg) {
    md += `![Chart](chart-${index}.svg)\n\n`
  }

  md += `${record.conclusion}\n\n`

  if (record.criticNote) {
    md += `> **Critic:** ${record.criticNote}\n\n`
  }

  if (record.evidence) {
    md += '### Evidence\n\n'
    if (record.evidence.tests.length > 0) {
      md += '| Metric | Value |\n|--------|-------|\n'
      record.evidence.tests.forEach(t => {
        md += `| ${t.key} | ${t.value} |\n`
      })
      md += '\n'
    }
    if (record.evidence.anomalies.length > 0) {
      md += '**Anomalies:**\n\n'
      record.evidence.anomalies.forEach(a => {
        md += `- ${a.text}\n`
      })
      md += '\n'
    }
  }

  return md
}
```

### 5.4 miniZip

纯 JS zip 构建器，STORE 方法（不压缩），含 CRC-32 校验以兼容 macOS Archive Utility。

```typescript
function miniZip(files: { name: string, content: string | Uint8Array }[]): Uint8Array {
  // 1. TextEncoder 编码 string → Uint8Array
  // 2. 对每个文件计算 CRC-32（查表法）
  // 3. 构建 local file header（30 + name.length bytes）含 CRC-32 @ offset 14
  // 4. 构建 central directory header（46 + name.length bytes）含 CRC-32 @ offset 16
  // 5. 拼接：local headers + data → central directory → EOCD
  // 见 c2d-preview.html 中的完整实现
}
```

---

## 6. 数据流总览

一次完整的用户提问 → 结果展示的前端数据流：

```
用户输入 query
    │
    ▼
InputArea.onSubmit()
    │
    ├─→ chatStore.addExchange(query)      → exchange 创建（pending 状态）
    │                                       → analyst 头像 + 绿色跳动圆点出现
    ▼
useAnalysisStream.submit(query, projectId)
    │
    ├─→ SSE 连接建立（EventSource）
    │
    ▼  progress event（Planner 完成）
    │
    ├─→ chatStore.updateTrace()           → 跳动圆点消失，ThinkingBlock 出现
    │                                       步骤逐条滑入（planning analysis ✓）
    │
    ▼  progress event ×N（SQL Agent 执行中）
    │
    ├─→ chatStore.updateTrace()           → ThinkingBlock 步骤实时更新
    │                                       （querying data · step 1 ●）
    │
    ▼  result(sql) event
    │
    ├─→ chatStore.addSqlSteps()           → SQL 步骤数据存入 exchange
    │                                       （完成后渲染为可折叠 SqlPreviewGroup）
    │
    ▼  progress event（Report Agent 完成）
    │
    ├─→ chatStore.updateTrace()           → ThinkingBlock 最后一步变 ✓
    │
    ▼  done event
    │
    ├─→ chatStore.setReply()              → ThinkingBlock 600ms 后自动折叠
    ├─→ chatStore.setStatus('done')       → AnalystReply 淡入滑入
    │                                       → SqlPreviewGroup 标签出现
    ▼
SSE 连接关闭

Phase 4 扩展时，在 result(sql) 和 done 之间会增加：
    result(viz)   → resultsStore.addChartRecord()  → Chart Tab 新增
    result(stats)  → （内部传递给 Report Agent）
    record        → resultsStore.addReportRecord() → Report Tab 新增
```

---

## 7. 文件结构

```
frontend/src/
├── components/
│   ├── layout/
│   │   ├── Topbar.tsx
│   │   ├── Sidebar.tsx
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
│   │   ├── TabBar.tsx
│   │   ├── SchemaTab.tsx             ← 列类型/null%/样本值/auto-converted
│   │   ├── chart/
│   │   │   └── ChartTab.tsx         ← Recharts 渲染 + 类型切换 + SVG/CSV 导出
│   │   │                               (含 ChartEntry, ChartRenderer, DataTable 内联)
│   │   ├── sql/
│   │   │   └── SqlTab.tsx           ← SQL 记录列表 + 可折叠代码块
│   │   └── report/
│   │       └── ReportTab.tsx        ← 结构化报告 + evidence + 嵌入图表
│   │                                   + HTML+SVG zip 导出（含 EvidenceSection,
│   │                                   MiniChart, SqlCollapsible, buildHtml 内联）
│   │
│
├── stores/
│   ├── projectStore.ts
│   ├── schemaStore.ts              ← 含 _cache 项目切换机制
│   ├── chatStore.ts
│   ├── resultsStore.ts
│   └── uiStore.ts
│
├── hooks/
│   ├── useAnalysisStream.ts         ← SSE 连接管理（EventSource）
│   ├── useResizer.ts                ← 拖拽调整面板宽度（Phase 4）
│   └── useJumpToChat.ts             ← 右侧 → 左侧联动（Phase 4）
│
├── styles/
│   ├── globals.css                  ← CSS 变量、reset、全局动画
│   ├── layout.css                   ← 三栏布局、sidebar、topbar、resizer
│   ├── schema.css                   ← Schema Panel、blocking row、upload zone
│   └── chat.css                     ← 对话气泡、ThinkingBlock、typing dots
│
├── utils/
│   ├── miniZip.ts                   ← 纯 JS zip 构建器（CRC-32，无依赖）
│   └── connectivity.ts              ← BFS 连通性检查（Phase 4+ join graph 用）
│
├── types/
│   └── index.ts                     ← 所有 TypeScript 接口定义
│
├── App.tsx
└── main.tsx
```

---

## 8. 关键实现备注

**为什么 store 之间不直接互相引用？**
避免循环依赖和不可预测的更新顺序。跨 store 的联动（如 confirmSchema 触发 markOutdated、Sidebar 切换项目时调用 schemaStore.switchProject）通过 `useStore.getState()` 在 action 内部访问，不在 selector 层做。

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

**为什么 Report 导出用 HTML+SVG zip 而不是 Markdown？**
Markdown 无法嵌入图表（只能引用外部文件路径，但 MD 阅读器不一定支持相对路径 SVG）。HTML 单文件自包含暗色主题样式，`<img src="chart-N.svg">` 引用同目录 SVG，浏览器打开就是完整报告。zip 确保目录结构完整。比 Word(.docx) 实现简单（不需要额外库），且图表保持矢量。

**为什么 SSE 用 EventSource 而不是 fetch + ReadableStream？**
EventSource 原生支持自动重连、事件类型分发、最后事件 ID 追踪，和 FastAPI 的 SSE 端点直接对接，不需要手动解析 `data:` 前缀。缺点是只支持 GET，但分析请求的 query 参数放 URL 里完全够用（query 文本一般不超过几百字符）。如果未来 query 变复杂（比如携带大量 context），可以改为 POST + fetch stream，hook 接口不变。

**为什么 Report evidence 字段可以为 null？**
null 意味着这条记录不需要 evidence section（纯事实查询）。组件层 `{record.evidence && <EvidenceSection ... />}` 即可条件渲染，不需要额外的 flag 字段。这比 `hasEvidence: boolean` + `evidence: EvidenceData` 两个字段更简洁，且不可能出现 `hasEvidence=true` 但 `evidence=undefined` 的不一致状态。
