import { useDatasetStore } from '../../../stores/datasetStore'
import { useSchemaStore } from '../../../stores/schemaStore'
import { useProjectStore } from '../../../stores/projectStore'
import { useResultsStore } from '../../../stores/resultsStore'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DatasetState } from '../../../stores/schemaStore'
import SchemaPanel, { DatasetPreprocessingPanel } from '../../schema/SchemaPanel'
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
  const strategyVersion = useSchemaStore((s) => s.strategyVersion)
  const toggleDataset = useSchemaStore((s) => s.toggleDataset)
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

  // Preprocessing state for current dataset
  const currentSchemaDs = schemaDatasets.find((d) => d.id === dsId)
  const unresolvedPrepCount = currentSchemaDs
    ? currentSchemaDs.blockingIssues.filter((i) => !i.resolved).length +
      currentSchemaDs.warningIssues.filter((w) => w.must_solve && !w.selectedOption).length
    : 0

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

  // Re-fetch preview when preprocessing is confirmed (transforms may change actual data)
  const prevStrategyVersionRef = useRef(strategyVersion)
  useEffect(() => {
    if (!projectId || !dsId) return
    if (strategyVersion === 0) return                             // not confirmed yet
    if (strategyVersion === prevStrategyVersionRef.current) return // no change
    prevStrategyVersionRef.current = strategyVersion
    fetchPreview(projectId, dsId, { reset: true })
  }, [strategyVersion, projectId, dsId, fetchPreview])

  // ── Quick-chart handler ───────────────────────────────────────
  const handleQuickChart = () => {
    if (selCols.size === 0 || !preview) return
    const cols = [...selCols]
    const query = buildChartQuery(cols, preview.colTypes)
    if (!query) return

    clearSelected(dsId)

    // Switch to analysis tab so user sees the result
    setResultsTab('analysis')

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
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)
  const [prepOpen, setPrepOpen] = useState(() => unresolvedPrepCount > 0 || strategyVersion === 0)
  // Reset when switching datasets: open if unresolved or never confirmed, closed otherwise
  useEffect(() => {
    setPrepOpen(unresolvedPrepCount > 0 || strategyVersion === 0)
  }, [dsId]) // eslint-disable-line react-hooks/exhaustive-deps

  const saving       = useDatasetStore((s) => s.saving)
  const pendingEdits = useDatasetStore((s) => s.pendingEdits)
  const lastSavedAt  = useDatasetStore((s) => s.lastSavedAt)
  const hasPending   = pendingEdits.some((e) => e.datasetId === dsId)
  const versionCount = versions[dsId]?.length ?? 0

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
            <DatasetPill
              key={d.id}
              d={d}
              isActive={d.id === dsId}
              onSelect={() => setActiveDs(projectId, d.id)}
            />
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

      {/* ── Preprocessing Section ──────────────────────────────── */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        ...(prepOpen ? { flex: 1, minHeight: 0 } : { flexShrink: 0 }),
        background: 'var(--bg1)', borderBottom: '1px solid var(--border)',
      }}>
        {/* Collapsible header */}
        <div
          onClick={() => setPrepOpen((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '0 14px', height: 34, cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <span style={{ fontSize: 7, color: 'var(--text3)', lineHeight: 1, marginRight: 1 }}>
            {prepOpen ? '▼' : '▶'}
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text2)' }}>
            preprocessing
          </span>

          <div style={{ flex: 1 }} />

          {/* Status badge */}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9,
            padding: '2px 6px', borderRadius: 4,
            border: `1px solid ${unresolvedPrepCount > 0 ? 'var(--amber-border)' : 'var(--green-border)'}`,
            background: unresolvedPrepCount > 0 ? 'var(--amber-dim)' : 'var(--green-dim)',
            color: unresolvedPrepCount > 0 ? 'var(--amber)' : 'var(--green)',
          }}>
            {unresolvedPrepCount > 0
              ? `⚠ ${unresolvedPrepCount} warning(s)`
              : strategyVersion > 0 ? `✓ v${strategyVersion}` : '✓ ready'}
          </span>
        </div>

        {/* Body — flex:1 so it fills all remaining height when expanded */}
        {prepOpen && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <DatasetPreprocessingPanel datasetId={dsId} projectId={projectId} />
          </div>
        )}
      </div>

      {/* ── Action Bar + data grid: hidden while preprocessing is open ── */}
      {/* ── Action Bar (column selection + quick chart) ─────────── */}
      <div style={{
        height: 40, minHeight: 40, flexShrink: 0,
        background: 'var(--bg1)',
        borderBottom: '1px solid var(--border)',
        display: prepOpen ? 'none' : 'flex', alignItems: 'center', padding: '0 14px', gap: 7,
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

        {/* Version history toggle */}
        <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 6px' }} />
        <button
          onClick={() => setVersionPanelOpen((v) => !v)}
          title="Version history"
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '3px 8px', borderRadius: 5,
            border: `1px solid ${versionPanelOpen ? 'var(--green-border)' : 'var(--border2)'}`,
            background: versionPanelOpen ? 'var(--green-dim)' : 'var(--bg2)',
            cursor: 'pointer', transition: 'all .15s', position: 'relative',
          }}
          onMouseOver={(e) => { if (!versionPanelOpen) { e.currentTarget.style.background = 'var(--bg3)'; e.currentTarget.style.borderColor = 'var(--border)' } }}
          onMouseOut={(e) => { if (!versionPanelOpen) { e.currentTarget.style.background = 'var(--bg2)'; e.currentTarget.style.borderColor = 'var(--border2)' } }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke={versionPanelOpen ? 'var(--green)' : 'var(--text3)'}
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M1.5 8a6.5 6.5 0 1 0 1.6-4.2" />
            <polyline points="1.5 3 1.5 8 6 8" />
            <line x1="8" y1="5" x2="8" y2="8.5" />
            <line x1="8" y1="8.5" x2="10.5" y2="10" />
          </svg>
          {/* Unsaved / saving dot */}
          {(saving || hasPending) && (
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--amber)', flexShrink: 0 }} />
          )}
          {/* Version count */}
          {versionCount > 0 && !saving && !hasPending && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: versionPanelOpen ? 'var(--green)' : 'var(--text3)' }}>
              {versionCount}
            </span>
          )}
        </button>
      </div>

      {/* ── Inactive dataset banner ───────────────────────────── */}
      {!prepOpen && ds && !ds.enabled && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 14px',
          height: 30, minHeight: 30, flexShrink: 0,
          background: 'var(--amber-dim)',
          borderBottom: '1px solid var(--amber-border)',
          fontFamily: 'var(--mono)', fontSize: 10.5,
          color: 'var(--amber)',
        }}>
          <span style={{ opacity: 0.85 }}>⏸ Inactive — excluded from queries</span>
          <span style={{ color: 'var(--border2)', userSelect: 'none' }}>·</span>
          <button
            onClick={() => toggleDataset(ds.id)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 10.5,
              padding: '1px 8px', borderRadius: 4,
              border: '1px solid var(--amber-border)',
              background: 'none', color: 'var(--amber)',
              cursor: 'pointer', transition: 'all .15s',
            }}
            onMouseOver={(e) => { e.currentTarget.style.background = 'var(--amber)'; e.currentTarget.style.color = '#fff' }}
            onMouseOut={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--amber)' }}
          >
            reactivate
          </button>
        </div>
      )}

      {/* ── Main content: DataGrid + VersionPanel ─────────────── */}
      <div style={{ display: prepOpen ? 'none' : 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
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

        {/* Version history panel — only mounted when open */}
        {versionPanelOpen && (
          <VersionPanel
            projectId={projectId}
            datasetId={dsId}
            onClose={() => setVersionPanelOpen(false)}
          />
        )}
      </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Dataset tab pill ──────────────────────────────────────────

function DatasetPill({ d, isActive, onSelect }: {
  d: DatasetState
  isActive: boolean
  onSelect: () => void
}) {
  const isEnabled = d.enabled

  return (
    <button
      onClick={onSelect}
      title={isEnabled ? undefined : 'Inactive — not used in queries'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 10px 4px 8px',
        borderRadius: 6,
        border: `1px solid ${isActive && isEnabled ? 'var(--green-border)' : isActive ? 'var(--amber-border)' : 'var(--border2)'}`,
        background: isActive && isEnabled ? 'var(--green-dim)' : isActive ? 'var(--amber-dim)' : 'var(--bg3)',
        fontFamily: 'var(--mono)', fontSize: 10.5,
        color: isActive && isEnabled ? 'var(--green)' : isActive ? 'var(--amber)' : 'var(--text3)',
        cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap',
        opacity: isEnabled ? 1 : 0.55,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: isActive && isEnabled ? 'var(--green)' : isActive ? 'var(--amber)' : 'var(--border2)',
        flexShrink: 0, transition: 'background .15s',
      }} />
      {d.name}
      {!isEnabled && (
        <span style={{
          fontSize: 9, padding: '1px 4px', borderRadius: 3,
          background: 'var(--amber-dim)', color: 'var(--amber)',
          border: '1px solid var(--amber-border)',
          lineHeight: 1.4,
        }}>
          off
        </span>
      )}
      <span style={{ fontSize: 10, color: 'var(--text3)', transition: 'color .15s' }}>
        · {d.rowCount.toLocaleString()}
      </span>
    </button>
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
