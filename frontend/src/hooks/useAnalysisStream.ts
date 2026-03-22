import { useCallback, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useResultsStore } from '../stores/resultsStore'

export function useAnalysisStream() {
  const addExchange = useChatStore((s) => s.addExchange)
  const updateTrace = useChatStore((s) => s.updateTrace)
  const addSqlSteps = useChatStore((s) => s.addSqlSteps)
  const setReply = useChatStore((s) => s.setReply)
  const setStatus = useChatStore((s) => s.setStatus)
  const setError = useChatStore((s) => s.setError)
  const activeSource = useRef<EventSource | null>(null)

  const submit = useCallback((query: string, projectId: string) => {
    if (activeSource.current) {
      activeSource.current.close()
      activeSource.current = null
    }

    const exchangeId = addExchange(query)

    const url = `/api/analyze/stream?project_id=${encodeURIComponent(projectId)}&query=${encodeURIComponent(query)}`
    const eventSource = new EventSource(url)
    activeSource.current = eventSource

    eventSource.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data)
        updateTrace(exchangeId, data.steps)
      } catch {}
    })

    // result events during pipeline — only update chat display, NOT resultsStore
    eventSource.addEventListener('result', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'sql' && data.steps) {
          addSqlSteps(exchangeId, data.steps)
        }
        // viz result events are ignored here — we use the done event instead
        // this prevents chart duplication during critic retries
      } catch {}
    })

    // done event — all results finalized, safe to add to resultsStore
    eventSource.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data)
        const conclusion = data.report?.conclusion || 'Analysis complete.'
        setReply(exchangeId, conclusion)
        setStatus(exchangeId, 'done')

        // ── Add chart to Chart Tab (only from done event) ──
        const viz = data.viz_result
        if (viz && viz.series) {
          useResultsStore.getState().addChartRecord({
            id: 0,
            query,
            type: viz.type || 'bar',
            altTypes: viz.alt_types || [],
            activeType: viz.type || 'bar',
            title: viz.title || query,
            xLabel: viz.x_label || '',
            yLabel: viz.y_label || '',
            series: viz.series || [],
            tableData: viz.table_data || null,
            status: 'done',
          })
        }

        // ── Add SQL to SQL Tab ──
        const sqlResult = data.sql_result
        if (sqlResult?.steps?.length) {
          useResultsStore.getState().addSqlRecord({
            id: 0,
            query,
            steps: sqlResult.steps,
            status: 'done',
          })
        }

        // ── Add report record ──
        if (data.report?.should_record) {
          const now = new Date()
          const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0')

          let chartData = null
          if (viz && viz.series) {
            chartData = {
              id: 0,
              query,
              type: viz.type || 'bar',
              altTypes: viz.alt_types || [],
              activeType: viz.type || 'bar',
              title: viz.title || query,
              xLabel: viz.x_label || '',
              yLabel: viz.y_label || '',
              series: viz.series || [],
              tableData: viz.table_data || null,
              status: 'done' as const,
            }
          }

          useResultsStore.getState().addReportRecord({
            id: 0,
            query,
            time,
            conclusion,
            chartData,
            sqlSteps: sqlResult?.steps || [],
            evidence: data.report.evidence || null,
            starred: false,
            status: 'done',
          })
        }
      } catch {
        setStatus(exchangeId, 'done')
      }
      eventSource.close()
      activeSource.current = null
    })

    eventSource.addEventListener('error', (e) => {
      if (e instanceof MessageEvent) {
        try {
          const data = JSON.parse(e.data)
          setError(exchangeId, data.message || 'Analysis failed')
        } catch {
          setError(exchangeId, 'Analysis failed')
        }
      } else {
        setError(exchangeId, 'Connection lost')
      }
      eventSource.close()
      activeSource.current = null
    })
  }, [addExchange, updateTrace, addSqlSteps, setReply, setStatus, setError])

  return { submit }
}