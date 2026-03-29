import { useRef, useState, useCallback, useEffect } from 'react'
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
  const { datasets, systemMode, strategyVersion, uploading, confirming, error, analysisMode } = useSchemaStore()
  const setAnalysisMode = useSchemaStore((s) => s.setAnalysisMode)
  const allResolved = useSchemaStore((s) => s.allResolved)
  const { uploadDataset, confirmSchema } = useSchemaStore()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const schemaPanelOpen = useUIStore((s) => s.schemaPanelOpen)
  const toggleSchemaPanel = useUIStore((s) => s.toggleSchemaPanel)

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
          <div style={{ display: 'flex', gap: 6, flex: 1 }}>
            {datasets.map((ds) => (
              <span key={ds.id} style={{
                fontFamily: 'var(--mono)', fontSize: '10.5px',
                display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text3)',
              }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)' }} />
                {ds.name}
              </span>
            ))}
          </div>
        )}

        <div
          style={{ display: 'inline-flex', border: '1px solid var(--border2)', borderRadius: 7, overflow: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setAnalysisMode('simple')}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              border: 'none',
              padding: '4px 8px',
              cursor: 'pointer',
              color: analysisMode === 'simple' ? 'var(--green)' : 'var(--text3)',
              background: analysisMode === 'simple' ? 'var(--green-dim)' : 'var(--bg3)',
            }}
          >
            simple
          </button>
          <button
            type="button"
            onClick={() => setAnalysisMode('advanced')}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              border: 'none',
              padding: '4px 8px',
              cursor: 'pointer',
              color: analysisMode === 'advanced' ? 'var(--green)' : 'var(--text3)',
              background: analysisMode === 'advanced' ? 'var(--green-dim)' : 'var(--bg3)',
            }}
          >
            advanced
          </button>
        </div>

          <span className={`sp-status ${unresolvedMustSolveCount > 0 ? 'blocking' : 'ok'}`}>
          {!hasDatasets ? '' :
            unresolvedMustSolveCount > 0 ? `⛔ ${unresolvedMustSolveCount} must resolve` :
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
            ) : (
              analysisMode === 'simple' ? (
                <div className="sp-content-scroll">
                  <div className="ds-overview">
                    <span className="ds-overview-name">Simple mode enabled</span>
                    <span className="ds-overview-info">
                      Auto strategy is applied on upload (date → ISO, outlier → keep, missing → keep null/unknown).
                    </span>
                    <span className="ds-overview-info">
                      You can switch to advanced mode to manually review full cleaning options before analysis.
                    </span>
                  </div>
                  {datasets.map((ds) => (
                    <DatasetContent key={ds.id} dataset={ds} />
                  ))}
                </div>
              ) : (
                <div className="sp-content-scroll">
                  {datasets.map((ds) => (
                    <DatasetContent key={ds.id} dataset={ds} />
                  ))}
                </div>
              )
            )}
          </div>

          {hasDatasets && (
            <div className="sp-footer">
              <div className="sp-action-top">
                <div className="sp-action-text">
                  {unresolvedMustSolveCount > 0
                    ? `⛔ ${unresolvedMustSolveCount} unresolved must-solve issue(s)`
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
  const analysisMode = useSchemaStore((s) => s.analysisMode)
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
          <div className={`sp-section-label ${allBlockingResolved ? 'resolved-label' : ''}`}>
            {allBlockingResolved ? '✓ resolved — ambiguous data' : '⛔ must resolve — ambiguous data'}
          </div>
          {ds.blockingIssues.map((issue) => (
            <BlockingRow
              key={issue.key}
              issue={issue}
              onSelect={(option) => selectOption(ds.id, issue.column, option)}
              onUnresolve={() => selectOption(ds.id, issue.column, '')}
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
                  advancedMode={analysisMode === 'advanced'}
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
  advancedMode,
  onSelect,
}: {
  issue: DatasetState['warningIssues'][number]
  advancedMode: boolean
  onSelect: (option: string) => void
}) {
  const [expandedAfterResolve, setExpandedAfterResolve] = useState(false)
  const resolved = Boolean(issue.selectedOption)
  const collapsed = advancedMode && resolved && !expandedAfterResolve

  return (
    <div
      className={`warning-issue ${collapsed ? 'resolved' : ''}`}
      onClick={collapsed ? () => setExpandedAfterResolve(true) : undefined}
    >
      <div className="resolved-summary">
        <span>✓</span>
        <span className="rs-col">{issue.column}</span>
        <span className="rs-choice">
          {issue.options?.find((o) => o.value === issue.selectedOption)?.label || issue.selectedOption}
        </span>
        <span className="rs-edit">click to edit</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TypePill colType={issue.col_type} />
        {issue.must_solve && <span className="sp-status blocking" style={{ fontSize: 10 }}>must solve</span>}
        <span className="warning-note" style={{ marginLeft: 0 }}>{issue.description}</span>
      </div>

      {issue.options && issue.options.length > 0 && (
        <div className="options-group">
          {issue.options.map((opt) => (
            <div
              key={`${issue.key}:${opt.value}`}
              className={`option-btn ${issue.selectedOption === opt.value ? 'selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(opt.value)
                if (advancedMode) {
                  setExpandedAfterResolve(false)
                }
              }}
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
  onUnresolve,
}: {
  issue: BlockingIssue
  onSelect: (option: string) => void
  onUnresolve: () => void
}) {
  return (
    <div
      className={`blocking-row ${issue.resolved ? 'resolved' : ''}`}
      onClick={issue.resolved ? onUnresolve : undefined}
    >
      {/* Resolved summary */}
      <div className="resolved-summary">
        <span>✓</span>
        <span className="rs-col">{issue.column}</span>
        <span className="rs-choice">
          {issue.options.find(o => o.value === issue.selectedOption)?.label || issue.selectedOption}
        </span>
        <span className="rs-edit">click to edit</span>
      </div>

      {/* Full content (hidden when resolved) */}
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