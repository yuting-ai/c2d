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
│   │   └── <ChatPanel>               ← chat mode 时显示
│   │       ├── <ChatMessages>
│   │       │   └── <ChatExchange> ×N  ← 折叠式 Q&A 块
│   │       │       ├── <ExchangeHeader>   ← 点击折叠/展开
│   │       │       └── <ExchangeBody>
│   │       │           ├── <UserMessage>
│   │       │           └── <AgentMessage>
│   │       │               ├── <AgentTrace>
│   │       │               └── <AgentBubble>
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

管理对话内容、exchange 折叠状态。

```typescript
interface Exchange {
  id: number
  query: string
  userMessage: string
  agentTrace: TraceStep[] | null   // null = 还没有 trace
  agentReply: string | null        // null = 还在分析
  status: 'pending' | 'streaming' | 'done' | 'error'
}

interface TraceStep {
  agent: string
  label: string
  status: 'done' | 'active' | 'waiting'
}

interface ChatStore {
  // State
  exchanges: Exchange[]
  expandedExchangeId: number | null  // 当前展开的 exchange，null = 全部折叠

  // Actions
  addExchange: (query: string) => number     // 返回新 exchange ID
  updateTrace: (id: number, steps: TraceStep[]) => void
  setReply: (id: number, reply: string) => void
  setStatus: (id: number, status: Exchange['status']) => void
  toggleExchange: (id: number) => void
  expandExchange: (id: number) => void       // 强制展开（jumpToChat 用）
  scrollToExchange: (id: number) => void     // 滚动 + 高亮闪烁
}
```

 **折叠策略** ：新 exchange 创建时自动设为 `expandedExchangeId`，其他不主动折叠。用户手动切换时更新。`jumpToChat` 调用 `expandExchange` + `scrollToExchange`。

### 2.4 Results Store

管理右侧面板所有 Tab 的数据和 UI 状态。

```typescript
interface ChartRecord {
  id: number
  query: string
  defaultType: string                         // agent 选择的默认类型
  altTypes: string[]                          // agent 推荐的备选 + "table" 固定
  activeType: string                          // 当前选中的类型
  chartConfigs: Record<string, any>           // { line: plotlyConfig, bar: plotlyConfig, ... }
  tableData: { headers: string[], rows: any[][] } | null
  status: 'done' | 'running'
  strategyVersion: number
}

interface SqlRecord {
  id: number
  query: string
  steps: { title: string, sql: string, tag: string }[]
  status: 'done' | 'running'
  strategyVersion: number
}

interface ReportRecord {
  id: number
  query: string
  time: string
  conclusion: string
  criticNote: string
  chartSvg: string | null                     // 嵌入 Report 的 SVG 字符串
  evidence: EvidenceData | null               // null = 不展示
  starred: boolean
  status: 'done' | 'running'
  strategyVersion: number
}

interface EvidenceData {
  tests: { key: string, value: string }[]     // p 值、置信区间、r² 等
  anomalies: { icon: string, text: string }[]
}

interface ResultsStore {
  // State
  activeTab: 'schema' | 'chart' | 'sql' | 'report'
  chartRecords: ChartRecord[]
  sqlRecords: SqlRecord[]
  reportRecords: ReportRecord[]

  // 折叠状态：各 Tab 当前展开的 record ID（null = 全部折叠）
  expandedChart: number | null
  expandedSql: number | null
  expandedReport: number | null

  // Actions
  setActiveTab: (tab: string) => void

  // Chart
  addChartRecord: (record: ChartRecord) => void
  switchChartView: (id: number, type: string) => void
  toggleChartEntry: (id: number) => void

  // SQL
  addSqlRecord: (record: SqlRecord) => void
  toggleSqlEntry: (id: number) => void

  // Report
  addReportRecord: (record: ReportRecord) => void
  toggleReportSection: (id: number) => void
  toggleReportStar: (id: number) => void
  toggleEvidence: (id: number) => void

  // Strategy version — 标记旧记录
  markOutdated: (newVersion: number) => void
}
```

 **新增 record 时的折叠策略** ：`addChartRecord` / `addSqlRecord` / `addReportRecord` 自动将对应的 `expanded*` 更新为新 record 的 ID，确保最新条目始终展开。

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
  const setReply = useChatStore(s => s.setReply)
  const setStatus = useChatStore(s => s.setStatus)
  const addChartRecord = useResultsStore(s => s.addChartRecord)
  const addSqlRecord = useResultsStore(s => s.addSqlRecord)
  const addReportRecord = useResultsStore(s => s.addReportRecord)

  const submit = useCallback(async (query: string, projectId: string) => {
    const exchangeId = addExchange(query)

    const eventSource = new EventSource(
      `/api/analyze/stream?project_id=${projectId}&query=${encodeURIComponent(query)}`
    )

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data)
      updateTrace(exchangeId, data.steps)
    })

    eventSource.addEventListener('result', (e) => {
      const data = JSON.parse(e.data)
      // 中间结果 — 边产出边推送
      if (data.type === 'sql')  addSqlRecord(mapSqlResult(exchangeId, data))
      if (data.type === 'viz')  addChartRecord(mapChartResult(exchangeId, data))
    })

    eventSource.addEventListener('record', (e) => {
      const data = JSON.parse(e.data)
      addReportRecord(mapReportRecord(exchangeId, data))
    })

    eventSource.addEventListener('done', (e) => {
      const data = JSON.parse(e.data)
      setReply(exchangeId, data.report.conclusion)
      setStatus(exchangeId, 'done')
      eventSource.close()
    })

    eventSource.addEventListener('strategy_update', (e) => {
      const data = JSON.parse(e.data)
      useResultsStore.getState().markOutdated(data.newVersion)
    })

    eventSource.addEventListener('error', () => {
      setStatus(exchangeId, 'error')
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
progress          → chatStore.updateTrace()                → AgentTrace 步骤更新
result (sql)      → resultsStore.addSqlRecord()            → SQL Tab 新增条目
result (viz)      → resultsStore.addChartRecord()          → Chart Tab 新增条目
record            → resultsStore.addReportRecord()         → Report Tab 新增 section
done              → chatStore.setReply() + setStatus()     → Agent bubble 出现
strategy_update   → resultsStore.markOutdated()            → 旧记录打版本 tag
quality_block     → schemaStore (TBD)                      → Schema Panel 弹出决策
error             → chatStore.setStatus('error')           → 错误提示
```

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
    ├─→ chatStore.addExchange(query)      → Chat 新增 exchange（pending 状态）
    │
    ▼
useAnalysisStream.submit(query, projectId)
    │
    ├─→ SSE 连接建立
    │
    ▼  progress event ×N
    │
    ├─→ chatStore.updateTrace()           → AgentTrace 步骤实时更新
    │
    ▼  result(sql) event
    │
    ├─→ resultsStore.addSqlRecord()       → SQL Tab 新增条目（自动展开）
    │
    ▼  result(viz) event
    │
    ├─→ resultsStore.addChartRecord()     → Chart Tab 新增条目（自动展开）
    │   chartRecord 包含 altTypes + chartConfigs
    │   前端根据 altTypes 渲染类型切换按钮
    │
    ▼  record event
    │
    ├─→ resultsStore.addReportRecord()    → Report Tab 新增 section（自动展开）
    │   record.evidence 为 null 时不渲染 evidence toggle
    │
    ▼  done event
    │
    ├─→ chatStore.setReply()              → Agent bubble 出现
    ├─→ chatStore.setStatus('done')       → Exchange 完成
    │
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
│   │   ├── Resizer.tsx
│   │   ├── MainColumn.tsx
│   │   └── ResultsPanel.tsx
│   │
│   ├── schema/
│   │   ├── SchemaPanel.tsx
│   │   ├── DatasetTabs.tsx
│   │   ├── BlockingRow.tsx
│   │   ├── WarningRow.tsx
│   │   └── ConfirmWrap.tsx
│   │
│   ├── chat/
│   │   ├── ChatPanel.tsx
│   │   ├── ChatExchange.tsx
│   │   ├── AgentTrace.tsx
│   │   ├── UserBubble.tsx
│   │   ├── AgentBubble.tsx
│   │   └── InputArea.tsx
│   │
│   ├── results/
│   │   ├── TabBar.tsx
│   │   ├── SchemaTab.tsx
│   │   ├── chart/
│   │   │   ├── ChartTab.tsx
│   │   │   ├── ChartEntry.tsx
│   │   │   ├── ChartTypeBar.tsx
│   │   │   ├── ChartViews.tsx
│   │   │   └── ChartTable.tsx
│   │   ├── sql/
│   │   │   ├── SqlTab.tsx
│   │   │   └── SqlEntry.tsx
│   │   └── report/
│   │       ├── ReportTab.tsx
│   │       ├── ReportSection.tsx
│   │       ├── EvidenceSection.tsx
│   │       ├── CriticNote.tsx
│   │       └── SectionExportBtn.tsx
│   │
│   └── shared/
│       ├── EntryAnchor.tsx          ← Chart/SQL/Report 共用的折叠锚点行
│       ├── StrategyTag.tsx          ← amber 版本标签
│       └── FlashHighlight.tsx       ← jumpToChat 高亮动画
│
├── stores/
│   ├── projectStore.ts
│   ├── schemaStore.ts
│   ├── chatStore.ts
│   ├── resultsStore.ts
│   └── uiStore.ts
│
├── hooks/
│   ├── useAnalysisStream.ts         ← SSE 连接管理
│   ├── useResizer.ts                ← 拖拽调整面板宽度
│   └── useJumpToChat.ts             ← 右侧 → 左侧联动
│
├── utils/
│   ├── miniZip.ts                   ← zip 构建器（含 CRC-32）
│   ├── exportHelpers.ts             ← SVG/data 导出、buildSectionMd
│   └── connectivity.ts              ← BFS 连通性检查
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
避免循环依赖和不可预测的更新顺序。跨 store 的联动（如 confirmSchema 触发 markOutdated）通过 `useStore.getState()` 在 action 内部访问，不在 selector 层做。

**为什么折叠状态用单个 ID 而不是 Set？**
当前设计是"同时只展开一条"（最新的），用单个 `expandedId` 比 `Set<number>` 更简单。如果未来需要支持多条同时展开，改为 Set 即可，组件层的 `expanded === id` 改为 `expandedSet.has(id)`，影响范围很小。

**为什么 ChartRecord 存 chartConfigs 而不是只存 data？**
Viz Agent 返回的是各类型对应的 Plotly 配置（已经是可渲染的配置），前端只需要根据 activeType 选择对应的 config 传给 `<Plot>`。如果只存 data，前端还需要自己组装 Plotly 配置，逻辑重复且容易和 agent 输出不一致。

**为什么 SSE 用 EventSource 而不是 fetch + ReadableStream？**
EventSource 原生支持自动重连、事件类型分发、最后事件 ID 追踪，和 FastAPI 的 SSE 端点直接对接，不需要手动解析 `data:` 前缀。缺点是只支持 GET，但分析请求的 query 参数放 URL 里完全够用（query 文本一般不超过几百字符）。如果未来 query 变复杂（比如携带大量 context），可以改为 POST + fetch stream，hook 接口不变。

**为什么 Report evidence 字段可以为 null？**
null 意味着这条记录不需要 evidence section（纯事实查询）。组件层 `{record.evidence && <EvidenceSection ... />}` 即可条件渲染，不需要额外的 flag 字段。这比 `hasEvidence: boolean` + `evidence: EvidenceData` 两个字段更简洁，且不可能出现 `hasEvidence=true` 但 `evidence=undefined` 的不一致状态。
