import { create } from 'zustand'

export interface ChartSeries {
  name: string
  x: (string | number)[]
  y: number[]
}

export interface ChartRecord {
  id: number
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
}

export interface SqlRecord {
  id: number
  query: string
  steps: { title: string; sql: string; tag: string }[]
  status: 'done' | 'running'
}

export interface EvidenceData {
  tests: { key: string; value: string; significant?: boolean }[]
  anomalies: { icon: string; text: string }[]
}

export interface ReportRecord {
  id: number
  query: string
  time: string
  conclusion: string
  chartData: ChartRecord | null
  sqlSteps: { title: string; sql: string; tag: string }[]
  evidence: EvidenceData | null          // null = no stats tests, don't show
  starred: boolean
  status: 'done' | 'running'
}

interface ResultsStore {
  activeTab: 'schema' | 'chart' | 'sql' | 'report'
  chartRecords: ChartRecord[]
  sqlRecords: SqlRecord[]
  reportRecords: ReportRecord[]
  expandedChart: number | null
  expandedSql: number | null
  expandedReport: number | null

  setActiveTab: (tab: ResultsStore['activeTab']) => void
  addChartRecord: (record: ChartRecord) => void
  switchChartView: (id: number, type: string) => void
  toggleChartEntry: (id: number) => void
  addSqlRecord: (record: SqlRecord) => void
  toggleSqlEntry: (id: number) => void
  addReportRecord: (record: ReportRecord) => void
  toggleReportEntry: (id: number) => void
  toggleReportStar: (id: number) => void
}

let nextChartId = 1
let nextSqlId = 1
let nextReportId = 1

export const useResultsStore = create<ResultsStore>((set) => ({
  activeTab: 'chart',
  chartRecords: [],
  sqlRecords: [],
  reportRecords: [],
  expandedChart: null,
  expandedSql: null,
  expandedReport: null,

  setActiveTab: (tab) => set({ activeTab: tab }),

  addChartRecord: (record) => {
    const id = nextChartId++
    set((s) => ({
      chartRecords: [...s.chartRecords, { ...record, id }],
      expandedChart: id,
      activeTab: 'chart',
    }))
  },

  switchChartView: (id, type) =>
    set((s) => ({
      chartRecords: s.chartRecords.map((r) =>
        r.id === id ? { ...r, activeType: type } : r
      ),
    })),

  toggleChartEntry: (id) =>
    set((s) => ({
      expandedChart: s.expandedChart === id ? null : id,
    })),

  addSqlRecord: (record) => {
    const id = nextSqlId++
    set((s) => ({
      sqlRecords: [...s.sqlRecords, { ...record, id }],
      expandedSql: id,
    }))
  },

  toggleSqlEntry: (id) =>
    set((s) => ({
      expandedSql: s.expandedSql === id ? null : id,
    })),

  addReportRecord: (record) => {
    const id = nextReportId++
    set((s) => ({
      reportRecords: [...s.reportRecords, { ...record, id }],
      expandedReport: id,
    }))
  },

  toggleReportEntry: (id) =>
    set((s) => ({
      expandedReport: s.expandedReport === id ? null : id,
    })),

  toggleReportStar: (id) =>
    set((s) => ({
      reportRecords: s.reportRecords.map((r) =>
        r.id === id ? { ...r, starred: !r.starred } : r
      ),
    })),
}))