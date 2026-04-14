import { create } from 'zustand'

export interface ChartSeries {
  name: string
  x: (string | number)[]
  y: number[]
}

export interface ChartRecord {
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
  swapAxes: boolean
  status: 'done' | 'running'
  datasetVersions: Record<string, string>   // datasetId → versionId
}

export interface SqlRecord {
  id: number
  query: string
  steps: { title: string; sql: string; tag: string }[]
  status: 'done' | 'running'
  datasetVersions: Record<string, string>
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
  datasetVersions: Record<string, string>
}

interface ResultsStore {
  activeTab: 'dataset' | 'schema' | 'analysis'
  hasOpenedDatasetTab: boolean           // tracks first-open default logic
  chartRecords: ChartRecord[]
  sqlRecords: SqlRecord[]
  reportRecords: ReportRecord[]
  expandedChart: number | null
  expandedSql: number | null
  expandedReport: number | null

  setActiveTab: (tab: ResultsStore['activeTab']) => void
  markDatasetTabOpened: () => void
  addChartRecord: (record: ChartRecord) => void
  startChartRecord: (query: string) => number
  finalizeChartRecord: (id: number, record: Omit<ChartRecord, 'id'>) => void
  removeChartRecord: (id: number) => void
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
  activeTab: 'dataset',
  hasOpenedDatasetTab: false,
  chartRecords: [],
  sqlRecords: [],
  reportRecords: [],
  expandedChart: null,
  expandedSql: null,
  expandedReport: null,

  setActiveTab: (tab) => set((s) => (s.activeTab === tab ? s : { activeTab: tab })),
  markDatasetTabOpened: () => set({ hasOpenedDatasetTab: true }),

  addChartRecord: (record) => {
    const id = nextChartId++
    set((s) => ({
      chartRecords: [...s.chartRecords, { ...record, id }],
      expandedChart: id,
      // Only auto-switch to chart if the user has already seen the dataset tab
      activeTab: s.hasOpenedDatasetTab ? 'analysis' : s.activeTab,
    }))
  },

  startChartRecord: (query) => {
    const id = nextChartId++
    set((s) => ({
      chartRecords: [
        ...s.chartRecords,
        {
          id,
          requestId: id,
          query,
          type: 'bar',
          altTypes: [],
          activeType: 'bar',
          title: query,
          xLabel: '',
          yLabel: '',
          series: [],
          tableData: null,
          swapAxes: false,
          status: 'running',
          datasetVersions: {},
        },
      ],
      expandedChart: id,
      activeTab: s.hasOpenedDatasetTab ? 'analysis' : s.activeTab,
    }))
    return id
  },

  finalizeChartRecord: (id, record) =>
    set((s) => {
      const exists = s.chartRecords.some((r) => r.id === id)
      if (!exists) {
        return {
          chartRecords: [...s.chartRecords, { ...record, id }],
          expandedChart: id,
          activeTab: s.hasOpenedDatasetTab ? 'analysis' : s.activeTab,
        }
      }
      return {
        chartRecords: s.chartRecords.map((r) => (r.id === id ? { ...record, id } : r)),
        expandedChart: id,
        activeTab: s.hasOpenedDatasetTab ? 'analysis' : s.activeTab,
      }
    }),

  removeChartRecord: (id) =>
    set((s) => ({
      chartRecords: s.chartRecords.filter((r) => r.id !== id),
      expandedChart: s.expandedChart === id ? null : s.expandedChart,
    })),

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