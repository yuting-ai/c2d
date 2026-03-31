import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useSchemaStore, type BlockingIssue, type DatasetState } from '../../stores/schemaStore'
import { useProjectStore } from '../../stores/projectStore'
import { useUIStore } from '../../stores/uiStore'
import '../../styles/schema.css'

function getTypeKind(colType: string): 'text' | 'number' | 'date' | 'bool' | 'other' {
  const t = (colType || '').toUpperCase()
  if (t.includes('CHAR') || t.includes('TEXT') || t.includes('STRING')) return 'text'
  if (t.includes('INT') || t.includes('DOUBLE') || t.includes('FLOAT') || t.includes('DECIMAL') || t.includes('NUMERIC') || t.includes('REAL')) return 'number'
  if (t.includes('DATE') || t.includes('TIME') || t.includes('TIMESTAMP')) return 'date'
  if (t.includes('BOOL')) return 'bool'
  return 'other'
}

function getTypeIcon(kind: 'text' | 'number' | 'date' | 'bool' | 'other'): string {
  if (kind === 'text') return 'T'
  if (kind === 'number') return '#'
  if (kind === 'date') return '🗓'
  if (kind === 'bool') return '⊙'
  return '?'
}

function TypePill({ colType }: { colType: string }) {
  const kind = getTypeKind(colType)
  return (
    <span className={`dtype-pill dtype-pill--${kind}`}>
      <span className="dtype-pill-icon" aria-hidden="true">{getTypeIcon(kind)}</span>
      <span>{colType}</span>
    </span>
  )
}

export default function SchemaPanel() {
  const { datasets, systemMode, strategyVersion, uploading, confirming, error } = useSchemaStore()
  const allResolved = useSchemaStore((s) => s.allResolved)
  const { uploadDataset, confirmSchema } = useSchemaStore()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const schemaPanelOpen = useUIStore((s) => s.schemaPanelOpen)
  const toggleSchemaPanel = useUIStore((s) => s.toggleSchemaPanel)

  // Active dataset tab within SchemaPanel (independent from DatasetTab's active dataset)
  const [activeSchemaId, setActiveSchemaId] = useState<string>('')
  useEffect(() => {
    if (!activeSchemaId || !datasets.some((d) => d.id === activeSchemaId)) {
      setActiveSchemaId(datasets[0]?.id ?? '')
    }
  }, [datasets, activeSchemaId])

  // Hide entirely once datasets are confirmed — preprocessing moves to DatasetTab
  if (systemMode === 'chat') return null

  // In chat mode, default to collapsed but allow user to toggle open
  const isCollapsed = !schemaPanelOpen
  const isConfirmed = systemMode === 'chat' && !schemaPanelOpen
  const hasDatasets = datasets.length > 0
  const unresolvedMustSolveCount = datasets.reduce(
    (n, ds) => n + ds.blockingIssues.filter(i => !i.resolved).length + ds.warningIssues.filter((w) => w.must_solve && !w.selectedOption).length,
    0,
  )

  return (
    <div className={`schema-panel ${isCollapsed ? 'collapsed' : ''} ${isConfirmed ? 'confirmed' : ''}`}>
      {/* Header — always visible */}
      <div className="sp-header" onClick={toggleSchemaPanel}>
        <span className={`sp-chevron ${isCollapsed ? 'closed' : ''}`}>▼</span>
        <span className="sp-title">data</span>

        {hasDatasets && (
          <div style={{ display: 'flex', gap: 6, flex: 1 }} onClick={(e) => e.stopPropagation()}>
            {datasets.map((ds) => {
              const hasPending = ds.blockingIssues.some((i) => !i.resolved) ||
                ds.warningIssues.some((w) => w.must_solve && !w.selectedOption)
              const isCurrent = ds.id === activeSchemaId
              return (
                <span
                  key={ds.id}
                  onClick={() => { setActiveSchemaId(ds.id); if (!schemaPanelOpen) toggleSchemaPanel() }}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: '10.5px',
                    display: 'flex', alignItems: 'center', gap: 4,
                    color: isCurrent && schemaPanelOpen ? 'var(--text2)' : 'var(--text3)',
                    cursor: 'pointer', padding: '2px 4px', borderRadius: 4,
                    transition: 'color .15s',
                  }}
                >
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: hasPending ? 'var(--amber)' : 'var(--green)',
                  }} />
                  {ds.name}
                </span>
              )
            })}
          </div>
        )}

          <span className={`sp-status ${unresolvedMustSolveCount > 0 ? 'blocking' : 'ok'}`}>
          {!hasDatasets ? '' :
            unresolvedMustSolveCount > 0 ? `⚠ ${unresolvedMustSolveCount} unresolved` :
           strategyVersion > 0 ? `✓ v${strategyVersion}` :
           '✓ ready to confirm'}
        </span>
      </div>

      {/* Body */}
      {!isCollapsed && (
        <>
          <div className="sp-body">
            {!hasDatasets ? (
              <UploadZone uploading={uploading} />
            ) : (() => {
              const activeDs = datasets.find((d) => d.id === activeSchemaId) ?? datasets[0]
              return (
                <div className="sp-content-scroll">
                  {/* Dataset tab switcher — only shown when multiple datasets */}
                  {datasets.length > 1 && (
                    <div style={{
                      display: 'flex', gap: 5, padding: '10px 14px 0',
                      borderBottom: '1px solid var(--border)', paddingBottom: 10,
                      flexWrap: 'wrap',
                    }}>
                      {datasets.map((ds) => {
                        const isActive = ds.id === activeDs?.id
                        const hasPending = ds.blockingIssues.some((i) => !i.resolved) ||
                          ds.warningIssues.some((w) => w.must_solve && !w.selectedOption)
                        return (
                          <button
                            key={ds.id}
                            onClick={() => setActiveSchemaId(ds.id)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 5,
                              padding: '4px 10px 4px 8px', borderRadius: 6,
                              border: `1px solid ${isActive ? 'var(--green-border)' : 'var(--border2)'}`,
                              background: isActive ? 'var(--green-dim)' : 'var(--bg3)',
                              fontFamily: 'var(--mono)', fontSize: 10.5,
                              color: isActive ? 'var(--green)' : 'var(--text3)',
                              cursor: 'pointer', transition: 'all .15s', whiteSpace: 'nowrap',
                            }}
                          >
                            <span style={{
                              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                              background: hasPending ? 'var(--amber)' : isActive ? 'var(--green)' : 'var(--border2)',
                              transition: 'background .15s',
                            }} />
                            {ds.name}
                            {hasPending && (
                              <span style={{
                                fontSize: 9, padding: '1px 4px', borderRadius: 3,
                                background: 'var(--amber-dim)', color: 'var(--amber)',
                                border: '1px solid var(--amber-border)', lineHeight: 1.4,
                              }}>!</span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {/* Only render the active dataset's content */}
                  {activeDs && <DatasetContent key={activeDs.id} dataset={activeDs} />}
                </div>
              )
            })()}
          </div>

          {hasDatasets && (
            <div className="sp-footer">
              <div className="sp-action-top">
                <div className="sp-action-text">
                  {unresolvedMustSolveCount > 0
                    ? `⛔ ${unresolvedMustSolveCount} unresolved warning(s)`
                    : strategyVersion > 0
                      ? `✓ cleaning confirmed · v${strategyVersion} (you can update anytime)`
                      : '✓ ready to confirm cleaning decisions'}
                </div>
                {error && <div className="sp-error">{error}</div>}
                <button
                  className="sp-confirm-btn"
                  disabled={!allResolved() || confirming || !activeProjectId}
                  onClick={async () => {
                    if (!activeProjectId) return
                    await confirmSchema(activeProjectId)
                    if (useSchemaStore.getState().systemMode === 'chat') {
                      useUIStore.getState().setSchemaPanelOpen(false)
                    }
                  }}
                >
                  {confirming ? 'applying…' :
                   strategyVersion > 0 ? '↻ update decisions' :
                   'confirm decisions & start analysis'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}


// ── Per-dataset Preprocessing Panel (embedded in DatasetTab) ──

export function DatasetPreprocessingPanel({
  datasetId,
  projectId,
}: {
  datasetId: string
  projectId: string
}) {
  const ds            = useSchemaStore((s) => s.datasets.find((d) => d.id === datasetId))
  const strategyVersion = useSchemaStore((s) => s.strategyVersion)
  const allResolved   = useSchemaStore((s) => s.allResolved)
  const confirming    = useSchemaStore((s) => s.confirming)
  const confirmSchema = useSchemaStore((s) => s.confirmSchema)
  const error         = useSchemaStore((s) => s.error)

  if (!ds) return null

  const unresolvedCount =
    ds.blockingIssues.filter((i) => !i.resolved).length +
    ds.warningIssues.filter((w) => w.must_solve && !w.selectedOption).length

  // Single div wrapper so parent's flex layout (bounded maxHeight) correctly distributes
  // space: sp-body gets flex:1 → scrollable content area, sp-footer sticks to bottom
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div className="sp-body" style={{ borderTop: 'none' }}>
        <div className="sp-content-scroll">
          <DatasetContent dataset={ds} />
        </div>
      </div>
      <div className="sp-footer">
        <div className="sp-action-top">
          <div className="sp-action-text">
            {unresolvedCount > 0
              ? `⛔ ${unresolvedCount} unresolved warning(s)`
              : strategyVersion > 0
                ? `✓ preprocessing confirmed · v${strategyVersion} (you can update anytime)`
                : '✓ ready to confirm preprocessing decisions'}
          </div>
          {error && <div className="sp-error">{error}</div>}
          <button
            className="sp-confirm-btn"
            disabled={!allResolved() || confirming || !projectId}
            onClick={async () => {
              if (!projectId) return
              await confirmSchema(projectId)
            }}
          >
            {confirming ? 'applying…' :
             strategyVersion > 0 ? '↻ update decisions' :
             'confirm decisions & start analysis'}
          </button>
        </div>
      </div>
    </div>
  )
}


// ── Upload Zone ──

function UploadZone({ uploading }: { uploading: boolean }) {
  const uploadDataset = useSchemaStore((s) => s.uploadDataset)
  const switchProject = useSchemaStore((s) => s.switchProject)
  const loadProjectSchema = useSchemaStore((s) => s.loadProjectSchema)
  const createProject = useProjectStore((s) => s.createProject)
  const upsertProject = useProjectStore((s) => s.upsertProject)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const selectProject = useProjectStore((s) => s.selectProject)
  const setSchemaPanelOpen = useUIStore((s) => s.setSchemaPanelOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [showExisting, setShowExisting] = useState(false)
  const [restorableProjects, setRestorableProjects] = useState<Array<{
    project_id: string
    title: string
    dataset_names: string[]
    dataset_count: number
    strategy_version: number
    updated_at: number
  }>>([])
  const [loadingExisting, setLoadingExisting] = useState(false)

  const handleFile = useCallback((file: File) => {
    // Create a project named after the file, then upload
    const projectId = createProject('', file.name)
    uploadDataset(projectId, file)
  }, [createProject, uploadDataset])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const loadRestorableProjects = useCallback(async () => {
    setLoadingExisting(true)
    try {
      const res = await fetch('/api/debug/projects')
      const json = await res.json()
      if (json.ok) {
        setRestorableProjects(json.data?.projects || [])
      }
    } catch {
      setRestorableProjects([])
    } finally {
      setLoadingExisting(false)
    }
  }, [])

  useEffect(() => {
    if (showExisting) {
      loadRestorableProjects()
    }
  }, [showExisting, loadRestorableProjects])

  const handleSelectExisting = useCallback((projectId: string) => {
    const item = restorableProjects.find((p) => p.project_id === projectId)
    if (!item) return

    upsertProject({
      id: item.project_id,
      title: item.title || item.project_id,
      datasetNames: item.dataset_names || [],
      createdAt: 'Today',
      starred: false,
      time: new Date(item.updated_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    })

    selectProject(projectId)
    switchProject(projectId)
    loadProjectSchema(projectId).then(() => {
      const schemaState = useSchemaStore.getState()
      setSchemaPanelOpen(schemaState.systemMode !== 'chat')
    })
    setShowExisting(false)
  }, [restorableProjects, upsertProject, selectProject, switchProject, loadProjectSchema, setSchemaPanelOpen])

  return (
    <div
      className={`upload-zone ${dragging ? 'dragging' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xls"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
        }}
      />
      <div style={{ fontSize: 28, opacity: 0.3 }}>
        {uploading ? '⏳' : '📁'}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>
        {uploading ? 'uploading & analyzing…' : 'drop a file or click to upload'}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', lineHeight: 1.7 }}>
        CSV, TSV, Excel (.xlsx, .xls)
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{ marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}
      >
        <button
          type="button"
          className="upload-debug-btn"
          onClick={() => setShowExisting((v) => !v)}
        >
          {loadingExisting
            ? 'debug: loading existing datasets...'
            : `debug: choose existing dataset (${restorableProjects.length})`}
        </button>

        {showExisting && restorableProjects.length > 0 && (
          <div className="existing-project-list">
            {restorableProjects.map((p) => (
              <button
                key={p.project_id}
                type="button"
                className={`existing-project-item ${p.project_id === activeProjectId ? 'active' : ''}`}
                onClick={() => handleSelectExisting(p.project_id)}
                title={(p.dataset_names || []).join(', ')}
              >
                <span>{p.title || p.project_id}</span>
                <span>{(p.dataset_names || []).join(' · ')}</span>
              </button>
            ))}
          </div>
        )}

        {showExisting && !loadingExisting && restorableProjects.length === 0 && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
            no existing datasets found on disk
          </div>
        )}
      </div>
    </div>
  )
}


// ── Dataset Content ──

function DatasetContent({ dataset: ds }: { dataset: DatasetState }) {
  const selectOption = useSchemaStore((s) => s.selectOption)
  const selectWarningOption = useSchemaStore((s) => s.selectWarningOption)
  const hasBlocking = ds.blockingIssues.length > 0
  const allBlockingResolved = ds.blockingIssues.every((i) => i.resolved)
  const warningGroups = ds.warningIssues.reduce<Record<string, typeof ds.warningIssues>>((acc, w) => {
    if (!acc[w.column]) acc[w.column] = []
    acc[w.column].push(w)
    return acc
  }, {})

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Overview */}
      <div className="ds-overview">
        <span className="ds-overview-name">{ds.name}</span>
        <span className="ds-overview-info">
          {ds.rowCount.toLocaleString()} rows · {ds.columnCount} columns · {(ds.sizeBytes / 1024).toFixed(0)} KB
        </span>
        <span className="ds-overview-info">
          cols: {ds.columns.map(c => c.name).join(' · ')}
        </span>
      </div>

      {/* Blocking issues */}
      {hasBlocking && (
        <>
          <div className="sp-section-label">
            ⚠ ambiguous data — choose format
          </div>
          {ds.blockingIssues.map((issue) => (
            <BlockingRow
              key={issue.key}
              issue={issue}
              onSelect={(option) => selectOption(ds.id, issue.column, option)}
            />
          ))}
        </>
      )}

      {/* Warnings */}
      {ds.warningIssues.length > 0 && (
        <>
          <div className="sp-section-label">⚠ data quality — choose handling before analysis</div>
          {Object.entries(warningGroups).map(([column, issues]) => (
            <div key={column} className="warning-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="warning-label">⚠</span>
                <span className="warning-col">{column}</span>
              </div>

              {issues.map((w) => (
                <WarningIssueRow
                  key={w.key}
                  issue={w}
                  onSelect={(option) => selectWarningOption(ds.id, w.key, option)}
                />
              ))}
            </div>
          ))}
        </>
      )}

      {/* Auto converted */}
      {ds.autoConverted.length > 0 && (
        <>
          <div className="sp-section-label">✓ auto-converted by agent</div>
          {ds.autoConverted.map((a) => (
            <div key={a.column} className="auto-row">
              <span className="auto-check">✓</span>
              <span className="auto-text">{a.column}</span>
              <span className="br-col-type">{a.from_type} → {a.to_type}</span>
              <span className="auto-note">{a.note}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function WarningIssueRow({
  issue,
  onSelect,
}: {
  issue: DatasetState['warningIssues'][number]
  onSelect: (option: string) => void
}) {
  return (
    <div className="warning-issue">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TypePill colType={issue.col_type} />
        {issue.must_solve && <span className="sp-status blocking" style={{ fontSize: 10 }}>warning</span>}
        <span className="warning-note" style={{ marginLeft: 0 }}>{issue.description}</span>
      </div>

      {issue.options && issue.options.length > 0 && (
        <div className="options-group">
          {issue.options.map((opt) => (
            <div
              key={`${issue.key}:${opt.value}`}
              className={`option-btn ${issue.selectedOption === opt.value ? 'selected' : ''}`}
              onClick={(e) => { e.stopPropagation(); onSelect(opt.value) }}
            >
              <span className="radio-dot" />
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}


// ── Blocking Row ──

function BlockingRow({
  issue,
  onSelect,
}: {
  issue: BlockingIssue
  onSelect: (option: string) => void
}) {
  return (
    <div className="blocking-row">
      <div className="br-head">
        <span className="br-col-name">{issue.column}</span>
        <TypePill colType={issue.inferred_type || issue.original_type} />
        <span className="br-desc">{issue.description}</span>
      </div>

      {issue.samples.length > 0 && (
        <div className="br-samples">
          samples: {issue.samples.map((s, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              <span className={i === 0 ? 'sample-ok' : 'sample-conflict'}>"{s}"</span>
            </span>
          ))}
        </div>
      )}

      <div className="options-group">
        {issue.options.map((opt) => (
          <div
            key={opt.value}
            className={`option-btn ${issue.selectedOption === opt.value ? 'selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); onSelect(opt.value) }}
          >
            <span className="radio-dot" />
            {opt.label}
          </div>
        ))}
      </div>
    </div>
  )
}