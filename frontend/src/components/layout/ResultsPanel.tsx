import { useResultsStore } from '../../stores/resultsStore'
import SchemaTab from '../results/SchemaTab'
import DatasetTab from '../results/dataset/DatasetTab'
import AnalysisTab from '../results/analysis/AnalysisTab'

const TABS = [
  { key: 'dataset',  label: 'dataset'  },
  { key: 'schema',   label: 'schema'   },
  { key: 'analysis', label: 'analysis' },
] as const

export default function ResultsPanel() {
  const activeTab            = useResultsStore((s) => s.activeTab)
  const setTab               = useResultsStore((s) => s.setActiveTab)
  const markDatasetTabOpened = useResultsStore((s) => s.markDatasetTabOpened)
  const analysisCount        = useResultsStore((s) => s.reportRecords.length)

  const handleTabClick = (key: typeof TABS[number]['key']) => {
    setTab(key)
    if (key === 'dataset') {
      markDatasetTabOpened()
    }
  }

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <div
            key={t.key}
            className={`tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => handleTabClick(t.key)}
          >
            {t.label}
            {t.key === 'analysis' && analysisCount > 0 && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)', marginLeft: 4 }}>{analysisCount}</span>
            )}
          </div>
        ))}
      </div>

      {/* Dataset tab hosts upload+cleaning on top and preview tools below */}
      {activeTab === 'dataset' ? (
        <DatasetTab />
      ) : (
        <div className="results-body">
          {activeTab === 'schema'   && <SchemaTab   />}
          {activeTab === 'analysis' && <AnalysisTab />}
        </div>
      )}
    </>
  )
}
