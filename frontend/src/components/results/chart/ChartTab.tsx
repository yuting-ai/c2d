import { useMemo, useRef, useState } from 'react'
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useResultsStore, type ChartRecord, type ChartSeries } from '../../../stores/resultsStore'

// Color palette matching dark theme
const COLORS = ['#3effa0', '#3a9ff5', '#f0a83a', '#a57ef5', '#f06a6a', '#5eddd6', '#c4f23e']

export default function ChartTab() {
  const records = useResultsStore((s) => s.chartRecords)
  const expandedId = useResultsStore((s) => s.expandedChart)
  const toggleEntry = useResultsStore((s) => s.toggleChartEntry)

  if (records.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon">📊</div>
        <div className="placeholder-title">no charts yet</div>
        <div className="placeholder-desc">Ask a question about your data to generate visualizations.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {records.map((rec, i) => (
        <ChartEntry
          key={rec.id}
          record={rec}
          index={i + 1}
          expanded={expandedId === rec.id}
          onToggle={() => toggleEntry(rec.id)}
        />
      ))}
    </div>
  )
}


function ChartEntry({
  record: rec,
  index,
  expanded,
  onToggle,
}: {
  record: ChartRecord
  index: number
  expanded: boolean
  onToggle: () => void
}) {
  const switchView = useResultsStore((s) => s.switchChartView)
  const chartRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const allTypes = useMemo(() => {
    const types = [rec.type, ...rec.altTypes.filter(t => t !== rec.type)]
    if (!types.includes('table')) types.push('table')
    return types
  }, [rec.type, rec.altTypes])

  const exportChart = () => {
    if (rec.activeType === 'table') {
      // Table mode → export as CSV
      const data = rec.tableData
      if (!data) return
      const csv = [data.headers.join(','), ...data.rows.map((r: any[]) => r.map(v => `"${String(v ?? '')}"`).join(','))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const slug = (rec.title || rec.query || `table-${rec.id}`)
        .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').substring(0, 60)
      a.download = `${slug}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } else {
      // Chart mode → export as SVG
      const container = chartRef.current
      if (!container) return
      const svg = container.querySelector('svg')
      if (!svg) return
      const clone = svg.cloneNode(true) as SVGElement
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      bg.setAttribute('width', '100%')
      bg.setAttribute('height', '100%')
      bg.setAttribute('fill', '#09090b')
      clone.insertBefore(bg, clone.firstChild)
      const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const slug = (rec.title || rec.query || `chart-${rec.id}`)
        .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').substring(0, 60)
      a.download = `${slug}.svg`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  }

  const copyData = () => {
    const data = rec.tableData
    if (!data) return
    const tsv = [data.headers.join('\t'), ...data.rows.map((r: any[]) => r.join('\t'))].join('\n')
    navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div style={{
      borderRadius: 8,
      border: `1px solid ${expanded ? 'var(--border2)' : 'var(--border)'}`,
      background: expanded ? 'var(--bg1)' : 'transparent',
      overflow: 'hidden',
      transition: 'all 0.2s',
    }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 12px', cursor: 'pointer',
          transition: 'background 0.12s',
        }}
        onMouseOver={(e) => e.currentTarget.style.background = 'var(--bg2)'}
        onMouseOut={(e) => e.currentTarget.style.background = ''}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>#{index}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: expanded ? 'var(--text1)' : 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {rec.title || rec.query}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{rec.activeType}</span>
        <span style={{ fontSize: 9, color: 'var(--text3)', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : '' }}>▶</span>
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ padding: '0 12px 12px' }}>
          {/* Type switcher + export buttons */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 10, alignItems: 'center' }}>
            {allTypes.map((t) => (
              <button
                key={t}
                onClick={() => switchView(rec.id, t)}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 10,
                  padding: '3px 10px', borderRadius: 4,
                  border: `1px solid ${rec.activeType === t ? 'var(--green)' : 'var(--border2)'}`,
                  background: rec.activeType === t ? 'var(--green-dim)' : 'var(--bg3)',
                  color: rec.activeType === t ? 'var(--green)' : 'var(--text3)',
                  cursor: 'pointer', transition: 'all 0.12s',
                }}
              >
                {t}
              </button>
            ))}

            {/* Spacer — pushes export buttons to the right */}
            <div style={{ flex: 1 }} />

            {/* Download: SVG or CSV depending on view */}
            <button
              onClick={exportChart}
              title={rec.activeType === 'table' ? 'Download CSV' : 'Download SVG'}
              style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                padding: '3px 8px', borderRadius: 4,
                border: '1px solid var(--border)', background: 'var(--bg2)',
                color: 'var(--text3)', cursor: 'pointer', transition: 'all 0.12s',
              }}
              onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--text3)'; e.currentTarget.style.color = 'var(--text2)' }}
              onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text3)' }}
            >
              {rec.activeType === 'table' ? '↓ csv' : '↓ svg'}
            </button>

            {/* Copy data */}
            <button
              onClick={copyData}
              title="Copy data as TSV"
              style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                padding: '3px 8px', borderRadius: 4,
                border: `1px solid ${copied ? 'var(--green)' : 'var(--border)'}`,
                background: copied ? 'var(--green-dim)' : 'var(--bg2)',
                color: copied ? 'var(--green)' : 'var(--text3)',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
              onMouseOver={(e) => { if (!copied) { e.currentTarget.style.borderColor = 'var(--text3)'; e.currentTarget.style.color = 'var(--text2)' }}}
              onMouseOut={(e) => { if (!copied) { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text3)' }}}
            >
              {copied ? '✓ copied' : '⎘ data'}
            </button>
          </div>

          {/* Chart / Table render */}
          <div ref={chartRef}>
            {rec.activeType === 'table' ? (
              <DataTable record={rec} />
            ) : (
              <ChartRenderer record={rec} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// ── Chart Renderer ──

function ChartRenderer({ record: rec }: { record: ChartRecord }) {
  const chartData = useMemo(() => {
    if (!rec.series.length) return []
    // Build unified data array for Recharts
    const xValues = rec.series[0]?.x || []
    return xValues.map((xVal, i) => {
      const point: Record<string, any> = { x: xVal }
      rec.series.forEach((s) => {
        point[s.name] = s.y[i] ?? null
      })
      return point
    })
  }, [rec.series])

  const seriesNames = rec.series.map((s) => s.name)

  if (!chartData.length) {
    return <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', padding: 20, textAlign: 'center' }}>No data to visualize</div>
  }

  const commonProps = {
    data: chartData,
    margin: { top: 8, right: 16, left: 8, bottom: 4 },
  }

  const axisStyle = { fontFamily: 'IBM Plex Mono', fontSize: 10, fill: '#4a4d58' }
  const gridStyle = { stroke: '#1f2128', strokeDasharray: '3 3' }

  return (
    <div style={{ width: '100%', height: 280, background: 'var(--bg0)', borderRadius: 6, padding: '8px 4px 4px', border: '1px solid var(--border)' }}>
      <ResponsiveContainer>
        {rec.activeType === 'line' ? (
          <LineChart {...commonProps}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} />
            <Legend wrapperStyle={{ fontFamily: 'IBM Plex Mono', fontSize: 10 }} />
            {seriesNames.map((name, i) => (
              <Line key={name} type="monotone" dataKey={name} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
            ))}
          </LineChart>
        ) : rec.activeType === 'area' ? (
          <AreaChart {...commonProps}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} />
            <Legend wrapperStyle={{ fontFamily: 'IBM Plex Mono', fontSize: 10 }} />
            {seriesNames.map((name, i) => (
              <Area key={name} type="monotone" dataKey={name} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.15} strokeWidth={2} />
            ))}
          </AreaChart>
        ) : rec.activeType === 'bar' ? (
          <BarChart {...commonProps}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} cursor={{ fill: 'rgba(62,255,160,0.04)' }} />
            <Legend wrapperStyle={{ fontFamily: 'IBM Plex Mono', fontSize: 10 }} />
            {seriesNames.length === 1 ? (
              <Bar dataKey={seriesNames[0]} radius={[3, 3, 0, 0]}>
                {chartData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            ) : (
              seriesNames.map((name, i) => (
                <Bar key={name} dataKey={name} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} />
              ))
            )}
          </BarChart>
        ) : rec.activeType === 'pie' ? (
          <PieChart>
            <Pie
              data={chartData.map((d, i) => ({ name: d.x, value: d[seriesNames[0]] || 0 }))}
              cx="50%" cy="50%"
              outerRadius={100}
              dataKey="value"
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              labelLine={{ stroke: '#4a4d58' }}
              style={{ fontSize: 10, fontFamily: 'IBM Plex Mono' }}
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} />
          </PieChart>
        ) : rec.activeType === 'scatter' ? (
          <ScatterChart {...commonProps}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} name={rec.xLabel} />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} name={rec.yLabel} />
            <Tooltip contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8' }} labelStyle={{ color: '#8a8c94' }} itemStyle={{ color: '#e4e5e8' }} />
            <Scatter data={chartData} fill={COLORS[0]} />
          </ScatterChart>
        ) : null}
      </ResponsiveContainer>
    </div>
  )
}


// ── Data Table ──

function DataTable({ record: rec }: { record: ChartRecord }) {
  const data = rec.tableData
  if (!data) return null

  return (
    <div style={{ overflow: 'auto', maxHeight: 320, borderRadius: 6, border: '1px solid var(--border)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11 }}>
        <thead>
          <tr>
            {data.headers.map((h) => (
              <th key={h} style={{
                padding: '6px 10px', textAlign: 'left',
                background: 'var(--bg2)', color: 'var(--text3)',
                borderBottom: '1px solid var(--border)',
                position: 'sticky', top: 0, fontWeight: 500,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell: any, ci: number) => (
                <td key={ci} style={{
                  padding: '5px 10px',
                  color: typeof cell === 'number' ? 'var(--green)' : 'var(--text2)',
                  borderBottom: '1px solid var(--border)',
                  whiteSpace: 'nowrap',
                }}>
                  {typeof cell === 'number' ? cell.toLocaleString() : String(cell ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}