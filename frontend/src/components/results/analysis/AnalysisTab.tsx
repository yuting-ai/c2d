import { useResultsStore } from '../../../stores/resultsStore'
import AnalysisCard from './AnalysisCard'

export default function AnalysisTab() {
  const records = useResultsStore((s) => s.reportRecords)
  const expandedId = useResultsStore((s) => s.expandedReport)
  const toggleEntry = useResultsStore((s) => s.toggleReportEntry)

  if (records.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon">📊</div>
        <div className="placeholder-title">no analysis yet</div>
        <div className="placeholder-desc">Ask a question about your data to generate charts and analysis.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' }}>
      {records.map((rec, i) => (
        <AnalysisCard
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
