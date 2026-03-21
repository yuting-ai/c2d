import { useState } from 'react'
import { useProjectStore, type Project } from '../../stores/projectStore'
import { useSchemaStore } from '../../stores/schemaStore'
import { useUIStore } from '../../stores/uiStore'

export default function Sidebar() {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const selectProject = useProjectStore((s) => s.selectProject)
  const toggleStar = useProjectStore((s) => s.toggleStar)
  const resetSchema = useSchemaStore((s) => s.reset)
  const switchProject = useSchemaStore((s) => s.switchProject)
  const setSchemaPanelOpen = useUIStore((s) => s.setSchemaPanelOpen)

  const handleSelectProject = (id: string) => {
    if (id === activeProjectId) return
    selectProject(id)
    switchProject(id)
    // If project is confirmed, collapse schema panel; otherwise open it
    const schemaState = useSchemaStore.getState()
    setSchemaPanelOpen(schemaState.systemMode !== 'chat')
  }

  const starred = projects.filter((p) => p.starred)
  const today = projects.filter((p) => !p.starred && p.createdAt === 'Today')
  const yesterday = projects.filter((p) => !p.starred && p.createdAt === 'Yesterday')
  const lastWeek = projects.filter((p) => !p.starred && p.createdAt === 'Last 7 days')

  return (
    <div className="sidebar">
      <div className="sidebar-inner">
        <button
          className="new-analysis-btn"
          onClick={() => {
            switchProject(null)  // saves current project to cache, then clears
            setSchemaPanelOpen(true)
            useProjectStore.getState().selectProject(null)
          }}
        >
          ＋ new analysis
        </button>
        <div className="sidebar-scroll">
          {projects.length === 0 && (
            <div style={{
              padding: '30px 16px',
              textAlign: 'center',
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              color: 'var(--text3)',
              lineHeight: 1.7,
            }}>
              no projects yet<br />
              upload a dataset to start
            </div>
          )}

          {starred.length > 0 && (
            <>
              <div className="section-label"><span className="section-label-star">★</span>Starred</div>
              {starred.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={handleSelectProject} onToggleStar={toggleStar} />
              ))}
            </>
          )}

          {today.length > 0 && (
            <>
              <div className="section-label">Today</div>
              {today.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={handleSelectProject} onToggleStar={toggleStar} />
              ))}
            </>
          )}

          {yesterday.length > 0 && (
            <>
              <div className="section-label">Yesterday</div>
              {yesterday.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={handleSelectProject} onToggleStar={toggleStar} />
              ))}
            </>
          )}

          {lastWeek.length > 0 && (
            <>
              <div className="section-label">Last 7 days</div>
              {lastWeek.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={handleSelectProject} onToggleStar={toggleStar} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ProjectItem({
  project: p,
  active,
  onSelect,
  onToggleStar,
}: {
  project: Project
  active: boolean
  onSelect: (id: string) => void
  onToggleStar: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(p.title)
  const updateProjectTitle = useProjectStore((s) => s.updateProjectTitle)

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditValue(p.title)
    setEditing(true)
  }

  const commitEdit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== p.title) {
      updateProjectTitle(p.id, trimmed)
    }
    setEditing(false)
  }

  return (
    <div className={`project-item ${active ? 'active' : ''}`} onClick={() => onSelect(p.id)}>
      <button
        className={`project-star ${p.starred ? 'starred' : ''}`}
        title={p.starred ? 'Unstar' : 'Star'}
        onClick={(e) => { e.stopPropagation(); onToggleStar(p.id) }}
      >
        {p.starred ? '★' : '☆'}
      </button>

      {editing ? (
        <input
          className="project-title-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false) }}
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="project-title" onDoubleClick={startEdit}>{p.title}</div>
      )}

      <div className="project-meta">
        {p.datasetNames.map((ds) => (
          <span key={ds} className="project-ds-tag">{ds}</span>
        ))}
        <span className="project-time">{p.time}</span>
      </div>
    </div>
  )
}