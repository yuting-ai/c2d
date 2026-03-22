import { useSchemaStore } from '../../stores/schemaStore'

export default function SchemaTab() {
  const datasets = useSchemaStore((s) => s.datasets)
  const strategyVersion = useSchemaStore((s) => s.strategyVersion)

  if (datasets.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon">⊘</div>
        <div className="placeholder-title">no datasets loaded</div>
        <div className="placeholder-desc">Upload a dataset to see column types, quality info, and sample data.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Strategy version badge */}
      {strategyVersion > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
          strategy v{strategyVersion} · confirmed
        </div>
      )}

      {datasets.map((ds) => (
        <DatasetSchema key={ds.id} dataset={ds} />
      ))}
    </div>
  )
}


function DatasetSchema({ dataset: ds }: { dataset: any }) {
  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      {/* Dataset header */}
      <div style={{
        padding: '10px 14px',
        background: 'var(--bg2)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--green)', fontWeight: 500 }}>
          {ds.name}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
          {ds.rowCount.toLocaleString()} rows · {ds.columnCount} cols · {(ds.sizeBytes / 1024).toFixed(0)} KB
        </span>
      </div>

      {/* Column table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={thStyle}>column</th>
              <th style={thStyle}>type</th>
              <th style={thStyle}>null %</th>
              <th style={thStyle}>samples</th>
            </tr>
          </thead>
          <tbody>
            {ds.columns.map((col: any) => (
              <tr key={col.name}>
                <td style={tdStyle}>
                  <span style={{ color: 'var(--text1)' }}>{col.name}</span>
                </td>
                <td style={tdStyle}>
                  <TypeBadge original={col.original_type} inferred={col.inferred_type} />
                </td>
                <td style={tdStyle}>
                  <NullBar pct={col.null_pct} />
                </td>
                <td style={{ ...tdStyle, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--text3)', fontSize: 10 }}>
                    {col.sample_values.slice(0, 3).join(' · ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Auto-converted summary */}
      {ds.autoConverted.length > 0 && (
        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexWrap: 'wrap', gap: 6,
        }}>
          {ds.autoConverted.map((a: any) => (
            <span key={a.column} style={{
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '2px 7px', borderRadius: 3,
              background: 'var(--green-dim)', border: '1px solid var(--green-border)',
              color: 'var(--green)',
            }}>
              ✓ {a.column}: {a.from_type} → {a.to_type}
            </span>
          ))}
        </div>
      )}

      {/* Warning summary */}
      {ds.warningIssues.length > 0 && (
        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexWrap: 'wrap', gap: 6,
        }}>
          {ds.warningIssues.map((w: any) => (
            <span key={w.column} style={{
              fontFamily: 'var(--mono)', fontSize: 9,
              padding: '2px 7px', borderRadius: 3,
              background: 'var(--amber-dim)', border: '1px solid var(--amber-border)',
              color: 'var(--amber)',
            }}>
              ⚠ {w.column}: {w.description}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}


// ── Type Badge ──

function TypeBadge({ original, inferred }: { original: string; inferred: string | null }) {
  if (!inferred || inferred === original) {
    return (
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10,
        padding: '1px 6px', borderRadius: 3,
        background: 'var(--bg3)', border: '1px solid var(--border2)',
        color: 'var(--text3)',
      }}>
        {original}
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10,
        padding: '1px 6px', borderRadius: 3,
        background: 'var(--green-dim)', border: '1px solid var(--green-border)',
        color: 'var(--green)',
      }}>
        {inferred}
      </span>
    </span>
  )
}


// ── Null % Bar ──

function NullBar({ pct }: { pct: number }) {
  if (pct === 0) {
    return <span style={{ color: 'var(--text3)', fontSize: 10 }}>—</span>
  }

  const color = pct > 0.3 ? 'var(--amber)' : pct > 0.05 ? 'var(--text3)' : 'var(--text3)'
  const width = Math.max(4, Math.min(40, pct * 100 * 0.4))

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        width: 40, height: 4, borderRadius: 2,
        background: 'var(--bg3)', position: 'relative',
        display: 'inline-block',
      }}>
        <span style={{
          position: 'absolute', left: 0, top: 0,
          width, height: 4, borderRadius: 2,
          background: color,
        }} />
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color, minWidth: 30 }}>
        {(pct * 100).toFixed(1)}%
      </span>
    </span>
  )
}


// ── Shared styles ──

const thStyle: React.CSSProperties = {
  padding: '6px 14px',
  textAlign: 'left',
  background: 'var(--bg1)',
  color: 'var(--text3)',
  borderBottom: '1px solid var(--border)',
  fontWeight: 500,
  fontSize: 10,
  position: 'sticky',
  top: 0,
}

const tdStyle: React.CSSProperties = {
  padding: '5px 14px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text2)',
  fontSize: 11,
  whiteSpace: 'nowrap',
}