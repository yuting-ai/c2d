import { create } from 'zustand'

export interface ColumnInfo {
  name: string
  original_type: string
  inferred_type: string | null
  null_pct: number
  sample_values: string[]
}

export interface BlockingIssue {
  key: string
  column: string
  original_type: string
  inferred_type: string | null
  description: string
  samples: string[]
  options: { value: string; label: string }[]
  selectedOption: string | null
  resolved: boolean
}

export interface WarningIssue {
  column: string
  col_type: string
  description: string
  options: string[] | null
}

export interface AutoConverted {
  column: string
  from_type: string
  to_type: string
  note: string
}

export interface DatasetState {
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

interface ActiveTable {
  name: string
  columns: string[]
  excluded_columns: string[]
  row_count: number
}

interface SchemaStore {
  datasets: DatasetState[]
  strategyVersion: number
  systemMode: 'empty' | 'clean' | 'chat'
  uploading: boolean
  confirming: boolean
  error: string | null
  activeTables: ActiveTable[]

  // Derived
  allResolved: () => boolean

  // Actions
  uploadDataset: (projectId: string, file: File) => Promise<void>
  selectOption: (datasetId: string, column: string, option: string) => void
  confirmSchema: (projectId: string) => Promise<void>
  reset: () => void
}

const API_BASE = '/api'

export const useSchemaStore = create<SchemaStore>((set, get) => ({
  datasets: [],
  strategyVersion: 0,
  systemMode: 'empty',
  uploading: false,
  confirming: false,
  error: null,
  activeTables: [],

  allResolved: () => {
    const { datasets } = get()
    return datasets.every((ds) =>
      ds.blockingIssues.every((issue) => issue.resolved)
    )
  },

  uploadDataset: async (projectId, file) => {
    set({ uploading: true, error: null })

    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/datasets`, {
        method: 'POST',
        body: formData,
      })
      const json = await res.json()

      if (!json.ok) {
        set({ uploading: false, error: json.error?.message || 'Upload failed' })
        return
      }

      const d = json.data
      const dataset: DatasetState = {
        id: d.dataset_id,
        name: d.name,
        rowCount: d.row_count,
        columnCount: d.column_count,
        sizeBytes: d.size_bytes,
        columns: d.columns,
        blockingIssues: d.blocking_issues.map((bi: any) => ({
          ...bi,
          selectedOption: null,
          resolved: false,
        })),
        warningIssues: d.warning_issues,
        autoConverted: d.auto_converted,
        confirmed: false,
      }

      set((s) => ({
        datasets: [...s.datasets, dataset],
        systemMode: 'clean',
        uploading: false,
      }))
    } catch (e: any) {
      set({ uploading: false, error: e.message || 'Network error' })
    }
  },

  selectOption: (datasetId, column, option) => {
    set((s) => ({
      datasets: s.datasets.map((ds) => {
        if (ds.id !== datasetId) return ds
        return {
          ...ds,
          blockingIssues: ds.blockingIssues.map((issue) => {
            if (issue.column !== column) return issue
            return { ...issue, selectedOption: option, resolved: true }
          }),
        }
      }),
    }))

    // Also submit to backend
    const ds = get().datasets.find((d) => d.id === datasetId)
    if (!ds) return

    const decisions: Record<string, string> = {}
    ds.blockingIssues.forEach((issue) => {
      if (issue.column === column) {
        decisions[column] = option
      } else if (issue.selectedOption) {
        decisions[issue.column] = issue.selectedOption
      }
    })

    // Fire and forget — decisions are stored on backend
    fetch(`${API_BASE}/projects/default/datasets/${datasetId}/decisions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions }),
    }).catch(() => {})
  },

  confirmSchema: async (projectId) => {
    set({ confirming: true, error: null })

    // Ensure all decisions submitted
    for (const ds of get().datasets) {
      const decisions: Record<string, string> = {}
      ds.blockingIssues.forEach((issue) => {
        if (issue.selectedOption) {
          decisions[issue.column] = issue.selectedOption
        }
      })

      if (Object.keys(decisions).length > 0) {
        await fetch(`${API_BASE}/projects/${projectId}/datasets/${ds.id}/decisions`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decisions }),
        })
      }
    }

    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const json = await res.json()

      if (!json.ok) {
        set({ confirming: false, error: json.error?.message || 'Confirm failed' })
        return
      }

      const d = json.data
      set((s) => ({
        strategyVersion: d.strategy_version,
        systemMode: 'chat',
        confirming: false,
        activeTables: d.active_tables,
        datasets: s.datasets.map((ds) => ({ ...ds, confirmed: true })),
      }))
    } catch (e: any) {
      set({ confirming: false, error: e.message || 'Network error' })
    }
  },

  reset: () => set({
    datasets: [],
    strategyVersion: 0,
    systemMode: 'empty',
    uploading: false,
    confirming: false,
    error: null,
    activeTables: [],
  }),
}))