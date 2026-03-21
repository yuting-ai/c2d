import { useProjectStore, type Project } from '../../stores/projectStore'

export default function Sidebar() {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const selectProject = useProjectStore((s) => s.selectProject)
  const toggleStar = useProjectStore((s) => s.toggleStar)

  const starred = projects.filter((p) => p.starred)
  const today = projects.filter((p) => !p.starred && p.createdAt === 'Today')
  const yesterday = projects.filter((p) => !p.starred && p.createdAt === 'Yesterday')
  const lastWeek = projects.filter((p) => !p.starred && p.createdAt === 'Last 7 days')

  return (
    <div className="sidebar">
      <div className="sidebar-inner">
        <button className="new-analysis-btn">＋ new analysis</button>
        <div className="sidebar-scroll">
          {starred.length > 0 && (
            <>
              <div className="section-label"><span className="section-label-star">★</span>Starred</div>
              {starred.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={selectProject} onToggleStar={toggleStar} />
              ))}
            </>
          )}

          {today.length > 0 && (
            <>
              <div className="section-label">Today</div>
              {today.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={selectProject} onToggleStar={toggleStar} />
              ))}
            </>
          )}

          {yesterday.length > 0 && (
            <>
              <div className="section-label">Yesterday</div>
              {yesterday.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={selectProject} onToggleStar={toggleStar} />
              ))}
            </>
          )}

          {lastWeek.length > 0 && (
            <>
              <div className="section-label">Last 7 days</div>
              {lastWeek.map((p) => (
                <ProjectItem key={p.id} project={p} active={p.id === activeProjectId} onSelect={selectProject} onToggleStar={toggleStar} />
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
  return (
    <div className={`project-item ${active ? 'active' : ''}`} onClick={() => onSelect(p.id)}>
      <button
        className={`project-star ${p.starred ? 'starred' : ''}`}
        title={p.starred ? 'Unstar' : 'Star'}
        onClick={(e) => { e.stopPropagation(); onToggleStar(p.id) }}
      >
        {p.starred ? '★' : '☆'}
      </button>
      <div className="project-title">{p.title}</div>
      <div className="project-meta">
        {p.datasetNames.map((ds) => (
          <span key={ds} className="project-ds-tag">{ds}</span>
        ))}
        <span className="project-time">{p.time}</span>
      </div>
    </div>
  )
}