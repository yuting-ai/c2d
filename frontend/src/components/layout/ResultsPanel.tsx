import { useUIStore } from '../../stores/uiStore'

const TABS = [
  { key: 'schema', label: 'schema' },
  { key: 'chart', label: 'chart' },
  { key: 'sql', label: 'sql' },
  { key: 'report', label: 'report' },
] as const

export default function ResultsPanel() {
  const activeTab = useUIStore((s) => s.activeResultTab)
  const setTab = useUIStore((s) => s.setActiveResultTab)

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <div
            key={t.key}
            className={`tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </div>
        ))}
      </div>

      <div className="results-body">
        {activeTab === 'schema' && <SchemaPlaceholder />}
        {activeTab === 'chart' && <ChartPlaceholder />}
        {activeTab === 'sql' && <SqlPlaceholder />}
        {activeTab === 'report' && <ReportPlaceholder />}
      </div>
    </>
  )
}

function SchemaPlaceholder() {
  return (
    <div className="placeholder">
      <div className="placeholder-icon">⊘</div>
      <div className="placeholder-title">schema</div>
      <div className="placeholder-desc">Upload a dataset to see column types, quality issues, and sample data.</div>
    </div>
  )
}

function ChartPlaceholder() {
  return (
    <div className="placeholder">
      <div className="placeholder-icon">📊</div>
      <div className="placeholder-title">no charts yet</div>
      <div className="placeholder-desc">Ask a question about your data to generate visualizations.</div>
    </div>
  )
}

function SqlPlaceholder() {
  return (
    <div className="placeholder">
      <div className="placeholder-icon">⌘</div>
      <div className="placeholder-title">no queries yet</div>
      <div className="placeholder-desc">SQL queries will appear here as the agent generates them.</div>
    </div>
  )
}

function ReportPlaceholder() {
  return (
    <div className="placeholder">
      <div className="placeholder-icon">📄</div>
      <div className="placeholder-title">no analysis records</div>
      <div className="placeholder-desc">Analysis conclusions will accumulate here as a structured report.</div>
    </div>
  )
}