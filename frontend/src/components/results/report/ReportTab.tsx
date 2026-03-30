import { useState, useMemo } from 'react'
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useResultsStore, type ReportRecord, type ChartRecord, type EvidenceData } from '../../../stores/resultsStore'
import { useProjectStore } from '../../../stores/projectStore'
import { ChatMarkdown } from '../../chat/ChatMarkdown'

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4', '#84CC16']

export default function ReportTab() {
  const records = useResultsStore((s) => s.reportRecords)
  const expandedId = useResultsStore((s) => s.expandedReport)
  const toggleEntry = useResultsStore((s) => s.toggleReportEntry)
  const activeProject = useProjectStore((s) => s.projects.find(p => p.id === s.activeProjectId))

  if (records.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon">📄</div>
        <div className="placeholder-title">no analysis records</div>
        <div className="placeholder-desc">Analysis conclusions will accumulate here as a structured report.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Report header */}
      <div style={{
        padding: '14px 14px 10px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text1)', fontWeight: 500 }}>
            {activeProject?.title || 'Analysis Report'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', marginTop: 3 }}>
            {records.length} {records.length === 1 ? 'analysis' : 'analyses'}
          </div>
        </div>
        <button
          onClick={() => exportFullReport(records, activeProject?.title || 'report')}
          style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            padding: '4px 10px', borderRadius: 5,
            border: '1px solid var(--border)', background: 'var(--bg2)',
            color: 'var(--text3)', cursor: 'pointer', transition: 'all 0.12s',
          }}
          onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--green)'; e.currentTarget.style.color = 'var(--green)' }}
          onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text3)' }}
        >
          ↓ export report
        </button>
      </div>

      {/* Records */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {records.map((rec, i) => (
          <ReportSection
            key={rec.id}
            record={rec}
            index={i + 1}
            expanded={expandedId === rec.id}
            onToggle={() => toggleEntry(rec.id)}
          />
        ))}
      </div>
    </div>
  )
}


// ── Report Section ──

function ReportSection({
  record: rec,
  index,
  expanded,
  onToggle,
}: {
  record: ReportRecord
  index: number
  expanded: boolean
  onToggle: () => void
}) {
  const toggleStar = useResultsStore((s) => s.toggleReportStar)

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      transition: 'all 0.2s',
    }}>
      {/* Section header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', cursor: 'pointer',
          transition: 'background 0.12s',
        }}
        onMouseOver={(e) => e.currentTarget.style.background = 'var(--bg2)'}
        onMouseOut={(e) => e.currentTarget.style.background = ''}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>#{index}</span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 12,
          color: expanded ? 'var(--text1)' : 'var(--text2)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {rec.query}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>{rec.time}</span>
        <VersionBadge versions={rec.datasetVersions} />
        <button
          onClick={(e) => { e.stopPropagation(); toggleStar(rec.id) }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 12, color: rec.starred ? 'var(--amber)' : 'var(--text3)',
            padding: '0 2px', transition: 'color 0.12s',
          }}
        >
          {rec.starred ? '★' : '☆'}
        </button>
        <span style={{ fontSize: 9, color: 'var(--text3)', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : '' }}>▶</span>
      </div>

      {/* Section body */}
      {expanded && (
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Embedded chart */}
          {rec.chartData && (
            <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
              <MiniChart chart={rec.chartData} />
            </div>
          )}

          {/* Conclusion (Markdown tables, GFM) */}
          <div
            className="report-conclusion-md"
            style={{
              fontSize: 13.5, color: 'var(--text1)', lineHeight: 1.7,
              wordBreak: 'break-word',
            }}
          >
            <ChatMarkdown text={rec.conclusion} />
          </div>

          {/* Evidence section — only when stats tests exist */}
          {rec.evidence && rec.evidence.tests.length > 0 && (
            <EvidenceSection evidence={rec.evidence} />
          )}

          {/* SQL used — collapsible */}
          {rec.sqlSteps.length > 0 && (
            <SqlCollapsible steps={rec.sqlSteps} />
          )}

          {/* Per-section export */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => exportSectionHtml(rec, index)}
              style={{
                fontFamily: 'var(--mono)', fontSize: 9,
                padding: '3px 8px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--bg2)',
                color: 'var(--text3)', cursor: 'pointer', transition: 'all 0.12s',
              }}
              onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--text3)'; e.currentTarget.style.color = 'var(--text2)' }}
              onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text3)' }}
            >
              ↓ export section
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


// ── Mini Chart (embedded in report, non-interactive) ──

function MiniChart({ chart }: { chart: ChartRecord }) {
  const chartData = useMemo(() => {
    if (!chart.series.length) return []
    const xValues = chart.series[0]?.x || []
    return xValues.map((xVal, i) => {
      const point: Record<string, any> = { x: xVal }
      chart.series.forEach((s) => {
        point[s.name] = s.y[i] ?? null
      })
      return point
    })
  }, [chart.series])

  const seriesNames = chart.series.map((s) => s.name)
  if (!chartData.length) return null

  const axisStyle = { fontFamily: 'IBM Plex Mono', fontSize: 9, fill: '#4a4d58' }
  const gridStyle = { stroke: '#1f2128', strokeDasharray: '3 3' }

  return (
    <div style={{ width: '100%', height: 200, background: 'var(--bg0)', padding: '6px 4px 2px' }}>
      <ResponsiveContainer>
        {chart.type === 'line' ? (
          <LineChart data={chartData} margin={{ top: 4, right: 12, left: 4, bottom: 2 }}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 10, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} />
            {seriesNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={name} stroke={COLORS[i % COLORS.length]} strokeWidth={1.5} dot={false} />
            ))}
          </LineChart>
        ) : chart.type === 'area' ? (
          <AreaChart data={chartData} margin={{ top: 4, right: 12, left: 4, bottom: 2 }}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 10, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} />
            {seriesNames.map((name, i) => (
              <Area key={name} type="monotone" dataKey={name} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.12} strokeWidth={1.5} />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={chartData} margin={{ top: 4, right: 12, left: 4, bottom: 2 }}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 10, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} />
            {seriesNames.length === 1 ? (
              <Bar dataKey={seriesNames[0]} radius={[2, 2, 0, 0]}>
                {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Bar>
            ) : (
              seriesNames.map((name, i) => (
                <Bar key={name} dataKey={name} fill={COLORS[i % COLORS.length]} radius={[2, 2, 0, 0]} />
              ))
            )}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}


// ── SQL Collapsible ──

function SqlCollapsible({ steps }: { steps: { title: string; sql: string; tag: string }[] }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, width: 'fit-content',
          padding: '3px 9px', borderRadius: 5,
          border: '1px solid var(--border)', background: 'var(--bg2)',
          cursor: 'pointer', transition: 'all 0.12s', userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 7, color: 'var(--text3)', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : '' }}>▶</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>SQL</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{steps.length}</span>
      </div>
      {open && steps.map((step, i) => (
        <div key={i} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ padding: '4px 10px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>
            {step.title || `query ${i + 1}`}
          </div>
          <pre style={{
            padding: '8px 12px', margin: 0,
            fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text2)',
            lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            maxHeight: 160, overflowY: 'auto',
          }}>
            {step.sql}
          </pre>
        </div>
      ))}
    </>
  )
}


// ── Evidence Section ──

function EvidenceSection({ evidence }: { evidence: EvidenceData }) {
  const [open, setOpen] = useState(true)

  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--amber-border, #3d3520)',
      background: 'var(--amber-dim, rgba(240,168,58,0.06))',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 10, color: 'var(--amber, #f0a83a)' }}>📊</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber, #f0a83a)', fontWeight: 500 }}>
          evidence
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
          {evidence.tests.length} {evidence.tests.length === 1 ? 'test' : 'tests'}
          {evidence.anomalies.length > 0 && ` · ${evidence.anomalies.length} anomalies`}
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: 8, color: 'var(--text3)',
          transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : '',
        }}>▶</span>
      </div>

      {/* Body */}
      {open && (
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Test results */}
          {evidence.tests.map((test, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: test.significant ? 'var(--green)' : 'var(--text3)',
                flexShrink: 0,
              }} />
              <span style={{ color: 'var(--text2)' }}>{test.key}</span>
              <span style={{
                marginLeft: 'auto',
                color: test.significant ? 'var(--green)' : 'var(--text3)',
                fontWeight: test.significant ? 500 : 400,
              }}>
                {test.value}
              </span>
            </div>
          ))}

          {/* Anomalies */}
          {evidence.anomalies.length > 0 && (
            <>
              <div style={{
                height: 1, background: 'var(--border, #1f2128)',
                margin: '4px 0',
              }} />
              {evidence.anomalies.map((anomaly, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontFamily: 'var(--mono)', fontSize: 10,
                  color: 'var(--amber, #f0a83a)',
                }}>
                  <span>{anomaly.icon}</span>
                  <span>{anomaly.text}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}


// ── Export helpers ──

import { miniZip, downloadBlob, type ZipFile } from '../../../utils/miniZip'

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').substring(0, 60)
}

function buildChartSvg(chart: ChartRecord): string {
  const W = 600, H = 300, PAD = 50, PADT = 30
  const colors = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4']
  const series = chart.series
  if (!series.length) return ''

  const xLabels = series[0].x.map(String)
  const allY = series.flatMap(s => s.y)
  const minY = Math.min(0, ...allY)
  const maxY = Math.max(...allY) * 1.1 || 1

  const plotW = W - PAD * 2
  const plotH = H - PADT - PAD
  const scaleX = (i: number) => PAD + (i / Math.max(xLabels.length - 1, 1)) * plotW
  const scaleY = (v: number) => PADT + plotH - ((v - minY) / (maxY - minY)) * plotH

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  svg += `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = PADT + (plotH / 4) * i
    const val = maxY - ((maxY - minY) / 4) * i
    svg += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#E2E5ED" stroke-dasharray="3,3"/>`
    svg += `<text x="${PAD - 8}" y="${y + 3}" fill="#9CA3AF" font-family="monospace" font-size="9" text-anchor="end">${Math.round(val).toLocaleString()}</text>`
  }

  // X labels
  const step = Math.max(1, Math.floor(xLabels.length / 10))
  xLabels.forEach((label, i) => {
    if (i % step === 0 || i === xLabels.length - 1) {
      const x = scaleX(i)
      svg += `<text x="${x}" y="${H - 10}" fill="#9CA3AF" font-family="monospace" font-size="9" text-anchor="middle">${label}</text>`
    }
  })

  // Data
  if (chart.type === 'bar' || chart.type === 'pie') {
    const barW = Math.max(2, (plotW / xLabels.length) * 0.6 / series.length)
    const groupW = barW * series.length
    series.forEach((s, si) => {
      s.y.forEach((v, i) => {
        const x = scaleX(i) - groupW / 2 + si * barW
        const y = scaleY(v)
        const h = scaleY(minY) - y
        const color = series.length === 1 ? colors[i % colors.length] : colors[si % colors.length]
        svg += `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(0, h)}" fill="${color}" rx="2"/>`
      })
    })
  } else {
    // Line / area
    series.forEach((s, si) => {
      const points = s.y.map((v, i) => `${scaleX(i)},${scaleY(v)}`).join(' ')
      const color = colors[si % colors.length]
      if (chart.type === 'area') {
        const areaPoints = `${scaleX(0)},${scaleY(minY)} ${points} ${scaleX(s.y.length - 1)},${scaleY(minY)}`
        svg += `<polygon points="${areaPoints}" fill="${color}" fill-opacity="0.15"/>`
      }
      svg += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>`
      s.y.forEach((v, i) => {
        svg += `<circle cx="${scaleX(i)}" cy="${scaleY(v)}" r="2.5" fill="${color}"/>`
      })
    })
  }

  // Legend
  series.forEach((s, si) => {
    const lx = PAD + si * 100
    svg += `<rect x="${lx}" y="${8}" width="10" height="10" fill="${colors[si % colors.length]}" rx="2"/>`
    svg += `<text x="${lx + 14}" y="${16}" fill="#4B5563" font-family="monospace" font-size="9">${s.name}</text>`
  })

  svg += '</svg>'
  return svg
}

function buildHtml(records: ReportRecord[], title: string): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #F0F2F5; color: #111827; padding: 40px; max-width: 860px; margin: 0 auto; line-height: 1.7; }
  h1 { font-size: 22px; font-weight: 500; margin-bottom: 6px; color: #111827; }
  .meta { font-size: 12px; color: #9CA3AF; margin-bottom: 30px; font-family: monospace; }
  .section { border-top: 1px solid #E2E5ED; padding: 24px 0; }
  .section-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .section-num { font-family: monospace; font-size: 11px; color: #9CA3AF; }
  .section-query { font-size: 15px; color: #111827; font-weight: 400; }
  .section-time { font-family: monospace; font-size: 11px; color: #9CA3AF; margin-left: auto; }
  .chart-wrap { margin: 12px 0; border-radius: 6px; overflow: hidden; border: 1px solid #E2E5ED; background: #FFFFFF; }
  .chart-wrap img { width: 100%; display: block; }
  .conclusion { font-size: 14px; color: #111827; line-height: 1.75; margin: 12px 0; }
  .sql-block { background: #FFFFFF; border: 1px solid #E2E5ED; border-radius: 6px; margin: 10px 0; overflow: hidden; }
  .sql-header { font-family: monospace; font-size: 10px; color: #9CA3AF; padding: 4px 12px; border-bottom: 1px solid #E2E5ED; }
  .sql-code { font-family: monospace; font-size: 11px; color: #4B5563; padding: 10px 12px; white-space: pre-wrap; word-break: break-all; }
  .evidence { background: rgba(217,119,6,0.05); border: 1px solid #FDE68A; border-radius: 8px; margin: 10px 0; padding: 10px 14px; }
  .evidence-header { font-family: monospace; font-size: 11px; color: #D97706; font-weight: 500; margin-bottom: 8px; }
  .evidence-row { display: flex; justify-content: space-between; font-family: monospace; font-size: 11px; color: #4B5563; padding: 2px 0; }
  .evidence-row.significant .evidence-val { color: #2563EB; font-weight: 500; }
  .evidence-key { color: #9CA3AF; }
  .evidence-val { color: #4B5563; }
  .evidence-divider { border: none; border-top: 1px solid #E2E5ED; margin: 6px 0; }
  .evidence-anomaly { font-family: monospace; font-size: 10px; color: #D97706; padding: 2px 0; }
  .footer { border-top: 1px solid #E2E5ED; padding-top: 16px; margin-top: 20px; font-family: monospace; font-size: 10px; color: #9CA3AF; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">${records.length} analyses · exported ${new Date().toISOString().slice(0, 10)}</div>
`

  records.forEach((rec, i) => {
    const idx = i + 1
    const hasChart = rec.chartData && rec.chartData.series.length > 0
    html += `<div class="section">
  <div class="section-header">
    <span class="section-num">#${idx}</span>
    <span class="section-query">${escapeHtml(rec.query)}</span>
    <span class="section-time">${rec.time}</span>
  </div>
`
    if (hasChart) {
      html += `  <div class="chart-wrap"><img src="chart-${idx}.svg" alt="${escapeHtml(rec.query)}"></div>\n`
    }
    html += `  <div class="conclusion">${escapeHtml(rec.conclusion)}</div>\n`

    // Evidence section
    if (rec.evidence && rec.evidence.tests.length > 0) {
      html += `  <div class="evidence">\n    <div class="evidence-header">📊 evidence · ${rec.evidence.tests.length} tests</div>\n`
      rec.evidence.tests.forEach((t) => {
        const sigClass = t.significant ? ' significant' : ''
        html += `    <div class="evidence-row${sigClass}"><span class="evidence-key">${escapeHtml(t.key)}</span><span class="evidence-val">${escapeHtml(t.value)}</span></div>\n`
      })
      if (rec.evidence.anomalies.length > 0) {
        html += `    <hr class="evidence-divider">\n`
        rec.evidence.anomalies.forEach((a) => {
          html += `    <div class="evidence-anomaly">${a.icon} ${escapeHtml(a.text)}</div>\n`
        })
      }
      html += `  </div>\n`
    }

    if (rec.sqlSteps.length > 0) {
      rec.sqlSteps.forEach((s) => {
        html += `  <div class="sql-block">
    <div class="sql-header">${escapeHtml(s.title || 'SQL')}</div>
    <div class="sql-code">${escapeHtml(s.sql)}</div>
  </div>\n`
      })
    }
    html += `</div>\n`
  })

  html += `<div class="footer">Exported from analyst · ${new Date().toISOString().slice(0, 10)}</div>
</body>
</html>`

  return html
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function exportFullReport(records: ReportRecord[], title: string) {
  const slug = slugify(title) || 'report'
  const files: ZipFile[] = []

  // HTML file
  const html = buildHtml(records, title)
  files.push({ name: `${slug}/report.html`, content: html })

  // Chart SVG files
  records.forEach((rec, i) => {
    if (rec.chartData && rec.chartData.series.length > 0) {
      const svg = buildChartSvg(rec.chartData)
      if (svg) files.push({ name: `${slug}/chart-${i + 1}.svg`, content: svg })
    }
  })

  const zip = miniZip(files)
  downloadBlob(zip, `${slug}.zip`)
}

function exportSectionHtml(rec: ReportRecord, index: number) {
  const slug = slugify(rec.query) || 'section'
  const files: ZipFile[] = []

  const html = buildHtml([rec], rec.query)
  files.push({ name: `${slug}/report.html`, content: html })

  if (rec.chartData && rec.chartData.series.length > 0) {
    const svg = buildChartSvg(rec.chartData)
    if (svg) files.push({ name: `${slug}/chart-1.svg`, content: svg })
  }

  const zip = miniZip(files)
  downloadBlob(zip, `${slug}.zip`)
}

// ── Version badge ──────────────────────────────────────────────

function VersionBadge({ versions }: { versions: Record<string, string> }) {
  const entries = Object.values(versions)
  if (entries.length === 0) return null
  return (
    <>
      {entries.map((vId) => (
        <span
          key={vId}
          title={`Generated from dataset version ${vId}`}
          style={{
            fontFamily: 'var(--mono)', fontSize: 8.5,
            padding: '1px 5px', borderRadius: 3,
            border: '1px solid var(--green-border)',
            background: 'var(--green-dim)', color: 'var(--green)',
            whiteSpace: 'nowrap', opacity: 0.75,
          }}
        >
          {vId}
        </span>
      ))}
    </>
  )
}
