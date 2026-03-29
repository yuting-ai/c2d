import { useRef } from 'react'
import Topbar from './components/layout/Topbar'
import IconSidebar from './components/layout/IconSidebar'
import Sidebar from './components/layout/Sidebar'
import Resizer from './components/layout/Resizer'
import ChatPanel from './components/chat/ChatPanel'
import ResultsPanel from './components/layout/ResultsPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useUIStore } from './stores/uiStore'
import './styles/layout.css'

export default function App() {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const chatDrawerRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const chatDrawerOpen = useUIStore((s) => s.chatDrawerOpen)

  return (
    <>
      <Topbar />
      <div className="layout">
        <IconSidebar />

        {/* Sidebar — ref on the sidebar-wrap so resizer can change its width */}
        <div
          ref={sidebarRef}
          className={`sidebar-wrap ${sidebarOpen ? '' : 'sidebar-wrap-collapsed'}`}
        >
          <Sidebar />
        </div>

        {sidebarOpen && <Resizer side="left" targetRef={sidebarRef} defaultWidth={240} minWidth={160} maxWidth={540} />}

        <div
          ref={chatDrawerRef}
          className={`chat-drawer-wrap ${chatDrawerOpen ? '' : 'chat-drawer-wrap-collapsed'}`}
        >
          <ErrorBoundary>
            <ChatPanel />
          </ErrorBoundary>
        </div>

        {chatDrawerOpen && <Resizer side="left" targetRef={chatDrawerRef} defaultWidth={480} minWidth={160} maxWidth={540} />}

        <div className="main">
          <div ref={resultsRef} className="results-panel">
            <ErrorBoundary>
              <ResultsPanel />
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </>
  )
}