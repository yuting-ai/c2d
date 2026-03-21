import { useUIStore } from '../../stores/uiStore'

export default function Topbar() {
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)

  return (
    <div className="topbar">
      <button className="sidebar-toggle" onClick={toggleSidebar} title="Toggle sidebar">
        <span /><span /><span />
      </button>
      <div className="logo">ana<em>lyst</em></div>
      <div className="divider" />

      {/* Dataset toggles — placeholder for Phase 2 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <DatasetChip name="sales_2024.csv" rows="12,430" active />
        <DatasetChip name="products.csv" rows="856" active />
        <button className="new-analysis-btn" style={{ margin: 0, width: 'auto', padding: '4px 10px', fontSize: '11px', borderRadius: '6px' }}>
          + add
        </button>
      </div>

      <div className="topbar-right">
        <div className="agent-badge">
          <div className="pulse-dot" />
          4 agents ready
        </div>
      </div>
    </div>
  )
}

function DatasetChip({ name, rows, active }: { name: string; rows: string; active: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '4px 10px 4px 8px',
      borderRadius: 6,
      border: `1px solid ${active ? 'var(--green)' : 'var(--border2)'}`,
      background: active ? 'var(--green-dim)' : 'var(--bg3)',
      fontFamily: 'var(--mono)', fontSize: '11px',
      cursor: 'pointer',
    }}>
      <div style={{
        width: 24, height: 13, borderRadius: 7,
        background: active ? 'var(--green)' : 'var(--border2)',
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 1.5, left: active ? 12.5 : 1.5,
          width: 10, height: 10, borderRadius: '50%',
          background: active ? '#0a1a13' : 'var(--bg1)',
          transition: 'left 0.15s',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        }} />
      </div>
      <span style={{ color: active ? 'var(--green)' : 'var(--text2)' }}>{name}</span>
      <span style={{ color: 'var(--text3)', fontSize: 10 }}>· {rows}</span>
    </div>
  )
}