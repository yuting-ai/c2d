import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { useResultsStore, type ReportRecord, type ChartRecord, type EvidenceData } from '../../../stores/resultsStore'
import { ChatMarkdown } from '../../chat/ChatMarkdown'
import { miniZip, downloadBlob, type ZipFile } from '../../../utils/miniZip'

// Color palette for light theme
const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4', '#84CC16']
const TABLE_VIEW_MAX_ROWS = 50

// ── renderCenteredYAxisLabel ──

function renderCenteredYAxisLabel(props: any) {
  const vb = props?.viewBox as { x: number; y: number; width: number; height: number } | undefined
  const value = String(props?.value ?? '').trim()
  if (!vb || !value) return null

  const cx = vb.x + Math.max(8, vb.width * 0.28)
  const cy = vb.y + vb.height / 2

  return (
    <text
      x={cx}
      y={cy}
      fill="#747b8b"
      fontSize={10}
      fontFamily="IBM Plex Mono"
      textAnchor="middle"
      dominantBaseline="middle"
      transform={`rotate(-90, ${cx}, ${cy})`}
    >
      {value}
    </text>
  )
}

// ── AnalysisCard ──

export default function AnalysisCard({
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
  const chart = rec.chartData
  const [activeType, setActiveType] = useState(chart?.activeType ?? chart?.type ?? 'bar')
  const [swapAxes, setSwapAxes] = useState(false)
  const [copied, setCopied] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)

  // Reset on record change
  useEffect(() => {
    setActiveType(chart?.activeType ?? chart?.type ?? 'bar')
  }, [rec.id])

  useEffect(() => {
    setSwapAxes(false)
  }, [rec.id, activeType])

  const isRunning = rec.status === 'running'

  // Create a synthetic record for ChartRenderer
  const activeChartRecord: ChartRecord | null = chart
    ? { ...chart, activeType }
    : null

  const canSwapAxes = activeType === 'line' || activeType === 'area' || activeType === 'bar' || activeType === 'scatter'
  const tableRowCount = chart?.tableData?.rows?.length ?? 0
  const canShowTable = tableRowCount > 0 && tableRowCount <= TABLE_VIEW_MAX_ROWS

  const allTypes = useMemo(() => {
    if (!chart) return []
    const types = [chart.type, ...chart.altTypes.filter(t => t !== chart.type)]
    if (canShowTable && !types.includes('table')) types.push('table')
    return types
  }, [chart, canShowTable])

  const exportChart = () => {
    if (!activeChartRecord) return
    if (activeType === 'table') {
      const data = activeChartRecord.tableData
      if (!data) return
      const csv = [data.headers.join(','), ...data.rows.map((r: any[]) => r.map(v => `"${String(v ?? '')}"`).join(','))].join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const slug = (activeChartRecord.title || activeChartRecord.query || `table-${activeChartRecord.id}`)
        .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').substring(0, 60)
      a.download = `${slug}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } else {
      const container = chartRef.current
      if (!container) return
      const svg = container.querySelector('svg')
      if (!svg) return
      const clone = svg.cloneNode(true) as SVGElement
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      bg.setAttribute('width', '100%')
      bg.setAttribute('height', '100%')
      bg.setAttribute('fill', '#FFFFFF')
      clone.insertBefore(bg, clone.firstChild)

      const titleText = (activeChartRecord.title || activeChartRecord.query || '').trim()
      if (titleText) {
        const headerH = 44

        const vb = clone.getAttribute('viewBox')
        if (vb) {
          const parts = vb.split(/\s+/).map(Number)
          if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
            const [minX, minY, w, h] = parts
            clone.setAttribute('viewBox', `${minX} ${minY} ${w} ${h + headerH}`)
          }
        }

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        g.setAttribute('transform', `translate(0 ${headerH})`)
        const toMove: ChildNode[] = []
        clone.childNodes.forEach((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE) return
          const tag = (n as Element).tagName.toLowerCase()
          if (tag === 'defs' || tag === 'rect') return
          toMove.push(n)
        })
        toMove.forEach((n) => g.appendChild(n))
        clone.appendChild(g)

        const header = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        header.setAttribute('x', '0')
        header.setAttribute('y', '0')
        header.setAttribute('width', '100%')
        header.setAttribute('height', String(headerH))
        header.setAttribute('fill', '#FFFFFF')
        clone.insertBefore(header, g)

        const divider = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        divider.setAttribute('x1', '0')
        divider.setAttribute('y1', String(headerH))
        divider.setAttribute('x2', '100%')
        divider.setAttribute('y2', String(headerH))
        divider.setAttribute('stroke', '#E2E5ED')
        divider.setAttribute('stroke-width', '1')
        clone.insertBefore(divider, g)

        const title = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        title.setAttribute('x', '50%')
        title.setAttribute('y', String(Math.round(headerH / 2) + 1))
        title.setAttribute('text-anchor', 'middle')
        title.setAttribute('dominant-baseline', 'middle')
        title.setAttribute('fill', '#2563EB')
        title.setAttribute('font-family', 'IBM Plex Mono, monospace')
        title.setAttribute('font-size', '13')
        title.setAttribute('font-weight', '600')
        title.setAttribute('letter-spacing', '0.3')
        title.textContent = titleText
        clone.insertBefore(title, g)
      }

      const blob = new Blob([clone.outerHTML], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const slug = (activeChartRecord.title || activeChartRecord.query || `chart-${activeChartRecord.id}`)
        .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').substring(0, 60)
      a.download = `${slug}.svg`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  }

  const copyData = () => {
    const data = activeChartRecord?.tableData
    if (!data) return
    const tsv = [data.headers.join('\t'), ...data.rows.map((r: any[]) => r.join('\t'))].join('\n')
    navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // DOM-captured SVG for export (returns SVG string with white background)
  const captureSvgString = (): string => {
    const container = chartRef.current
    if (!container) return ''
    const svg = container.querySelector('svg')
    if (!svg) return ''
    const clone = svg.cloneNode(true) as SVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('width', '100%')
    bg.setAttribute('height', '100%')
    bg.setAttribute('fill', '#FFFFFF')
    clone.insertBefore(bg, clone.firstChild)
    return clone.outerHTML
  }

  const exportSection = () => {
    const slug = slugify(rec.query) || 'section'
    const files: ZipFile[] = []

    const hasDomChart = activeType !== 'table' && chart && chart.series.length > 0

    const singleHtml = buildSectionHtml(rec, index, hasDomChart ? 'chart-1.svg' : null)
    files.push({ name: `${slug}/report.html`, content: singleHtml })

    if (hasDomChart) {
      const svgStr = captureSvgString()
      if (svgStr) files.push({ name: `${slug}/chart-1.svg`, content: svgStr })
    }

    const zip = miniZip(files)
    downloadBlob(zip, `${slug}.zip`)
  }

  return (
    <div style={{
      borderBottom: '1px solid var(--border)',
      background: 'transparent',
      transition: 'all 0.2s',
    }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: expanded ? '14px 12px 14px 10px' : '13px 12px 13px 10px',
          cursor: 'pointer',
          transition: 'background 0.12s',
          borderLeft: expanded ? '3px solid var(--green)' : '3px solid transparent',
        }}
        onMouseOver={(e) => e.currentTarget.style.background = 'var(--bg2)'}
        onMouseOut={(e) => e.currentTarget.style.background = ''}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--green)', fontWeight: 600 }}>#{index}</span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11.5,
          color: expanded ? 'var(--text1)' : 'var(--text2)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          opacity: expanded ? 1 : 0.85,
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
        <span style={{
          fontSize: 10, color: 'var(--text3)',
          transition: 'transform 0.2s',
          transform: expanded ? 'rotate(90deg)' : '',
          opacity: 0.7,
        }}>▶</span>
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ padding: '0 12px 12px 12px' }}>
          {isRunning ? (
            <RunningStateCard query={rec.query} />
          ) : (
            <>
              {/* Chart section */}
              {activeChartRecord && chart && (
                <div style={{ marginBottom: 12 }}>
                  {/* Type switcher + swap + export buttons */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center' }}>
                    {allTypes.map((t) => (
                      <button
                        key={t}
                        onClick={() => setActiveType(t)}
                        style={{
                          fontFamily: 'var(--mono)', fontSize: 10,
                          padding: '3px 10px', borderRadius: 4,
                          border: `1px solid ${activeType === t ? 'var(--green)' : 'var(--border2)'}`,
                          background: activeType === t ? 'var(--green-dim)' : 'var(--bg3)',
                          color: activeType === t ? 'var(--green)' : 'var(--text3)',
                          cursor: 'pointer', transition: 'all 0.12s',
                        }}
                      >
                        {t}
                      </button>
                    ))}

                    <div style={{ flex: 1 }} />

                    {canSwapAxes && (
                      <button
                        onClick={() => setSwapAxes((v) => !v)}
                        title="Swap X / Y axis"
                        style={{
                          fontFamily: 'var(--mono)', fontSize: 10,
                          padding: '3px 8px', borderRadius: 4,
                          border: `1px solid ${swapAxes ? 'var(--green)' : 'var(--border)'}`,
                          background: swapAxes ? 'var(--green-dim)' : 'var(--bg2)',
                          color: swapAxes ? 'var(--green)' : 'var(--text3)',
                          cursor: 'pointer', transition: 'all 0.12s',
                        }}
                      >
                        ⇄ x/y
                      </button>
                    )}

                    {/* Download: SVG or CSV depending on view */}
                    <button
                      onClick={exportChart}
                      title={activeType === 'table' ? 'Download CSV' : 'Download SVG'}
                      style={{
                        fontFamily: 'var(--mono)', fontSize: 10,
                        padding: '3px 8px', borderRadius: 4,
                        border: '1px solid var(--border)', background: 'var(--bg2)',
                        color: 'var(--text3)', cursor: 'pointer', transition: 'all 0.12s',
                      }}
                      onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--text3)'; e.currentTarget.style.color = 'var(--text2)' }}
                      onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text3)' }}
                    >
                      {activeType === 'table' ? '↓ csv' : '↓ svg'}
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
                      onMouseOver={(e) => { if (!copied) { e.currentTarget.style.borderColor = 'var(--text3)'; e.currentTarget.style.color = 'var(--text2)' } }}
                      onMouseOut={(e) => { if (!copied) { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text3)' } }}
                    >
                      {copied ? '✓ copied' : '⎘ data'}
                    </button>
                  </div>

                  {/* Chart / Table render */}
                  <div ref={chartRef}>
                    {activeType === 'table' ? (
                      <DataTable record={activeChartRecord} />
                    ) : (
                      <ChartRenderer record={activeChartRecord} swapAxes={swapAxes} />
                    )}
                  </div>
                </div>
              )}

              {/* Conclusion (Markdown) */}
              {rec.conclusion && (
                <div
                  className="report-conclusion-md"
                  style={{
                    fontSize: 13.5, color: 'var(--text1)', lineHeight: 1.7,
                    wordBreak: 'break-word', marginBottom: 12,
                  }}
                >
                  <ChatMarkdown text={rec.conclusion} />
                </div>
              )}

              {/* Evidence section */}
              {rec.evidence && rec.evidence.tests.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <EvidenceSection evidence={rec.evidence} />
                </div>
              )}

              {/* SQL used — collapsible */}
              {rec.sqlSteps.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <SqlCollapsible steps={rec.sqlSteps} />
                </div>
              )}

              {/* Per-card export */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={exportSection}
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
            </>
          )}
        </div>
      )}
    </div>
  )
}


// ── Running State Card ──

function RunningStateCard({ query }: { query: string }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 12,
      background: 'var(--bg0)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--text3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{query}</span>
        <span style={{
          fontFamily: 'var(--mono)',
          fontSize: 9.5,
          padding: '4px 10px',
          borderRadius: 8,
          border: '1px solid rgba(198,148,58,0.35)',
          background: 'rgba(198,148,58,0.10)',
          color: '#c6943a',
          whiteSpace: 'nowrap',
        }}>
          Analysis · waiting
        </span>
      </div>
      <div style={{
        minHeight: 126,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--mono)',
          color: 'var(--text3)',
          fontSize: 11,
          opacity: 0.9,
        }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#c6943a', boxShadow: '0 0 0 1px rgba(198,148,58,0.35)' }} />
          <span>Analysis in progress...</span>
        </div>
      </div>
    </div>
  )
}


// ── Chart Renderer ──

function ChartRenderer({ record: rec, swapAxes }: { record: ChartRecord; swapAxes: boolean }) {
  const [visibleSeries, setVisibleSeries] = useState<string[]>(() => rec.series.map((s) => s.name))
  const [zoomRange, setZoomRange] = useState<{ start: number; end: number } | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [showAllScatterTicks, setShowAllScatterTicks] = useState(false)
  const [showFullScatterDetail, setShowFullScatterDetail] = useState(false)
  const [showAllSeriesTicks, setShowAllSeriesTicks] = useState(false)
  const [showFullSeriesDetail, setShowFullSeriesDetail] = useState(false)

  const toFiniteNumber = (value: unknown): number | null => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/,/g, '').trim())
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  const normalizedSeries = useMemo(() => {
    return rec.series.map((s) => {
      const normalizedY = s.y.map((v) => toFiniteNumber(v))
      return { ...s, y: normalizedY }
    })
  }, [rec.series])

  const seriesMeta = useMemo(() => {
    const seen = new Map<string, number>()
    return normalizedSeries.map((s, idx) => {
      const baseLabel = String(s.name || `series ${idx + 1}`)
      const count = seen.get(baseLabel) || 0
      seen.set(baseLabel, count + 1)
      const label = count === 0 ? baseLabel : `${baseLabel} #${count + 1}`
      return {
        key: `s_${idx}`,
        label,
        source: s,
      }
    })
  }, [normalizedSeries])

  const chartData = useMemo(() => {
    if (!seriesMeta.length) return []

    const toNum = (v: unknown): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (typeof v === 'string') {
        const parsed = Number(v.replace(/,/g, '').trim())
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    const xSet = new Set<string | number>()
    seriesMeta.forEach((m) => {
      m.source.x.forEach((x) => { if (x != null) xSet.add(x) })
    })

    const xValues = Array.from(xSet)
    const normalizeX = (x: string | number): string | number => {
      const n = toNum(x)
      return n === null ? x : n
    }
    const normalizedXValuesRaw = xValues.map((x) => normalizeX(x))
    const seen = new Set<string>()
    const normalizedXValues = normalizedXValuesRaw.filter((x) => {
      const k = typeof x === 'number' ? `n:${x}` : `s:${x}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    const allNumeric = normalizedXValues.every((x) => typeof x === 'number')
    if (allNumeric) normalizedXValues.sort((a, b) => Number(a) - Number(b))

    const seriesLookup = seriesMeta.map((m) => {
      const map = new Map<string | number, number | null>()
      m.source.x.forEach((x, idx) => {
        map.set(normalizeX(x), m.source.y[idx] ?? null)
      })
      return { key: m.key, map }
    })

    return normalizedXValues.map((xVal) => {
      const point: Record<string, any> = { x: xVal }
      seriesLookup.forEach((s) => {
        point[s.key] = s.map.has(xVal) ? s.map.get(xVal) : null
      })
      return point
    })
  }, [seriesMeta])

  const seriesNames = seriesMeta.map((s) => s.label)
  const labelToKey = useMemo(() => {
    const map = new Map<string, string>()
    seriesMeta.forEach((m) => map.set(m.label, m.key))
    return map
  }, [seriesMeta])

  useEffect(() => {
    setVisibleSeries(seriesNames)
  }, [rec.id, seriesNames.join('|')])

  useEffect(() => {
    setZoomRange(null)
  }, [rec.id])

  useEffect(() => {
    setZoomLevel(1)
  }, [rec.id, rec.activeType, swapAxes])

  useEffect(() => {
    setShowFullScatterDetail(false)
  }, [rec.id, rec.activeType, swapAxes])
  useEffect(() => {
    setShowFullSeriesDetail(false)
  }, [rec.id, rec.activeType, swapAxes])

  const colorByName = useMemo(() => {
    const map = new Map<string, string>()
    seriesNames.forEach((name, i) => map.set(name, COLORS[i % COLORS.length]))
    return map
  }, [seriesNames])

  const visibleSet = new Set(visibleSeries)
  const activeSeriesNames = visibleSeries.length === 0
    ? seriesNames
    : seriesNames.filter((name) => visibleSet.has(name))

  const fullStart = 0
  const fullEnd = Math.max(chartData.length - 1, 0)
  const safeRange = zoomRange
    ? {
        start: Math.max(0, Math.min(zoomRange.start, fullEnd)),
        end: Math.max(0, Math.min(zoomRange.end, fullEnd)),
      }
    : { start: fullStart, end: fullEnd }
  const selectedRange = safeRange.start <= safeRange.end
    ? safeRange
    : { start: safeRange.end, end: safeRange.start }

  const visibleCount = selectedRange.end - selectedRange.start + 1
  const targetTicks = visibleCount > 40 ? 12 : 9
  const xTickInterval = Math.max(0, Math.ceil(visibleCount / targetTicks) - 1)

  const rangeStartLabel = chartData[selectedRange.start]?.x
  const rangeEndLabel = chartData[selectedRange.end]?.x
  const rangeSpan = Math.max(fullEnd - fullStart, 1)
  const startPercent = ((selectedRange.start - fullStart) / rangeSpan) * 100
  const endPercent = ((selectedRange.end - fullStart) / rangeSpan) * 100

  const hasInteractiveLegend = rec.activeType === 'bar'
  const showScatterLegend = false
  const isTemporalLabel = (v: unknown) => {
    if (v instanceof Date) return true
    if (typeof v === 'number' && Number.isFinite(v)) {
      const year = Math.trunc(v)
      if (year >= 1900 && year <= 2100) return true
    }
    if (typeof v !== 'string') return false
    const s = v.trim()
    if (!s) return false
    if (/^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/.test(s)) return true
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(s)) return true
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i.test(s)) return true
    if (/^q[1-4](\s*\d{2,4})?$/i.test(s)) return true
    const t = Date.parse(s)
    return Number.isFinite(t)
  }

  const xValuesAll = chartData.map((d) => d.x)
  const xIsNumeric = xValuesAll.length > 0 && xValuesAll.every((x) => typeof x === 'number')
  const xIsTemporal = xValuesAll.length > 0 && xValuesAll.every((x) => isTemporalLabel(x))
  const formatXAxisTick = (value: unknown) => {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return ''
      if (Number.isInteger(value)) return String(value)
      const abs = Math.abs(value)
      if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
      if (abs >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
      return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
    }
    if (value instanceof Date) {
      const y = value.getFullYear()
      const m = String(value.getMonth() + 1).padStart(2, '0')
      const d = String(value.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
    const raw = String(value ?? '')
    if (!raw) return ''
    if (isTemporalLabel(raw)) {
      const parsed = new Date(raw)
      if (!Number.isNaN(parsed.getTime())) {
        const y = parsed.getFullYear()
        const m = String(parsed.getMonth() + 1).padStart(2, '0')
        const d = String(parsed.getDate()).padStart(2, '0')
        return `${y}-${m}-${d}`
      }
    }
    return raw.length > 14 ? `${raw.slice(0, 14)}…` : raw
  }

  const scatterSeriesData = useMemo(() => {
    if (rec.activeType !== 'scatter') return []

    const activeSet = new Set(activeSeriesNames)
    return seriesMeta
      .filter((m) => activeSet.has(m.label))
      .map((m) => {
        const points = m.source.x
          .map((rawX, idx) => {
            const rawY = m.source.y[idx]
            const x = typeof rawX === 'number' ? rawX : Number(rawX)
            const y = typeof rawY === 'number' ? rawY : Number(rawY)
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null
            return swapAxes ? { x: y, y: x } : { x, y }
          })
          .filter((p): p is { x: number; y: number } => p !== null)
        return { name: m.label, points }
      })
      .filter((s) => s.points.length > 0)
  }, [rec.activeType, activeSeriesNames, seriesMeta, swapAxes])

  const scatterTotalPoints = useMemo(
    () => scatterSeriesData.reduce((sum, s) => sum + s.points.length, 0),
    [scatterSeriesData]
  )
  const scatterPointLimit = 5000
  const scatterCanSwitchDetail = scatterTotalPoints > scatterPointLimit
  const isScatterOverview = rec.activeType === 'scatter' && !showFullScatterDetail && scatterCanSwitchDetail
  const scatterRenderSeriesData = useMemo(() => {
    if (!isScatterOverview) return scatterSeriesData

    return scatterSeriesData.map((s) => {
      const buckets = new Map<number | string, { sumY: number; count: number; minY: number; maxY: number }>()
      for (const p of s.points) {
        const key = p.x
        const existing = buckets.get(key)
        if (existing) {
          existing.sumY += p.y
          existing.count += 1
          if (p.y < existing.minY) existing.minY = p.y
          if (p.y > existing.maxY) existing.maxY = p.y
        } else {
          buckets.set(key, { sumY: p.y, count: 1, minY: p.y, maxY: p.y })
        }
      }

      const aggregated: Array<{ x: number; y: number }> = []
      for (const [x, b] of buckets) {
        const xNum = typeof x === 'number' ? x : Number(x)
        if (!Number.isFinite(xNum)) continue
        aggregated.push({ x: xNum, y: b.sumY / b.count })
      }
      aggregated.sort((a, b) => a.x - b.x)
      return { ...s, points: aggregated }
    })
  }, [isScatterOverview, scatterSeriesData])

  const scatterXStats = useMemo(() => {
    if (rec.activeType !== 'scatter') return null as null | { min: number; max: number; ticks?: number[]; isIntegerAxis?: boolean; span?: number }
    const xs = scatterSeriesData.flatMap((s) => s.points.map((p) => p.x)).filter((v) => Number.isFinite(v))
    if (!xs.length) return null
    const min = Math.min(...xs)
    const max = Math.max(...xs)
    const allInt = xs.every((v) => Number.isInteger(v))
    if (allInt) {
      const start = Math.floor(min)
      const end = Math.ceil(max)
      const span = end - start
      if (showAllScatterTicks && span <= 200) {
        const ticks = Array.from({ length: span + 1 }, (_, i) => start + i)
        return { min: start, max: end, ticks, isIntegerAxis: true, span }
      }
      const maxTickCount = 12
      const step = Math.max(1, Math.ceil(span / (maxTickCount - 1)))
      const ticks: number[] = []
      for (let t = start; t <= end; t += step) ticks.push(t)
      if (ticks[ticks.length - 1] !== end) ticks.push(end)
      return { min: start, max: end, ticks, isIntegerAxis: true, span }
    }
    return { min, max, isIntegerAxis: false }
  }, [rec.activeType, scatterSeriesData, showAllScatterTicks])

  const X_TICKS_AUTO_OFF_THRESHOLD = 20
  useEffect(() => {
    if (rec.activeType !== 'scatter' || !scatterXStats?.isIntegerAxis) return
    setShowAllScatterTicks((scatterXStats.span ?? 0) <= X_TICKS_AUTO_OFF_THRESHOLD)
  }, [rec.id, rec.activeType, swapAxes, scatterXStats?.span, scatterXStats?.isIntegerAxis])

  const scatterShowAllTicksToggle = !!(scatterXStats?.isIntegerAxis && (scatterXStats.span ?? 0) > 12)

  const sortedBarData = useMemo(() => {
    if (rec.activeType !== 'bar' || xIsTemporal) return chartData

    const toNumericX = (v: unknown): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (typeof v === 'string') {
        const parsed = Number(v.replace(/,/g, '').trim())
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }
    const xIsNumericAxis = chartData.length > 0 && chartData.every((p) => toNumericX(p.x) !== null)
    if (xIsNumericAxis) {
      return [...chartData].sort((a, b) => {
        const ax = toNumericX(a.x) ?? 0
        const bx = toNumericX(b.x) ?? 0
        return ax - bx
      })
    }

    const getScore = (point: Record<string, any>) => {
      return seriesNames.reduce((sum, name) => {
        const key = labelToKey.get(name)
        const raw = key ? point[key] : undefined
        const n = typeof raw === 'number' ? raw : Number(raw)
        return sum + (Number.isFinite(n) ? n : 0)
      }, 0)
    }

    return [...chartData].sort((a, b) => getScore(b) - getScore(a))
  }, [rec.activeType, xIsTemporal, chartData, seriesNames, labelToKey])

  const chartDataForRender = rec.activeType === 'bar' ? sortedBarData : chartData
  const showRangeControls = (rec.activeType === 'line' || rec.activeType === 'area')
    && xIsTemporal
    && chartData.length > 20
    && !swapAxes

  const chartDataInRange = useMemo(() => {
    if (!showRangeControls || !zoomRange) return chartDataForRender
    const start = Math.max(0, Math.min(selectedRange.start, chartDataForRender.length - 1))
    const end = Math.max(0, Math.min(selectedRange.end, chartDataForRender.length - 1))
    if (end < start) return chartDataForRender
    return chartDataForRender.slice(start, end + 1)
  }, [showRangeControls, zoomRange, selectedRange.start, selectedRange.end, chartDataForRender])

  const activeData = chartDataInRange
  const seriesPointLimit = 5000
  const lineBarTotalPoints = useMemo(() => activeData.length, [activeData])
  const lineBarCanSwitchDetail = (rec.activeType === 'line' || rec.activeType === 'bar' || rec.activeType === 'area') && lineBarTotalPoints > seriesPointLimit
  const isLineBarOverview = lineBarCanSwitchDetail && !showFullSeriesDetail
  const seriesYKeys = useMemo(
    () => activeSeriesNames.map((name) => labelToKey.get(name)).filter((k): k is string => Boolean(k)),
    [activeSeriesNames, labelToKey]
  )

  const sampledSeriesData = useMemo(() => {
    if (!isLineBarOverview || lineBarTotalPoints <= 0) return activeData

    const toNum = (v: unknown) => (typeof v === 'number' ? v : Number(v))
    const buckets = new Map<string | number, { count: number; sums: Record<string, number> }>()
    for (const d of activeData) {
      const key = d.x
      const existing = buckets.get(key)
      if (existing) {
        existing.count += 1
        for (const yk of seriesYKeys) {
          const n = toNum(d[yk])
          if (Number.isFinite(n)) existing.sums[yk] = (existing.sums[yk] ?? 0) + n
        }
      } else {
        const sums: Record<string, number> = {}
        for (const yk of seriesYKeys) {
          const n = toNum(d[yk])
          if (Number.isFinite(n)) sums[yk] = n
        }
        buckets.set(key, { count: 1, sums })
      }
    }

    const result: Array<Record<string, any>> = []
    for (const [x, b] of buckets) {
      const row: Record<string, any> = { x }
      for (const yk of seriesYKeys) {
        row[yk] = b.count > 0 ? (b.sums[yk] ?? 0) / b.count : 0
      }
      result.push(row)
    }

    const allNumX = result.every((d) => Number.isFinite(toNum(d.x)))
    if (allNumX) result.sort((a, b) => toNum(a.x) - toNum(b.x))

    return result
  }, [isLineBarOverview, lineBarTotalPoints, activeData, seriesYKeys])

  const lineBarXStats = useMemo(() => {
    if (rec.activeType !== 'line' && rec.activeType !== 'bar' && rec.activeType !== 'area') {
      return null as null | { min: number; max: number; ticks: number[]; span: number; isIntegerAxis: boolean }
    }
    const xs = activeData
      .filter((d) => d.x != null)
      .map((d) => (typeof d.x === 'number' ? d.x : Number(d.x)))
      .filter((v) => Number.isFinite(v))
    if (!xs.length) return null
    const allInt = xs.every((v) => Number.isInteger(v))
    if (!allInt) return null
    const min = Math.floor(Math.min(...xs))
    const max = Math.ceil(Math.max(...xs))
    const span = max - min
    const ticks: number[] = []
    if (showAllSeriesTicks && span <= 200) {
      for (let t = min; t <= max; t += 1) ticks.push(t)
    } else {
      const maxTickCount = 12
      const step = Math.max(1, Math.ceil(span / (maxTickCount - 1)))
      for (let t = min; t <= max; t += step) ticks.push(t)
      if (ticks[ticks.length - 1] !== max) ticks.push(max)
    }
    return { min, max, ticks, span, isIntegerAxis: true }
  }, [rec.activeType, activeData, showAllSeriesTicks])

  useEffect(() => {
    if ((rec.activeType !== 'line' && rec.activeType !== 'bar' && rec.activeType !== 'area') || !lineBarXStats?.isIntegerAxis) return
    setShowAllSeriesTicks((lineBarXStats.span ?? 0) <= X_TICKS_AUTO_OFF_THRESHOLD)
  }, [rec.id, rec.activeType, swapAxes, lineBarXStats?.span, lineBarXStats?.isIntegerAxis])

  const lineBarShowAllTicksToggle = !!(lineBarXStats?.isIntegerAxis && lineBarXStats.span > 12)
  const lineBarShowFullDetailToggle = lineBarCanSwitchDetail

  const xAxisTicksForSeries = useMemo(() => {
    if (!activeData.length) return [] as Array<string | number>
    const values = activeData.map((d) => d.x as string | number)
    const count = values.length
    const maxTicks = count > 120 ? 10 : count > 80 ? 9 : count > 40 ? 8 : count > 20 ? 7 : Math.min(12, count)
    if (count <= maxTicks) return values
    const step = Math.max(1, Math.floor((count - 1) / (maxTicks - 1)))
    const picked: Array<string | number> = []
    for (let i = 0; i < count; i += step) {
      picked.push(values[i])
    }
    if (picked[picked.length - 1] !== values[count - 1]) {
      picked.push(values[count - 1])
    }
    return picked
  }, [activeData])

  const legendRows = hasInteractiveLegend ? Math.max(1, Math.ceil(seriesNames.length / 12)) : 1
  const legendHeight = hasInteractiveLegend ? 22 + (legendRows - 1) * 22 : 0
  const baseChartHeight = rec.activeType === 'pie' ? 360 : (rec.activeType === 'bar' ? 400 : 340)
  const chartHeight = hasInteractiveLegend
    ? baseChartHeight + legendHeight + 18
    : baseChartHeight
  const titleTopPadding = hasInteractiveLegend ? 2 : 2

  const handleLegendClick = (name: string) => {
    setVisibleSeries((prev) => {
      if (prev.includes(name)) {
        if (prev.length === 1) return prev
        return prev.filter((n) => n !== name)
      }
      return [...prev, name]
    })
  }

  const handleLegendDoubleClick = (name: string) => {
    setVisibleSeries((prev) => (prev.length === 1 && prev[0] === name ? seriesNames : [name]))
  }

  const handleBrushChange = (next: any) => {
    if (!next) return
    const start = Number(next.startIndex ?? fullStart)
    const end = Number(next.endIndex ?? fullEnd)
    if (Number.isNaN(start) || Number.isNaN(end)) return
    if (start === fullStart && end === fullEnd) {
      setZoomRange(null)
      return
    }
    setZoomRange({ start, end })
  }

  if (!chartData.length) {
    return <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', padding: 20, textAlign: 'center' }}>No data to visualize</div>
  }

  const commonProps = {
    data: (rec.activeType === 'line' || rec.activeType === 'area' || rec.activeType === 'bar') ? sampledSeriesData : activeData,
    margin: {
      top: 8,
      right: 16,
      left: rec.activeType === 'bar' ? 18 : 8,
      bottom: rec.activeType === 'line' || rec.activeType === 'area' || rec.activeType === 'bar' ? 30 : 4,
    },
  }

  const axisStyle = { fontFamily: 'IBM Plex Mono', fontSize: 10, fill: '#4a4d58' }
  const gridStyle = { stroke: '#1f2128', strokeDasharray: '3 3' }
  const defaultSeriesName = rec.series[0]?.name || 'value'
  const xAxisBaseLabel = rec.xLabel?.trim() || 'x'
  const yAxisBaseLabel = rec.yLabel?.trim() || defaultSeriesName
  const xAxisLabel = swapAxes ? yAxisBaseLabel : xAxisBaseLabel
  const yAxisLabel = swapAxes ? xAxisBaseLabel : yAxisBaseLabel

  const lineAreaNumericTicks = useMemo(() => {
    if (!xIsNumeric || !activeData.length) return [] as number[]
    const numericValues = activeData
      .map((d) => (typeof d.x === 'number' ? d.x : Number(d.x)))
      .filter((v) => Number.isFinite(v))

    if (!numericValues.length) return [] as number[]
    const min = Math.min(...numericValues)
    const max = Math.max(...numericValues)
    if (min === max) return [min]

    const count = numericValues.length > 80 ? 8 : 7
    const step = (max - min) / (count - 1)
    return Array.from({ length: count }, (_, i) => min + step * i)
  }, [xIsNumeric, activeData])

  const tickStyle = { fontFamily: 'IBM Plex Mono', fontSize: 10, fill: '#8a8c94' }
  const tickFormatX = (value: any) => formatXAxisTick(value)
  const formatYAxisTick = (value: any) => {
    const toNum = (v: unknown): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (typeof v === 'string') {
        const parsed = Number(v.replace(/,/g, '').trim())
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    const n = toNum(value)
    if (n !== null) {
      const abs = Math.abs(n)
      if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`
      if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
      if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`
      if (Number.isInteger(n)) return String(n)
      return n.toFixed(2).replace(/\.?0+$/, '')
    }

    const raw = String(value ?? '')
    return raw.length > 10 ? `${raw.slice(0, 10)}…` : raw
  }

  const canZoom = rec.activeType !== 'table'
  const minZoom = 1
  const maxZoom = 5
  const zoomPercent = Math.round(zoomLevel * 100)

  // suppress unused variable warning
  void xAxisTicksForSeries

  return (
    <div style={{
      width: '100%', height: chartHeight,
      background: 'var(--bg0)', borderRadius: 6,
      padding: '8px 4px 4px', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 8px 8px',
        fontFamily: 'var(--mono)',
        borderBottom: rec.activeType === 'scatter' ? 'none' : '1px solid var(--border)',
        marginBottom: rec.activeType === 'scatter' ? 2 : 8,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 9.5, visibility: 'hidden' }}>&nbsp;</span>
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--text3)' }}>
          series: {activeSeriesNames.length}/{seriesNames.length}
        </span>
      </div>

      {canZoom && (
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px 8px',
        }}>
          <button
            onClick={() => setZoomLevel((z) => Math.max(minZoom, Number((z - 0.25).toFixed(2))))}
            disabled={zoomLevel <= minZoom}
            title="Zoom out"
            style={{
              fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 4,
              border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text3)',
              cursor: zoomLevel <= minZoom ? 'default' : 'pointer',
              opacity: zoomLevel <= minZoom ? 0.45 : 1,
            }}
          >-</button>
          <button
            onClick={() => setZoomLevel(1)}
            disabled={zoomLevel === 1}
            title="Reset zoom"
            style={{
              fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 4,
              border: `1px solid ${zoomLevel === 1 ? 'var(--border)' : 'var(--green-border)'}`,
              background: zoomLevel === 1 ? 'var(--bg2)' : 'var(--green-dim)',
              color: zoomLevel === 1 ? 'var(--text3)' : 'var(--green)',
              cursor: zoomLevel === 1 ? 'default' : 'pointer',
              opacity: zoomLevel === 1 ? 0.55 : 1,
              minWidth: 56,
            }}
          >{zoomPercent}%</button>
          <button
            onClick={() => setZoomLevel((z) => Math.min(maxZoom, Number((z + 0.25).toFixed(2))))}
            disabled={zoomLevel >= maxZoom}
            title="Zoom in"
            style={{
              fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 4,
              border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text3)',
              cursor: zoomLevel >= maxZoom ? 'default' : 'pointer',
              opacity: zoomLevel >= maxZoom ? 0.45 : 1,
            }}
          >+</button>

          {rec.activeType === 'scatter' && scatterShowAllTicksToggle && (
            <button
              onClick={() => setShowAllScatterTicks((v) => !v)}
              title={showAllScatterTicks ? 'Switch to sparse x-axis ticks' : 'Show all integer x-axis ticks'}
              style={{
                fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 4,
                border: `1px solid ${showAllScatterTicks ? 'var(--green-border)' : 'var(--border)'}`,
                background: showAllScatterTicks ? 'var(--green-dim)' : 'var(--bg2)',
                color: showAllScatterTicks ? 'var(--green)' : 'var(--text3)',
                cursor: 'pointer',
              }}
            >
              {showAllScatterTicks ? 'x ticks: all' : 'x ticks: sparse'}
            </button>
          )}
          {(rec.activeType === 'line' || rec.activeType === 'bar') && lineBarShowAllTicksToggle && (
            <button
              onClick={() => setShowAllSeriesTicks((v) => !v)}
              title={showAllSeriesTicks ? 'Switch to sparse x-axis ticks' : 'Show all integer x-axis ticks'}
              style={{
                fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 4,
                border: `1px solid ${showAllSeriesTicks ? 'var(--green-border)' : 'var(--border)'}`,
                background: showAllSeriesTicks ? 'var(--green-dim)' : 'var(--bg2)',
                color: showAllSeriesTicks ? 'var(--green)' : 'var(--text3)',
                cursor: 'pointer',
              }}
            >
              {showAllSeriesTicks ? 'x ticks: all' : 'x ticks: sparse'}
            </button>
          )}
          {rec.activeType === 'scatter' && (
            <button
              onClick={() => scatterCanSwitchDetail && setShowFullScatterDetail((v) => !v)}
              disabled={!scatterCanSwitchDetail}
              title={
                scatterCanSwitchDetail
                  ? (showFullScatterDetail ? 'Switch to overview mode (sampled, faster)' : 'Switch to detail mode (raw points)')
                  : 'Current chart already uses full detail'
              }
              style={{
                fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 4,
                border: `1px solid ${showFullScatterDetail ? 'var(--green-border)' : 'var(--border)'}`,
                background: showFullScatterDetail ? 'var(--green-dim)' : 'var(--bg2)',
                color: showFullScatterDetail ? 'var(--green)' : 'var(--text3)',
                cursor: scatterCanSwitchDetail ? 'pointer' : 'default',
                opacity: scatterCanSwitchDetail ? 1 : 0.5,
              }}
            >
              {showFullScatterDetail ? 'mode: detail' : 'mode: overview'}
            </button>
          )}
          {lineBarShowFullDetailToggle && (
            <button
              onClick={() => setShowFullSeriesDetail((v) => !v)}
              title={showFullSeriesDetail ? 'Switch to overview mode (aggregated, faster)' : 'Switch to detail mode (raw data)'}
              style={{
                fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', borderRadius: 4,
                border: `1px solid ${showFullSeriesDetail ? 'var(--green-border)' : 'var(--border)'}`,
                background: showFullSeriesDetail ? 'var(--green-dim)' : 'var(--bg2)',
                color: showFullSeriesDetail ? 'var(--green)' : 'var(--text3)',
                cursor: 'pointer',
              }}
            >
              {showFullSeriesDetail ? 'mode: detail' : 'mode: overview'}
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowX: zoomLevel > 1 ? 'auto' : 'hidden', overflowY: 'hidden' }}>
        <div style={{ width: `${zoomLevel * 100}%`, minWidth: '100%', height: '100%' }}>
          <ResponsiveContainer width="100%" height="100%">
            {rec.activeType === 'line' ? (
              <LineChart {...commonProps} layout={swapAxes ? 'vertical' : 'horizontal'}>
                <CartesianGrid {...gridStyle} />
                <XAxis
                  {...(swapAxes
                    ? { type: 'number' as const, tickFormatter: formatYAxisTick }
                    : {
                        dataKey: 'x',
                        type: 'number' as const,
                        tickFormatter: tickFormatX,
                        domain: lineBarXStats ? [lineBarXStats.min, lineBarXStats.max] : undefined,
                        ticks: lineBarXStats?.ticks,
                      }
                  )}
                  tick={tickStyle}
                  axisLine={{ stroke: '#1f2128' }}
                  label={{ value: xAxisLabel, position: 'insideBottom', offset: -2, fill: '#747b8b', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                />
                <YAxis
                  {...(swapAxes
                    ? { type: 'category' as const, dataKey: 'x', tickFormatter: tickFormatX, width: 90 }
                    : { type: 'number' as const, tickFormatter: formatYAxisTick }
                  )}
                  tick={tickStyle}
                  axisLine={{ stroke: '#1f2128' }}
                  label={{ value: yAxisLabel, content: renderCenteredYAxisLabel }}
                />
                <Tooltip content={<SortedTooltip xLabel={xAxisLabel} visibleSeries={activeSeriesNames} colorByName={colorByName} />} />
                {activeSeriesNames.map((name) => (
                  <Line
                    key={name}
                    type="monotone"
                    dataKey={labelToKey.get(name) || name}
                    name={name}
                    stroke={colorByName.get(name) || COLORS[0]}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            ) : rec.activeType === 'area' ? (
              <AreaChart {...commonProps} layout={swapAxes ? 'vertical' : 'horizontal'}>
                <CartesianGrid {...gridStyle} />
                <XAxis
                  {...(swapAxes
                    ? { type: 'number' as const, tickFormatter: formatYAxisTick }
                    : {
                        dataKey: 'x',
                        type: 'number' as const,
                        tickFormatter: tickFormatX,
                        domain: lineBarXStats ? [lineBarXStats.min, lineBarXStats.max] : undefined,
                        ticks: lineBarXStats?.ticks,
                      }
                  )}
                  tick={tickStyle}
                  axisLine={{ stroke: '#1f2128' }}
                  label={{ value: xAxisLabel, position: 'insideBottom', offset: -2, fill: '#747b8b', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                />
                <YAxis
                  {...(swapAxes
                    ? { type: 'category' as const, dataKey: 'x', tickFormatter: tickFormatX, width: 90 }
                    : { type: 'number' as const, tickFormatter: formatYAxisTick }
                  )}
                  tick={tickStyle}
                  axisLine={{ stroke: '#1f2128' }}
                  label={{ value: yAxisLabel, content: renderCenteredYAxisLabel }}
                />
                <Tooltip content={<SortedTooltip xLabel={xAxisLabel} visibleSeries={activeSeriesNames} colorByName={colorByName} />} />
                {activeSeriesNames.map((name) => (
                  <Area
                    key={name}
                    type="monotone"
                    dataKey={labelToKey.get(name) || name}
                    name={name}
                    stroke={colorByName.get(name) || COLORS[0]}
                    fill={colorByName.get(name) || COLORS[0]}
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                ))}
              </AreaChart>
            ) : rec.activeType === 'bar' ? (
              <BarChart {...commonProps} layout={swapAxes ? 'vertical' : 'horizontal'}>
                <CartesianGrid {...gridStyle} />
                <XAxis
                  {...(swapAxes
                    ? { type: 'number' as const }
                    : { dataKey: 'x', tickFormatter: tickFormatX, interval: xTickInterval }
                  )}
                  {...(!swapAxes && lineBarXStats
                    ? { ticks: lineBarXStats.ticks, interval: showAllSeriesTicks ? 0 : xTickInterval }
                    : {}
                  )}
                  tick={tickStyle}
                  axisLine={{ stroke: '#1f2128' }}
                  label={{ value: xAxisLabel, position: 'bottom', offset: 10, fill: '#747b8b', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                />
                <YAxis
                  {...(swapAxes
                    ? { type: 'category' as const, dataKey: 'x', tickFormatter: tickFormatX, width: 90 }
                    : { tickFormatter: formatYAxisTick }
                  )}
                  tick={tickStyle}
                  axisLine={{ stroke: '#1f2128' }}
                  label={{ value: yAxisLabel, content: renderCenteredYAxisLabel }}
                />
                <Tooltip content={<SortedTooltip xLabel={xAxisLabel} visibleSeries={activeSeriesNames} colorByName={colorByName} />} cursor={{ fill: 'rgba(62,255,160,0.04)' }} />
                {activeSeriesNames.length === 1 ? (
                  <Bar dataKey={labelToKey.get(activeSeriesNames[0]) || activeSeriesNames[0]} name={activeSeriesNames[0]} radius={[3, 3, 0, 0]}>
                    {chartDataForRender.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                ) : (
                  activeSeriesNames.map((name) => (
                    <Bar key={name} dataKey={labelToKey.get(name) || name} name={name} fill={colorByName.get(name) || COLORS[0]} radius={[3, 3, 0, 0]} />
                  ))
                )}
              </BarChart>
            ) : rec.activeType === 'pie' ? (
              <PieChart>
                <Pie
                  data={chartData.map((d) => ({ name: d.x, value: d[labelToKey.get(seriesNames[0]) || seriesNames[0]] || 0 }))}
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
                <Tooltip
                  formatter={(value: unknown) => [Number(value ?? 0).toLocaleString(), yAxisLabel]}
                  labelFormatter={(label: unknown) => `${xAxisLabel}: ${String(label ?? '')}`}
                  contentStyle={{ background: '#111318', border: '1px solid #272a33', borderRadius: 6, fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8' }}
                  labelStyle={{ color: '#8a8c94' }}
                  itemStyle={{ color: '#e4e5e8' }}
                />
              </PieChart>
            ) : rec.activeType === 'scatter' ? (
              <ScatterChart {...commonProps}>
                <CartesianGrid {...gridStyle} />
                <XAxis
                  type="number"
                  dataKey="x"
                  tick={tickStyle}
                  tickFormatter={tickFormatX}
                  domain={scatterXStats ? [scatterXStats.min, scatterXStats.max] : undefined}
                  ticks={scatterXStats?.ticks}
                  axisLine={{ stroke: '#1f2128' }}
                  name={rec.xLabel}
                  label={{ value: xAxisLabel, position: 'insideBottom', offset: -2, fill: '#747b8b', fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  tick={tickStyle}
                  tickFormatter={formatYAxisTick}
                  axisLine={{ stroke: '#1f2128' }}
                  name={rec.yLabel}
                  label={{ value: yAxisLabel, content: renderCenteredYAxisLabel }}
                />
                <Tooltip
                  content={({ active, payload }) => (
                    <ScatterTooltip
                      active={active}
                      payload={payload}
                      xLabel={xAxisLabel}
                      yLabel={yAxisLabel}
                      colorByName={colorByName}
                      isOverview={isScatterOverview}
                    />
                  )}
                />
                {showScatterLegend && (
                  <Legend
                    verticalAlign="bottom"
                    height={legendHeight}
                    wrapperStyle={{ fontFamily: 'IBM Plex Mono', fontSize: 10 }}
                    content={() => (
                      <InteractiveLegend
                        allSeries={seriesNames}
                        colorByName={colorByName}
                        activeSeries={activeSeriesNames}
                        onClickName={handleLegendClick}
                        onDoubleClickName={handleLegendDoubleClick}
                      />
                    )}
                  />
                )}
                {scatterRenderSeriesData.map((s) => (
                  <Scatter
                    key={s.name}
                    name={s.name}
                    data={s.points}
                    fill={colorByName.get(s.name) || COLORS[0]}
                    isAnimationActive={false}
                  />
                ))}
              </ScatterChart>
            ) : (
              <BarChart {...commonProps}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="x" tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
                <YAxis tick={axisStyle} axisLine={{ stroke: '#1f2128' }} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{
        padding: `${titleTopPadding}px 8px 6px`,
        textAlign: 'center',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: '#b7bdcc',
        letterSpacing: '0.01em',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {rec.title || rec.query}
      </div>

      {hasInteractiveLegend && (
        <div style={{ padding: '4px 8px 2px' }}>
          <InteractiveLegend
            allSeries={seriesNames}
            colorByName={colorByName}
            activeSeries={activeSeriesNames}
            onClickName={handleLegendClick}
            onDoubleClickName={handleLegendDoubleClick}
          />
        </div>
      )}

      {showRangeControls && (
        <div style={{ padding: '4px 12px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
            range: {String(rangeStartLabel)} - {String(rangeEndLabel)}
          </div>
          <div className="c2d-range-row">
            <div className="c2d-range-track-wrap">
              <div className="c2d-range-track-bg" />
              <div
                className="c2d-range-track-active"
                style={{
                  left: `${Math.max(0, Math.min(startPercent, 100))}%`,
                  width: `${Math.max(0, Math.min(endPercent - startPercent, 100))}%`,
                }}
              />
              <input
                className="c2d-range-input c2d-range-input-start"
                type="range"
                min={fullStart}
                max={fullEnd}
                value={selectedRange.start}
                onChange={(e) => {
                  const nextStart = Number(e.target.value)
                  const end = selectedRange.end
                  if (nextStart >= end) {
                    setZoomRange({ start: Math.max(fullStart, end - 1), end })
                  } else {
                    setZoomRange({ start: nextStart, end })
                  }
                }}
              />
              <input
                className="c2d-range-input c2d-range-input-end"
                type="range"
                min={fullStart}
                max={fullEnd}
                value={selectedRange.end}
                onChange={(e) => {
                  const start = selectedRange.start
                  const nextEnd = Number(e.target.value)
                  if (nextEnd <= start) {
                    setZoomRange({ start, end: Math.min(fullEnd, start + 1) })
                  } else {
                    setZoomRange({ start, end: nextEnd })
                  }
                }}
              />
            </div>
            <button
              onClick={() => setZoomRange(null)}
              disabled={!zoomRange}
              style={{
                fontFamily: 'var(--mono)', fontSize: 9.5, padding: '3px 8px', borderRadius: 4,
                border: '1px solid var(--border2)', background: 'var(--bg2)', color: 'var(--text3)',
                cursor: zoomRange ? 'pointer' : 'default', opacity: zoomRange ? 1 : 0.5,
              }}
            >
              reset
            </button>
          </div>
        </div>
      )}
    </div>
  )
}


// ── Interactive Legend ──

function InteractiveLegend({
  allSeries,
  colorByName,
  activeSeries,
  onClickName,
  onDoubleClickName,
}: {
  allSeries: string[]
  colorByName: Map<string, string>
  activeSeries: string[]
  onClickName: (name: string) => void
  onDoubleClickName: (name: string) => void
}) {
  if (!allSeries.length) return null
  const activeSet = new Set(activeSeries)
  const clickTimerRef = useRef<number | null>(null)
  const lastClickRef = useRef<{ name: string; ts: number } | null>(null)

  const handleLegendClick = (name: string) => {
    const now = Date.now()
    const last = lastClickRef.current

    if (last && last.name === name && now - last.ts <= 320) {
      lastClickRef.current = null
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current)
        clickTimerRef.current = null
      }
      onDoubleClickName(name)
      return
    }

    lastClickRef.current = { name, ts: now }
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current)
    }

    clickTimerRef.current = window.setTimeout(() => {
      onClickName(name)
      clickTimerRef.current = null
      if (lastClickRef.current?.name === name) {
        lastClickRef.current = null
      }
    }, 320)
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4, paddingRight: 4 }}>
      {allSeries.map((name) => {
        const color = colorByName.get(name) || '#8a8c94'
        const active = activeSet.has(name)
        return (
          <button
            key={name}
            type="button"
            onClick={() => handleLegendClick(name)}
            title="click: toggle · double click: focus"
            style={{
              fontFamily: 'var(--mono)', fontSize: 9.5,
              border: `1px solid ${active ? color : 'var(--border2)'}`,
              background: active ? 'var(--bg2)' : 'transparent',
              color: active ? 'var(--text2)' : 'var(--text3)',
              borderRadius: 4, padding: '2px 7px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, opacity: active ? 1 : 0.45 }} />
            {name}
          </button>
        )
      })}
    </div>
  )
}


// ── SortedTooltip ──

function SortedTooltip({
  active,
  payload,
  label,
  xLabel,
  visibleSeries,
  colorByName,
}: {
  active?: boolean
  payload?: any[]
  label?: string | number
  xLabel?: string
  visibleSeries: string[]
  colorByName: Map<string, string>
}) {
  if (!active || !payload?.length) return null

  const visibleSet = new Set(visibleSeries)
  const rows = payload
    .filter((p) => visibleSet.has(String(p.name ?? p.dataKey)))
    .map((p) => ({
      name: String(p.name ?? p.dataKey),
      value: typeof p.value === 'number' ? p.value : Number(p.value),
    }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value)

  if (!rows.length) return null

  const formattedLabel = typeof label === 'number'
    ? (Number.isInteger(label) ? String(label) : label.toLocaleString())
    : String(label ?? '')

  return (
    <div style={{
      background: '#111318', border: '1px solid #272a33', borderRadius: 6,
      fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8', padding: '8px 10px',
      minWidth: 180,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
        <span style={{ color: '#6b7280' }}>{xLabel || 'x'}</span>
        <span style={{ color: '#8a8c94' }}>{formattedLabel}</span>
      </div>
      {rows.map((r) => (
        <div key={r.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 2 }}>
          <span style={{ color: colorByName.get(r.name) || '#e4e5e8' }}>{r.name}</span>
          <span>{r.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}


// ── ScatterTooltip ──

function ScatterTooltip({
  active,
  payload,
  xLabel,
  yLabel,
  colorByName,
  isOverview,
}: {
  active?: boolean
  payload?: any[]
  xLabel: string
  yLabel: string
  colorByName: Map<string, string>
  isOverview?: boolean
}) {
  if (!active || !payload?.length) return null

  const first = payload[0]
  const point = first?.payload as { x?: number; y?: number } | undefined
  const seriesName = String(first?.name || first?.dataKey || '')
  const x = typeof point?.x === 'number' ? point.x : Number(point?.x)
  const y = typeof point?.y === 'number' ? point.y : Number(point?.y)
  const safeX = Number.isFinite(x) ? x : null
  const safeY = Number.isFinite(y) ? y : null

  return (
    <div style={{
      background: '#111318', border: '1px solid #272a33', borderRadius: 6,
      fontFamily: 'IBM Plex Mono', fontSize: 11, color: '#e4e5e8', padding: '8px 10px',
      minWidth: 170,
    }}>
      <div style={{ color: '#8a8c94', marginBottom: 6 }}>
        {seriesName || 'point'}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 2 }}>
        <span>{xLabel}</span>
        <span>{safeX === null ? '-' : safeX.toLocaleString()}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <span>{isOverview ? `avg(${yLabel})` : yLabel}</span>
        <span style={{ color: colorByName.get(seriesName) || '#e4e5e8' }}>
          {safeY === null ? '-' : safeY.toLocaleString()}
        </span>
      </div>
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
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
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

      {open && (
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
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

          {evidence.anomalies.length > 0 && (
            <>
              <div style={{ height: 1, background: 'var(--border, #1f2128)', margin: '4px 0' }} />
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


// ── Version Badge ──

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


// ── Export helpers ──

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').substring(0, 60)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildSectionHtml(rec: ReportRecord, index: number, chartFilename: string | null): string {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(rec.query)}</title>
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
<h1>${escapeHtml(rec.query)}</h1>
<div class="meta">exported ${new Date().toISOString().slice(0, 10)}</div>
<div class="section">
  <div class="section-header">
    <span class="section-num">#${index}</span>
    <span class="section-query">${escapeHtml(rec.query)}</span>
    <span class="section-time">${rec.time}</span>
  </div>
`

  if (chartFilename) {
    html += `  <div class="chart-wrap"><img src="${chartFilename}" alt="${escapeHtml(rec.query)}"></div>\n`
  }

  html += `  <div class="conclusion">${escapeHtml(rec.conclusion)}</div>\n`

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

  html += `</div>
<div class="footer">Exported from analyst · ${new Date().toISOString().slice(0, 10)}</div>
</body>
</html>`

  return html
}
