import { useResultsStore, type SqlRecord } from '../../../stores/resultsStore'

export default function SqlTab() {
  const records = useResultsStore((s) => s.sqlRecords)
  const expandedId = useResultsStore((s) => s.expandedSql)
  const toggleEntry = useResultsStore((s) => s.toggleSqlEntry)

  if (records.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon">⌘</div>
        <div className="placeholder-title">no queries yet</div>
        <div className="placeholder-desc">SQL queries will appear here as the agent generates them.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {records.map((rec, i) => (
        <SqlEntry
          key={rec.id}
          record={rec}
          index={i + 1}
          expanded={expandedId === rec.id}
          onToggle={() => toggleEntry(rec.id)}
        />
      ))}
    </div>
  )
}

function SqlEntry({
  record: rec,
  index,
  expanded,
  onToggle,
}: {
  record: SqlRecord
  index: number
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div style={{
      borderRadius: 8,
      border: `1px solid ${expanded ? 'var(--border2)' : 'var(--border)'}`,
      background: expanded ? 'var(--bg1)' : 'transparent',
      overflow: 'hidden',
      transition: 'all 0.2s',
    }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 12px', cursor: 'pointer',
          transition: 'background 0.12s',
        }}
        onMouseOver={(e) => e.currentTarget.style.background = 'var(--bg2)'}
        onMouseOut={(e) => e.currentTarget.style.background = ''}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>#{index}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: expanded ? 'var(--text1)' : 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {rec.query}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{rec.steps.length} {rec.steps.length === 1 ? 'query' : 'queries'}</span>
        <VersionBadge versions={rec.datasetVersions} />
        <span style={{ fontSize: 9, color: 'var(--text3)', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : '' }}>▶</span>
      </div>

      {expanded && (
        <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rec.steps.map((step, i) => (
            <div key={i} style={{
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center',
                padding: '4px 10px',
                borderBottom: '1px solid var(--border)',
                fontFamily: 'var(--mono)', fontSize: 9,
                color: 'var(--text3)',
              }}>
                {step.title || `query ${i + 1}`}
                <span style={{ marginLeft: 'auto', color: 'var(--green)', fontSize: 9 }}>{step.tag}</span>
              </div>
              <pre style={{
                padding: '8px 12px', margin: 0,
                fontFamily: 'var(--mono)', fontSize: 11,
                color: 'var(--text2)', lineHeight: 1.55,
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                maxHeight: 200, overflowY: 'auto',
              }}>
                {step.sql}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Version badge ──────────────────────────────────────────────

function VersionBadge({ versions }: { versions: Record<string, string> }) {
  const entries = Object.values(versions)
  if (entries.length === 0) return null
  return (
    <>
      {entries.map((vId) => (
        <span
          key={vId}
          title={`Generated from dataset version ${vId}`}
          style={{
            fontFamily: 'var(--mono)', fontSize: 8.5,
            padding: '1px 5px', borderRadius: 3,
            border: '1px solid var(--green-border)',
            background: 'var(--green-dim)', color: 'var(--green)',
            whiteSpace: 'nowrap', opacity: 0.75,
          }}
        >
          {vId}
        </span>
      ))}
    </>
  )
}
