import { useRef } from 'react'
import Topbar from './components/layout/Topbar'
import Sidebar from './components/layout/Sidebar'
import Resizer from './components/layout/Resizer'
import MainColumn from './components/layout/MainColumn'
import ResultsPanel from './components/layout/ResultsPanel'
import { useUIStore } from './stores/uiStore'
import './styles/layout.css'

export default function App() {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)

  return (
    <>
      <Topbar />
      <div className="layout">
        {/* Sidebar — ref on the sidebar-wrap so resizer can change its width */}
        <div
          ref={sidebarRef}
          className={`sidebar-wrap ${sidebarOpen ? '' : 'sidebar-wrap-collapsed'}`}
        >
          <Sidebar />
        </div>

        <Resizer side="left" targetRef={sidebarRef} defaultWidth={240} />

        <div className="main">
          <MainColumn />
          <Resizer side="right" targetRef={resultsRef} />
          <div ref={resultsRef} className="results-panel">
            <ResultsPanel />
          </div>
        </div>
      </div>
    </>
  )
}