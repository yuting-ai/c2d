import { useResultsStore } from '../../stores/resultsStore'
import ChartTab from '../results/chart/ChartTab'
import SqlTab from '../results/sql/SqlTab'
import ReportTab from '../results/report/ReportTab'
import SchemaTab from '../results/SchemaTab'

const TABS = [
  { key: 'schema', label: 'schema' },
  { key: 'chart', label: 'chart' },
  { key: 'sql', label: 'sql' },
  { key: 'report', label: 'report' },
] as const

export default function ResultsPanel() {
  const activeTab = useResultsStore((s) => s.activeTab)
  const setTab = useResultsStore((s) => s.setActiveTab)
  const chartCount = useResultsStore((s) => s.chartRecords.length)
  const sqlCount = useResultsStore((s) => s.sqlRecords.length)
  const reportCount = useResultsStore((s) => s.reportRecords.length)

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
            {t.key === 'chart' && chartCount > 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)', marginLeft: 4 }}>{chartCount}</span>
            )}
            {t.key === 'sql' && sqlCount > 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)', marginLeft: 4 }}>{sqlCount}</span>
            )}
            {t.key === 'report' && reportCount > 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)', marginLeft: 4 }}>{reportCount}</span>
            )}
          </div>
        ))}
      </div>

      <div className="results-body">
        {activeTab === 'schema' && <SchemaTab />}
        {activeTab === 'chart' && <ChartTab />}
        {activeTab === 'sql' && <SqlTab />}
        {activeTab === 'report' && <ReportTab />}
      </div>
    </>
  )
}