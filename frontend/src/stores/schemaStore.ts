import { create } from 'zustand'
import { useProjectStore } from './projectStore'

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

interface ProjectSchemaState {
  datasets: DatasetState[]
  strategyVersion: number
  systemMode: 'empty' | 'clean' | 'chat'
  activeTables: ActiveTable[]
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

  // Project cache — saves state per project
  _cache: Record<string, ProjectSchemaState>
  _activeProjectId: string | null

  // Derived
  allResolved: () => boolean

  // Actions
  setAnalysisMode: (mode: 'simple' | 'advanced') => void
  switchProject: (projectId: string | null) => void
  loadProjectSchema: (projectId: string) => Promise<void>
  uploadDataset: (projectId: string, file: File) => Promise<void>
  selectOption: (datasetId: string, column: string, option: string) => void
  selectWarningOption: (datasetId: string, warningKey: string, option: string) => void
  confirmSchema: (projectId: string) => Promise<void>
  reset: () => void
}

const EMPTY_STATE: ProjectSchemaState = {
  datasets: [],
  strategyVersion: 0,
  systemMode: 'empty',
  activeTables: [],
}

const API_BASE = '/api'

function getInitialAnalysisMode(): 'simple' | 'advanced' {
  if (typeof window === 'undefined') return 'simple'
  const raw = window.localStorage.getItem('c2d.analysisMode')
  return raw === 'advanced' ? 'advanced' : 'simple'
}

function persistAnalysisMode(mode: 'simple' | 'advanced') {
  if (typeof window === 'undefined') return
  window.localStorage.setItem('c2d.analysisMode', mode)
}

function pickOption(options: Array<{ value: string; label: string }> | null | undefined, preferred: string[]): string | null {
  if (!options || options.length === 0) return null
  for (const p of preferred) {
    if (options.some((o) => o.value === p)) return p
  }
  return options[0]?.value ?? null
}

async function parseApiResponse(res: Response): Promise<any> {
  const raw = await res.text()
  try {
    return JSON.parse(raw)
  } catch {
    return {
      ok: false,
      error: {
        message: raw?.trim()
          ? `Server returned non-JSON response: ${raw.slice(0, 120)}`
          : `Request failed (${res.status})`,
      },
    }
  }
}

export const useSchemaStore = create<SchemaStore>((set, get) => ({
  analysisMode: getInitialAnalysisMode(),
  datasets: [],
  strategyVersion: 0,
  systemMode: 'empty',
  uploading: false,
  confirming: false,
  error: null,
  activeTables: [],
  _cache: {},
  _activeProjectId: null,

  allResolved: () => {
    const { datasets } = get()
    return datasets.every((ds) =>
      ds.blockingIssues.every((issue) => issue.resolved) &&
      ds.warningIssues.every((issue) => !issue.must_solve || Boolean(issue.selectedOption))
    )
  },

  setAnalysisMode: (mode) => {
    persistAnalysisMode(mode)
    set((s) => (s.analysisMode === mode ? s : { analysisMode: mode }))
  },

  switchProject: (projectId) => {
    const state = get()

    // Save current project state to cache
    if (state._activeProjectId) {
      state._cache[state._activeProjectId] = {
        datasets: state.datasets,
        strategyVersion: state.strategyVersion,
        systemMode: state.systemMode,
        activeTables: state.activeTables,
      }
    }

    // Restore target project state (or empty)
    const cached = projectId ? state._cache[projectId] : null
    const restored = cached || { ...EMPTY_STATE }

    set({
      _activeProjectId: projectId,
      _cache: { ...state._cache },
      datasets: restored.datasets,
      strategyVersion: restored.strategyVersion,
      systemMode: restored.systemMode,
      activeTables: restored.activeTables,
      uploading: false,
      confirming: false,
      error: null,
    })
  },

  loadProjectSchema: async (projectId) => {
    set({ uploading: true, error: null })
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/schema`)
      const json = await parseApiResponse(res)

      if (!json.ok) {
        set({ uploading: false, error: json.error?.message || 'Load schema failed' })
        return
      }

      const d = json.data || {}
      const restoredDatasets: DatasetState[] = (d.datasets || []).map((ds: any) => ({
        id: ds.id,
        name: ds.name,
        rowCount: ds.row_count,
        columnCount: ds.column_count,
        sizeBytes: 0,
        columns: (ds.columns || []).map((c: any) => ({
          name: c.name,
          original_type: c.type,
          inferred_type: c.type,
          null_pct: c.null_pct || 0,
          sample_values: c.sample_values || [],
        })),
        blockingIssues: [],
        warningIssues: [],
        autoConverted: [],
        confirmed: !!ds.confirmed,
      }))

      const strategyVersion = d.strategy_version || 0
      const systemMode = d.system_mode || (restoredDatasets.length > 0 ? 'chat' : 'empty')

      set((s) => {
        const cache = { ...s._cache }
        cache[projectId] = {
          datasets: restoredDatasets,
          strategyVersion,
          systemMode,
          activeTables: d.active_tables || [],
        }
        return {
          _activeProjectId: projectId,
          _cache: cache,
          datasets: restoredDatasets,
          strategyVersion,
          systemMode,
          activeTables: d.active_tables || [],
          uploading: false,
          confirming: false,
          error: null,
        }
      })
    } catch (e: any) {
      set({ uploading: false, error: e.message || 'Network error' })
    }
  },

  uploadDataset: async (projectId, file) => {
    set({ uploading: true, error: null })

    const mode = get().analysisMode
    const formData = new FormData()
    formData.append('file', file)
    formData.append('analysis_mode', mode)

    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/datasets`, {
        method: 'POST',
        body: formData,
      })
      const json = await parseApiResponse(res)

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
        blockingIssues: d.blocking_issues.map((bi: any) => {
          const defaultOption =
            mode === 'simple'
              ? pickOption(bi?.options, bi?.inferred_type === 'DATE' ? ['iso'] : ['null', 'keep_string'])
              : pickOption(bi?.options, bi?.inferred_type === 'DATE' ? ['iso'] : [])
          return {
            ...bi,
            selectedOption: defaultOption,
            resolved: Boolean(defaultOption),
          }
        }),
        warningIssues: (d.warning_issues || []).map((w: any) => {
          const defaultOption =
            mode === 'simple'
              ? (w?.issue_type === 'missing'
                  ? pickOption(w?.options, ['keep', 'keep_null', 'unknown', 'mode'])
                  : w?.issue_type === 'outlier'
                    ? pickOption(w?.options, ['keep'])
                    : null)
              : null
          return {
            ...w,
            must_solve: Boolean(w?.must_solve),
            selectedOption: defaultOption,
          }
        }),
        autoConverted: d.auto_converted,
        confirmed: false,
      }

      set((s) => {
        const newDatasets = [...s.datasets, dataset]
        const newState = { datasets: newDatasets, systemMode: 'clean' as const, uploading: false, _activeProjectId: projectId }
        // Save to cache
        const cache = { ...s._cache }
        cache[projectId] = { datasets: newDatasets, strategyVersion: s.strategyVersion, systemMode: 'clean', activeTables: s.activeTables }
        return { ...newState, _cache: cache }
      })

      // In simple mode, auto-apply defaults and confirm immediately.
      if (mode === 'simple') {
        await get().confirmSchema(projectId)
      }
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
            const hasSelection = Boolean(option && option.trim().length > 0)
            return { ...issue, selectedOption: hasSelection ? option : null, resolved: hasSelection }
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
        if (option && option.trim().length > 0) {
          decisions[column] = option
        }
      } else if (issue.selectedOption) {
        decisions[issue.column] = issue.selectedOption
      }
    })

    // Fire and forget — decisions are stored on backend
    const projectId = useProjectStore.getState().activeProjectId || 'default'
    fetch(`${API_BASE}/projects/${projectId}/datasets/${datasetId}/decisions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions }),
    }).catch(() => {})
  },

  selectWarningOption: (datasetId, warningKey, option) => {
    set((s) => ({
      datasets: s.datasets.map((ds) => {
        if (ds.id !== datasetId) return ds
        return {
          ...ds,
          warningIssues: ds.warningIssues.map((issue) => {
            if (issue.key !== warningKey) return issue
            return { ...issue, selectedOption: option }
          }),
        }
      }),
    }))

    const ds = get().datasets.find((d) => d.id === datasetId)
    if (!ds) return

    const decisions: Record<string, string> = {}
    ds.blockingIssues.forEach((issue) => {
      if (issue.selectedOption) {
        decisions[issue.column] = issue.selectedOption
      }
    })
    ds.warningIssues.forEach((issue) => {
      if (issue.selectedOption) {
        decisions[issue.key] = issue.selectedOption
      }
    })

    const projectId = useProjectStore.getState().activeProjectId || 'default'
    fetch(`${API_BASE}/projects/${projectId}/datasets/${datasetId}/decisions`, {
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
      ds.warningIssues.forEach((issue) => {
        if (issue.selectedOption) {
          decisions[issue.key] = issue.selectedOption
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
      const json = await parseApiResponse(res)

      if (!json.ok) {
        set({ confirming: false, error: json.error?.message || 'Confirm failed' })
        return
      }

      const d = json.data
      set((s) => {
        const newDatasets = s.datasets.map((ds) => ({ ...ds, confirmed: true }))
        const newState = {
          strategyVersion: d.strategy_version,
          systemMode: 'chat' as const,
          confirming: false,
          activeTables: d.active_tables,
          datasets: newDatasets,
        }
        // Save to cache
        const cache = { ...s._cache }
        if (s._activeProjectId) {
          cache[s._activeProjectId] = {
            datasets: newDatasets,
            strategyVersion: d.strategy_version,
            systemMode: 'chat',
            activeTables: d.active_tables,
          }
        }
        return { ...newState, _cache: cache }
      })
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