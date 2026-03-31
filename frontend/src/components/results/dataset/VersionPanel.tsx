/**
 * VersionPanel — version history sidebar (controlled).
 *
 * Always renders the full panel. The toggle button lives in DatasetTab's
 * action bar; this component just receives an onClose callback.
 */

import { useDatasetStore, type VersionEntry } from '../../../stores/datasetStore'

const EMPTY_VERSIONS: VersionEntry[] = []

interface VersionPanelProps {
  projectId: string
  datasetId: string
  onClose: () => void
}

export default function VersionPanel({ projectId, datasetId, onClose }: VersionPanelProps) {
  const versionsByDataset = useDatasetStore((s) => s.versions)
  const versions          = versionsByDataset[datasetId] ?? EMPTY_VERSIONS
  const versionsLoading   = useDatasetStore((s) => s.versionsLoading[datasetId] ?? false)
  const saving            = useDatasetStore((s) => s.saving)
  const lastSavedAt       = useDatasetStore((s) => s.lastSavedAt)
  const restoreVersion    = useDatasetStore((s) => s.restoreVersion)
  const pendingEdits      = useDatasetStore((s) => s.pendingEdits)
  const hasPending        = pendingEdits.some((e) => e.datasetId === datasetId)

  const handleRestore = async (v: VersionEntry) => {
    if (v.is_current) return
    const ok = window.confirm(
      `Restore to version from ${formatTs(v.created_at)}?\n\n"${v.description}"\n\nAny unsaved edits will be lost.`
    )
    if (!ok) return
    await restoreVersion(projectId, datasetId, v.version_id)
  }

  return (
    <div style={{
      width: 220, minWidth: 220, flexShrink: 0,
      borderLeft: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg1)',
    }}>
      {/* Header */}
      <div style={{
        padding: '0 10px 0 14px',
        height: 38, minHeight: 38,
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', flex: 1 }}>
          version history
        </span>

        {/* Saving indicator */}
        {saving ? (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
            saving…
          </span>
        ) : hasPending ? (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--amber)' }}>unsaved…</span>
        ) : lastSavedAt ? (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>
            saved {formatRelative(lastSavedAt)}
          </span>
        ) : null}

        {/* Close button */}
        <button
          onClick={onClose}
          title="Close"
          style={{
            width: 22, height: 22, borderRadius: 4,
            border: '1px solid var(--border2)', background: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text3)', fontSize: 13, flexShrink: 0, transition: 'all .15s',
          }}
          onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg3)' }}
          onMouseOut={(e) => { e.currentTarget.style.background = 'none' }}
        >
          ›
        </button>
      </div>

      {/* Version list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
        {versionsLoading ? (
          <div style={{ padding: '20px 14px', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', textAlign: 'center' }}>
            loading…
          </div>
        ) : versions.length === 0 ? (
          <div style={{ padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
            <div style={{ fontSize: 20, opacity: 0.25 }}>📋</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.6 }}>
              No versions yet.<br />Edit a cell to create the first snapshot.
            </div>
          </div>
        ) : (
          versions.map((v, i) => (
            <VersionRow
              key={v.version_id}
              version={v}
              index={versions.length - i}
              onRestore={() => handleRestore(v)}
            />
          ))
        )}
      </div>

      {/* Footer hint */}
      <div style={{
        padding: '8px 14px',
        borderTop: '1px solid var(--border)',
        fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', lineHeight: 1.6,
      }}>
        Auto-saves 3 s after last edit.<br />Click a version to restore.
      </div>
    </div>
  )
}


// ─── Version Row ──────────────────────────────────────────────

function VersionRow({
  version: v,
  index,
  onRestore,
}: {
  version: VersionEntry
  index: number
  onRestore: () => void
}) {
  return (
    <div
      onClick={onRestore}
      style={{
        padding: '9px 14px',
        borderBottom: '1px solid var(--border)',
        cursor: v.is_current ? 'default' : 'pointer',
        background: v.is_current ? 'var(--bg2)' : 'transparent',
        borderLeft: v.is_current ? '2px solid var(--green)' : '2px solid transparent',
        transition: 'background .12s',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
      onMouseOver={(e) => { if (!v.is_current) (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
      onMouseOut={(e) => { if (!v.is_current) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: v.is_current ? 'var(--green)' : 'var(--text3)' }}>
          v{index}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', flex: 1 }}>
          {formatTs(v.created_at)}
        </span>
        {v.is_current && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 8,
            padding: '1px 5px', borderRadius: 3,
            background: 'var(--green-dim)', border: '1px solid var(--green-border)',
            color: 'var(--green)',
          }}>
            current
          </span>
        )}
      </div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10,
        color: v.is_current ? 'var(--text2)' : 'var(--text3)',
        lineHeight: 1.5,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {v.description}
      </div>
    </div>
  )
}


// ─── Formatters ───────────────────────────────────────────────

function formatTs(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isSameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatRelative(tsMs: number): string {
  const diff = Math.floor((Date.now() - tsMs) / 1000)
  if (diff < 10) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}
