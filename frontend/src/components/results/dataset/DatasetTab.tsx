import { useDatasetStore } from '../../../stores/datasetStore'
import { useSchemaStore } from '../../../stores/schemaStore'
import { useProjectStore } from '../../../stores/projectStore'
import { useResultsStore } from '../../../stores/resultsStore'
import { useEffect, useMemo } from 'react'
import SchemaPanel from '../../schema/SchemaPanel'
import DataGrid from './DataGrid'
import VersionPanel from './VersionPanel'

// ─── Quick-chart query builder ────────────────────────────────

function buildChartQuery(cols: string[], colTypes: Record<string, string>): string {
  if (cols.length === 0) return ''

  const isNum = (c: string) => {
    const t = (colTypes[c] || '').toUpperCase()
    return ['DOUBLE', 'FLOAT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'REAL', 'HUGEINT', 'SMALLINT', 'TINYINT'].some((k) => t.startsWith(k))
  }

  if (cols.length === 1) {
    const col = cols[0]
    if (isNum(col)) {
      return `Plot a histogram of the numeric distribution of column ${col}`
    }
    return `Plot a bar chart of counts by category for column ${col}`
  }

  // Two columns
  const [a, b] = cols
  const aNum = isNum(a), bNum = isNum(b)
  if (aNum && bNum) {
    return `Plot a scatter chart of ${a} versus ${b}`
  }
  const textCol = aNum ? b : a
  const numCol  = aNum ? a : b
  return `Plot a bar chart of ${numCol} grouped by ${textCol}`
}

// ─── Component ────────────────────────────────────────────────

export default function DatasetTab() {
  const projectId = useProjectStore((s) => s.activeProjectId) ?? ''
  const schemaDatasets = useSchemaStore((s) => s.datasets)
  const datasets = useMemo(() => schemaDatasets.filter((d) => d.confirmed), [schemaDatasets])

  const activeDatasetId = useDatasetStore((s) => s.activeDatasetId)
  const setActiveDs     = useDatasetStore((s) => s.setActiveDataset)
  const fetchPreview    = useDatasetStore((s) => s.fetchPreview)
  const fetchVersions   = useDatasetStore((s) => s.fetchVersions)
  const previews        = useDatasetStore((s) => s.previews)
  const loading         = useDatasetStore((s) => s.loading)
  const versions        = useDatasetStore((s) => s.versions)
  const versionsLoading = useDatasetStore((s) => s.versionsLoading)
  const sortCol         = useDatasetStore((s) => s.sortCol)
  const sortDir         = useDatasetStore((s) => s.sortDir)
  const selectedCols    = useDatasetStore((s) => s.selectedCols)
  const clearSelected   = useDatasetStore((s) => s.clearSelectedCols)
  const exportCsv       = useDatasetStore((s) => s.exportCsv)

  // For sending quick-chart queries to chat
  const setResultsTab = useResultsStore((s) => s.setActiveTab)

  // ── Derive active state ───────────────────────────────────────
  const dsId = useMemo(() => {
    if (activeDatasetId && datasets.some((d) => d.id === activeDatasetId)) {
      return activeDatasetId
    }
    return datasets[0]?.id ?? ''
  }, [activeDatasetId, datasets])
  const ds      = datasets.find((d) => d.id === dsId)
  const preview = previews[dsId]
  const isLoad  = loading[dsId] ?? false
  const hasVersions = !!versions[dsId]
  const isVersionsLoading = versionsLoading[dsId] ?? false
  const selCols = selectedCols[dsId] ?? new Set<string>()

  useEffect(() => {
    if (!projectId || !dsId) return

    if (!preview && !isLoad) {
      fetchPreview(projectId, dsId)
    }

    if (!hasVersions && !isVersionsLoading) {
      fetchVersions(projectId, dsId)
    }
  }, [projectId, dsId, preview, isLoad, hasVersions, isVersionsLoading, fetchPreview, fetchVersions])

  // ── Quick-chart handler ───────────────────────────────────────
  const handleQuickChart = () => {
    if (selCols.size === 0 || !preview) return
    const cols = [...selCols]
    const query = buildChartQuery(cols, preview.colTypes)
    if (!query) return

    clearSelected(dsId)

    // Switch to chart tab so user sees the result
    setResultsTab('chart')

    // Dispatch to chat pipeline — ChatPanel's submit() handles addExchange too
    const event = new CustomEvent('c2d:send-query', { detail: { query, projectId } })
    window.dispatchEvent(event)
  }

  // ── Export handler ────────────────────────────────────────────
  const handleExport = () => {
    const filename = ds ? ds.name.replace(/\.\w+$/, '_export.csv') : 'export.csv'
    exportCsv(projectId, dsId, filename)
  }

  const versionId = preview?.versionId

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden',
    }}>
      {/* Keep original upload + cleaning workflow at top */}
      <SchemaPanel />

      {/* Bottom area preserves original dataset capabilities */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {datasets.length === 0 ? (
          <div className="placeholder" style={{ flex: 1 }}>
            <div className="placeholder-icon">📂</div>
            <div className="placeholder-title">no confirmed datasets</div>
            <div className="placeholder-desc">Upload and confirm decisions above to enable preview.</div>
          </div>
        ) : (
          <>

      {/* ── Dataset Header Bar ─────────────────────────────────── */}
      <div style={{
        height: 44, minHeight: 44, flexShrink: 0,
        background: 'var(--bg1)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center',
        padding: '0 14px', gap: 10,
      }}>
        {/* Dataset pill switcher */}
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          {datasets.map((d) => (
            <button
              key={d.id}
              onClick={() => setActiveDs(projectId, d.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 10px 4px 8px',
                borderRadius: 6,
                border: `1px solid ${d.id === dsId ? 'var(--green-border)' : 'var(--border2)'}`,
                background: d.id === dsId ? 'var(--green-dim)' : 'var(--bg3)',
                fontFamily: 'var(--mono)', fontSize: 10.5,
                color: d.id === dsId ? 'var(--green)' : 'var(--text3)',
                cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap',
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: d.id === dsId ? 'var(--green)' : 'var(--border2)',
                flexShrink: 0, transition: 'background .15s',
              }} />
              {d.name}
              <span style={{
                fontSize: 10, color: d.id === dsId ? 'rgba(62,255,160,0.6)' : 'var(--text3)',
                transition: 'color .15s',
              }}>
                · {d.rowCount.toLocaleString()}
              </span>
            </button>
          ))}
        </div>

        {ds && (
          <>
            <div style={{ width: 1, height: 18, background: 'var(--border2)', margin: '0 4px' }} />

            {/* Meta */}
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span><span style={{ color: 'var(--text2)' }}>{ds.columnCount}</span> cols</span>
              <span style={{ color: 'var(--border2)' }}>·</span>
              <span><span style={{ color: 'var(--text2)' }}>{(ds.sizeBytes / 1024).toFixed(0)} KB</span></span>
            </div>
          </>
        )}

        <div style={{ flex: 1 }} />

        {/* Version badge */}
        {versionId && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9.5,
            padding: '2px 7px', borderRadius: 4,
            border: '1px solid var(--green-border)',
            background: 'var(--green-dim)', color: 'var(--green)',
            whiteSpace: 'nowrap',
          }}>
            {versionId}
          </span>
        )}

        {/* Export button */}
        <button
          onClick={handleExport}
          style={{
            fontFamily: 'var(--mono)', fontSize: 10, padding: '4px 9px', borderRadius: 5,
            border: '1px solid var(--border2)', background: 'var(--bg3)',
            color: 'var(--text2)', cursor: 'pointer', transition: 'all .15s',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
          onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--green)'; e.currentTarget.style.color = 'var(--green)'; e.currentTarget.style.background = 'var(--green-dim)' }}
          onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border2)'; e.currentTarget.style.color = 'var(--text2)'; e.currentTarget.style.background = 'var(--bg3)' }}
        >
          ↓ csv
        </button>
      </div>

      {/* ── Action Bar (column selection + quick chart) ─────────── */}
      <div style={{
        height: 40, minHeight: 40, flexShrink: 0,
        background: 'var(--bg1)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 14px', gap: 7,
      }}>
        {selCols.size > 0 ? (
          <>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>selected:</span>
            {[...selCols].map((c) => (
              <span key={c} style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)',
                background: 'var(--green-dim)', border: '1px solid var(--green-border)',
                padding: '2px 7px', borderRadius: 4,
              }}>
                {c}
              </span>
            ))}
            <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 2px' }} />
            <ActionBtn onClick={handleQuickChart} color="green" label="📊 generate chart" />
            <ActionBtn
              onClick={() => clearSelected(dsId)}
              color="text3"
              label="✕ clear"
            />
          </>
        ) : (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
            Shift+click column headers to select (max 2) → quick chart
          </span>
        )}

        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', opacity: 0.6 }}>
          double-click cell to edit · click header to sort
        </span>
      </div>

      {/* ── Main content: DataGrid + VersionPanel ─────────────── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Grid */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          {preview ? (
            <DataGrid
              projectId={projectId}
              datasetId={dsId}
              preview={preview}
              selectedCols={selCols}
              sortCol={sortCol[dsId] || ''}
              sortDir={sortDir[dsId] || 'asc'}
            />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                color: isLoad ? 'var(--green)' : 'var(--text2)',
              }}>
                {isLoad ? 'loading preview…' : 'fetching preview…'}
              </span>
            </div>
          )}
        </div>

        {/* Version history panel */}
        <VersionPanel projectId={projectId} datasetId={dsId} />
      </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Tiny action button ────────────────────────────────────────

function ActionBtn({ onClick, label, color }: { onClick: () => void; label: string; color: string }) {
  const cssVar = color === 'green' ? 'var(--green)' : color === 'text3' ? 'var(--text3)' : `var(--${color})`
  const dimVar = color === 'green' ? 'var(--green-dim)' : 'var(--bg3)'
  const borderVar = color === 'green' ? 'var(--green-border)' : 'var(--border2)'

  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: 'var(--mono)', fontSize: 10,
        padding: '4px 9px', borderRadius: 5,
        border: `1px solid ${borderVar}`,
        background: dimVar,
        color: cssVar,
        cursor: 'pointer', transition: 'all .15s',
        display: 'flex', alignItems: 'center', gap: 4,
      }}
      onMouseOver={(e) => { e.currentTarget.style.opacity = '0.8' }}
      onMouseOut={(e) => { e.currentTarget.style.opacity = '1' }}
    >
      {label}
    </button>
  )
}
