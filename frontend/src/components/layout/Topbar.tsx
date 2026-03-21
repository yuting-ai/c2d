import { useRef } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useSchemaStore } from '../../stores/schemaStore'
import { useProjectStore } from '../../stores/projectStore'

export default function Topbar() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const datasets = useSchemaStore((s) => s.datasets)
  const uploadDataset = useSchemaStore((s) => s.uploadDataset)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const addDatasetToProject = useProjectStore((s) => s.addDatasetToProject)
  const setSchemaPanelOpen = useUIStore((s) => s.setSchemaPanelOpen)
  const addInputRef = useRef<HTMLInputElement>(null)

  const handleAddFile = (file: File) => {
    if (!activeProjectId) return
    uploadDataset(activeProjectId, file)
    addDatasetToProject(activeProjectId, file.name)
    setSchemaPanelOpen(true)  // open schema panel to show new dataset
  }

  return (
    <div className="topbar">
      <button className="sidebar-toggle" onClick={toggleSidebar} title="Toggle sidebar">
        <span /><span /><span />
      </button>
      <div className="logo">ana<em>lyst</em></div>
      <div className="divider" />

      {/* Dataset chips — real data from schemaStore */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, overflow: 'hidden' }}>
        {datasets.length === 0 && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--text3)' }}>
            no datasets loaded
          </span>
        )}
        {datasets.map((ds) => (
          <DatasetChip key={ds.id} name={ds.name} rows={ds.rowCount.toLocaleString()} active />
        ))}

        {/* + add button — only show when there's an active project */}
        {activeProjectId && (
          <>
            <input
              ref={addInputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleAddFile(file)
                e.target.value = ''  // reset so same file can be selected again
              }}
            />
            <button
              onClick={() => addInputRef.current?.click()}
              style={{
                fontFamily: 'var(--mono)', fontSize: '11px',
                padding: '4px 10px', borderRadius: 6,
                border: '1px dashed var(--border2)', background: 'none',
                color: 'var(--text3)', cursor: 'pointer',
                whiteSpace: 'nowrap', flexShrink: 0,
                transition: 'all 0.15s',
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.borderColor = 'var(--green)'
                e.currentTarget.style.color = 'var(--green)'
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.borderColor = 'var(--border2)'
                e.currentTarget.style.color = 'var(--text3)'
              }}
            >
              + add
            </button>
          </>
        )}
      </div>

      <div className="topbar-right">
        <div className="agent-badge">
          <div className="pulse-dot" />
          {datasets.length > 0 ? '4 agents ready' : 'waiting for data'}
        </div>
      </div>
    </div>
  )
}

function DatasetChip({ name, rows, active }: { name: string; rows: string; active: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '4px 10px 4px 8px',
      borderRadius: 6,
      border: `1px solid ${active ? 'var(--green)' : 'var(--border2)'}`,
      background: active ? 'var(--green-dim)' : 'var(--bg3)',
      fontFamily: 'var(--mono)', fontSize: '11px',
      flexShrink: 0,
    }}>
      <div style={{
        width: 24, height: 13, borderRadius: 7,
        background: active ? 'var(--green)' : 'var(--border2)',
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 1.5, left: active ? 12.5 : 1.5,
          width: 10, height: 10, borderRadius: '50%',
          background: active ? '#0a1a13' : 'var(--bg1)',
          transition: 'left 0.15s',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        }} />
      </div>
      <span style={{ color: active ? 'var(--green)' : 'var(--text2)' }}>{name}</span>
      <span style={{ color: 'var(--text3)', fontSize: 10 }}>· {rows}</span>
    </div>
  )
}