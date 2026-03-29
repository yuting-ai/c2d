import { useUIStore } from '../../stores/uiStore'

export default function IconSidebar() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const chatDrawerOpen = useUIStore((s) => s.chatDrawerOpen)
  const toggleChatDrawer = useUIStore((s) => s.toggleChatDrawer)

  return (
    <div className="icon-sidebar">
      <button
        className={`sb-icon ${sidebarOpen ? 'active' : ''}`}
        onClick={toggleSidebar}
        title="Projects"
      >
        <span>📁</span>
        <span className="tooltip">Projects</span>
      </button>

      <button
        className={`sb-icon ${chatDrawerOpen ? 'active' : ''}`}
        onClick={toggleChatDrawer}
        title="Chat"
      >
        <span>💬</span>
        <span className="tooltip">Chat</span>
      </button>

      <div className="sb-divider" />

      <button className="sb-icon disabled" title="Join Graph (soon)">
        <span>🔗</span>
        <span className="tooltip">Join Graph (soon)</span>
      </button>

      <button className="sb-icon disabled" title="Templates (soon)">
        <span>📋</span>
        <span className="tooltip">Templates (soon)</span>
      </button>
    </div>
  )
}
