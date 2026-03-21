import { useRef, useState, useCallback } from 'react'
import { useSchemaStore, type BlockingIssue, type DatasetState } from '../../stores/schemaStore'
import { useUIStore } from '../../stores/uiStore'
import '../../styles/schema.css'

const PROJECT_ID = 'default'  // Phase 3: will come from projectStore

export default function SchemaPanel() {
  const { datasets, systemMode, strategyVersion, uploading, confirming, error } = useSchemaStore()
  const allResolved = useSchemaStore((s) => s.allResolved)
  const { uploadDataset, confirmSchema } = useSchemaStore()
  const schemaPanelOpen = useUIStore((s) => s.schemaPanelOpen)
  const toggleSchemaPanel = useUIStore((s) => s.toggleSchemaPanel)

  // In chat mode, default to collapsed but allow user to toggle open
  const isCollapsed = systemMode === 'chat' ? !schemaPanelOpen : !schemaPanelOpen
  const isConfirmed = systemMode === 'chat' && !schemaPanelOpen
  const hasDatasets = datasets.length > 0
  const blockingCount = datasets.reduce((n, ds) => n + ds.blockingIssues.filter(i => !i.resolved).length, 0)

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

        <span className={`sp-status ${blockingCount > 0 ? 'blocking' : 'ok'}`}>
          {!hasDatasets ? '' :
           blockingCount > 0 ? `⛔ ${blockingCount} must resolve` :
           strategyVersion > 0 ? `✓ v${strategyVersion}` :
           '✓ ready to confirm'}
        </span>
      </div>

      {/* Body */}
      {!isCollapsed && (
        <div className="sp-body">
          {!hasDatasets ? (
            <UploadZone projectId={PROJECT_ID} uploading={uploading} />
          ) : (
            <>
              {datasets.map((ds) => (
                <DatasetContent key={ds.id} dataset={ds} />
              ))}

              {/* Confirm */}
              <div className="sp-confirm-wrap">
                {error && <div className="sp-error">{error}</div>}
                <button
                  className="sp-confirm-btn"
                  disabled={!allResolved() || confirming}
                  onClick={async () => {
                    await confirmSchema(PROJECT_ID)
                    // Collapse panel after successful confirm
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
            </>
          )}
        </div>
      )}
    </div>
  )
}


// ── Upload Zone ──

function UploadZone({ projectId, uploading }: { projectId: string; uploading: boolean }) {
  const uploadDataset = useSchemaStore((s) => s.uploadDataset)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleFile = useCallback((file: File) => {
    uploadDataset(projectId, file)
  }, [projectId, uploadDataset])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

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
    </div>
  )
}


// ── Dataset Content ──

function DatasetContent({ dataset: ds }: { dataset: DatasetState }) {
  const selectOption = useSchemaStore((s) => s.selectOption)
  const hasBlocking = ds.blockingIssues.length > 0
  const allBlockingResolved = ds.blockingIssues.every((i) => i.resolved)

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
          <div className="sp-section-label">⚠ data quality — will prompt only if used in analysis</div>
          {ds.warningIssues.map((w) => (
            <div key={w.column} className="warning-row">
              <span className="warning-label">⚠</span>
              <span className="warning-col">{w.column}</span>
              <span className="br-col-type">{w.col_type}</span>
              <span className="warning-note">{w.description}</span>
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
        <span className="br-col-type">{issue.original_type}</span>
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