/**
 * datasetStore — state for the Dataset tab
 *
 * Responsibilities:
 *  - Fetching + caching preview rows per dataset
 *  - Sort state
 *  - Column selection (for quick-chart)
 *  - Inline cell edit queue + 3-second debounce → snapshot
 *  - Version list management
 */

import { create } from 'zustand'

const API = '/api'

// ─── Types ────────────────────────────────────────────────────

export interface ColMeta {
  name: string
  type: string          // DuckDB type string, e.g. "VARCHAR", "DOUBLE", "DATE"
}

export interface PreviewData {
  columns: string[]
  colTypes: Record<string, string>
  rows: any[][]
  total: number
  offset: number
  limit: number
  versionId: string | null
}

export interface VersionEntry {
  version_id: string
  created_at: number    // unix timestamp
  description: string
  table_name: string
  is_current: boolean
}

export interface PendingEdit {
  datasetId: string
  rowIndex: number
  column: string
  value: any
}

interface DatasetStore {
  // Which dataset tab is active inside the DatasetTab panel
  activeDatasetId: string | null

  // Preview data per datasetId
  previews: Record<string, PreviewData>
  loading: Record<string, boolean>

  // Sort state per datasetId
  sortCol: Record<string, string>
  sortDir: Record<string, 'asc' | 'desc'>

  // Column selection (click-to-select for quick-chart)
  selectedCols: Record<string, Set<string>>

  // Pending edits awaiting snapshot (debounced)
  pendingEdits: PendingEdit[]
  debounceTimer: ReturnType<typeof setTimeout> | null

  // Version history per datasetId
  versions: Record<string, VersionEntry[]>
  versionsLoading: Record<string, boolean>

  // Saving indicator
  saving: boolean
  lastSavedAt: number | null

  // Actions
  setActiveDataset: (projectId: string, datasetId: string) => void
  fetchPreview: (projectId: string, datasetId: string, opts?: {
    offset?: number
    limit?: number
    reset?: boolean
  }) => Promise<void>
  loadMore: (projectId: string, datasetId: string) => Promise<void>
  setSort: (projectId: string, datasetId: string, col: string) => void
  toggleCol: (datasetId: string, col: string) => void
  clearSelectedCols: (datasetId: string) => void

  // Cell editing
  applyEdit: (projectId: string, datasetId: string, rowIndex: number, column: string, value: any) => Promise<void>
  _scheduleSnapshot: (projectId: string, datasetId: string) => void

  // Versions
  fetchVersions: (projectId: string, datasetId: string) => Promise<void>
  restoreVersion: (projectId: string, datasetId: string, versionId: string) => Promise<void>

  // Export
  exportCsv: (projectId: string, datasetId: string, filename: string) => void
}

// ─── Store ────────────────────────────────────────────────────

export const useDatasetStore = create<DatasetStore>((set, get) => ({
  activeDatasetId: null,
  previews: {},
  loading: {},
  sortCol: {},
  sortDir: {},
  selectedCols: {},
  pendingEdits: [],
  debounceTimer: null,
  versions: {},
  versionsLoading: {},
  saving: false,
  lastSavedAt: null,

  // ── Set active dataset + auto-fetch ─────────────────────────

  setActiveDataset: (projectId, datasetId) => {
    set((s) => (s.activeDatasetId === datasetId ? s : { activeDatasetId: datasetId }))
    const { previews } = get()
    if (!previews[datasetId]) {
      get().fetchPreview(projectId, datasetId)
    }
    const { versions } = get()
    if (!versions[datasetId]) {
      get().fetchVersions(projectId, datasetId)
    }
  },

  // ── Preview fetch ────────────────────────────────────────────

  fetchPreview: async (projectId, datasetId, opts = {}) => {
    const { sortCol, sortDir, previews } = get()
    const existing = previews[datasetId]
    const offset = opts.reset ? 0 : (opts.offset ?? 0)
    const limit = opts.limit ?? 30

    set((s) => ({ loading: { ...s.loading, [datasetId]: true } }))

    try {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(limit),
        sort_col: sortCol[datasetId] || '',
        sort_dir: sortDir[datasetId] || 'asc',
      })
      const res = await fetch(`${API}/projects/${projectId}/datasets/${datasetId}/preview?${params}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error?.message || 'Preview failed')

      const d = json.data
      const preview: PreviewData = {
        columns: d.columns,
        colTypes: d.col_types || {},
        rows: offset === 0 || opts.reset ? d.rows : [...(existing?.rows ?? []), ...d.rows],
        total: d.total,
        offset: d.offset,
        limit: d.limit,
        versionId: d.version_id || null,
      }

      set((s) => ({
        previews: { ...s.previews, [datasetId]: preview },
        loading: { ...s.loading, [datasetId]: false },
      }))
    } catch (e) {
      set((s) => ({ loading: { ...s.loading, [datasetId]: false } }))
    }
  },

  loadMore: async (projectId, datasetId) => {
    const { previews } = get()
    const existing = previews[datasetId]
    if (!existing) return
    const nextOffset = existing.rows.length
    if (nextOffset >= existing.total) return
    await get().fetchPreview(projectId, datasetId, { offset: nextOffset, limit: 50 })
  },

  // ── Sort ─────────────────────────────────────────────────────

  setSort: (projectId, datasetId, col) => {
    const { sortCol, sortDir } = get()
    const currentCol = sortCol[datasetId]
    const currentDir = sortDir[datasetId] || 'asc'
    const newDir: 'asc' | 'desc' = currentCol === col && currentDir === 'asc' ? 'desc' : 'asc'

    set((s) => ({
      sortCol: { ...s.sortCol, [datasetId]: col },
      sortDir: { ...s.sortDir, [datasetId]: newDir },
    }))
    get().fetchPreview(projectId, datasetId, { offset: 0, reset: true })
  },

  // ── Column selection ─────────────────────────────────────────

  toggleCol: (datasetId, col) => {
    set((s) => {
      const prev = new Set(s.selectedCols[datasetId] || [])
      if (prev.has(col)) {
        prev.delete(col)
      } else {
        if (prev.size >= 2) {
          // Max 2 columns: drop the oldest
          const [first] = prev
          prev.delete(first)
        }
        prev.add(col)
      }

      return { selectedCols: { ...s.selectedCols, [datasetId]: prev } }
    })
  },

  clearSelectedCols: (datasetId) => {
    set((s) => {
      const current = s.selectedCols[datasetId]
      if (!current || current.size === 0) return s
      return { selectedCols: { ...s.selectedCols, [datasetId]: new Set() } }
    })
  },

  // ── Cell editing ─────────────────────────────────────────────

  applyEdit: async (projectId, datasetId, rowIndex, column, value) => {
    // 1. Optimistic update in local preview
    set((s) => {
      const preview = s.previews[datasetId]
      if (!preview) return s
      const colIdx = preview.columns.indexOf(column)
      if (colIdx === -1) return s
      const newRows = preview.rows.map((row, i) => {
        if (i !== rowIndex) return row
        const newRow = [...row]
        newRow[colIdx] = value
        return newRow
      })
      return {
        previews: { ...s.previews, [datasetId]: { ...preview, rows: newRows } },
        pendingEdits: [...s.pendingEdits, { datasetId, rowIndex, column, value }],
      }
    })

    // 2. Send to backend immediately
    try {
      await fetch(`${API}/projects/${projectId}/datasets/${datasetId}/cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_index: rowIndex, column, value }),
      })
    } catch {
      // Best-effort; snapshot will fail later if this did
    }

    // 3. Schedule debounced snapshot
    get()._scheduleSnapshot(projectId, datasetId)
  },

  _scheduleSnapshot: (projectId, datasetId) => {
    const { debounceTimer } = get()
    if (debounceTimer) clearTimeout(debounceTimer)

    const timer = setTimeout(async () => {
      set({ saving: true })
      try {
        const res = await fetch(
          `${API}/projects/${projectId}/datasets/${datasetId}/versions/snapshot`,
          { method: 'POST' }
        )
        const json = await res.json()
        if (json.ok && json.data?.version_id) {
          // Refresh versions list + update preview versionId
          await get().fetchVersions(projectId, datasetId)
          set((s) => {
            const preview = s.previews[datasetId]
            if (!preview) return { saving: false, lastSavedAt: Date.now(), pendingEdits: [] }
            return {
              previews: { ...s.previews, [datasetId]: { ...preview, versionId: json.data.version_id } },
              saving: false,
              lastSavedAt: Date.now(),
              pendingEdits: [],
            }
          })
        } else {
          set({ saving: false })
        }
      } catch {
        set({ saving: false })
      }
    }, 3000)

    set({ debounceTimer: timer })
  },

  // ── Versions ─────────────────────────────────────────────────

  fetchVersions: async (projectId, datasetId) => {
    set((s) => ({ versionsLoading: { ...s.versionsLoading, [datasetId]: true } }))
    try {
      const res = await fetch(`${API}/projects/${projectId}/datasets/${datasetId}/versions`)
      const json = await res.json()
      if (json.ok) {
        set((s) => ({
          versions: { ...s.versions, [datasetId]: json.data.versions || [] },
          versionsLoading: { ...s.versionsLoading, [datasetId]: false },
        }))
      }
    } catch {
      set((s) => ({ versionsLoading: { ...s.versionsLoading, [datasetId]: false } }))
    }
  },

  restoreVersion: async (projectId, datasetId, versionId) => {
    set((s) => ({ loading: { ...s.loading, [datasetId]: true } }))
    try {
      const res = await fetch(
        `${API}/projects/${projectId}/datasets/${datasetId}/versions/${versionId}/restore`,
        { method: 'POST' }
      )
      const json = await res.json()
      if (json.ok) {
        // Reload preview from fresh table
        await get().fetchPreview(projectId, datasetId, { reset: true })
        await get().fetchVersions(projectId, datasetId)
      }
    } catch {
      set((s) => ({ loading: { ...s.loading, [datasetId]: false } }))
    }
  },

  // ── Export CSV ───────────────────────────────────────────────

  exportCsv: (projectId, datasetId, filename) => {
    const url = `${API}/projects/${projectId}/datasets/${datasetId}/export`
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  },
}))
