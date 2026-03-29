import { useCallback, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useResultsStore } from '../stores/resultsStore'
import type { NullHandlingConfig, NullHandlingWarning } from '../components/chat/NullHandlingCard'

export function useAnalysisStream() {
  const activeRun = useRef<{
    source: EventSource | null
    chartRecordId: number | null
    projectId: string | null
    sessionId: string | null
    exchangeId: number | null
  }>({
    source: null,
    chartRecordId: null,
    projectId: null,
    sessionId: null,
    exchangeId: null,
  })

  const clearActiveRun = () => {
    activeRun.current.source = null
    activeRun.current.chartRecordId = null
    activeRun.current.projectId = null
    activeRun.current.sessionId = null
    activeRun.current.exchangeId = null
  }

  const stop = useCallback(() => {
    const { source, chartRecordId, projectId, sessionId, exchangeId } = activeRun.current
    if (!source) return

    source.close()

    if (chartRecordId !== null) {
      useResultsStore.getState().removeChartRecord(chartRecordId)
    }
    if (projectId && sessionId && exchangeId !== null) {
      useChatStore.getState().setStatus(projectId, sessionId, exchangeId, 'done')
    }

    clearActiveRun()
  }, [])

  // ── Core stream launcher — shared by submit and continueAfterNullHandling ──
  const _startStream = useCallback((
    query: string,
    projectId: string,
    sessionId: string,
    exchangeId: number,
    chartRecordId: number,
    nullConfig?: NullHandlingConfig,
  ) => {
    let url = `/api/analyze/stream?project_id=${encodeURIComponent(projectId)}&query=${encodeURIComponent(query)}`
    if (nullConfig && Object.keys(nullConfig).length > 0) {
      url += `&null_handling_config=${encodeURIComponent(JSON.stringify(nullConfig))}`
    }

    const eventSource = new EventSource(url)
    activeRun.current.source = eventSource

    eventSource.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data)
        useChatStore.getState().updateTrace(projectId, sessionId, exchangeId, data.steps)
      } catch {}
    })

    // result events during pipeline — only update chat display, NOT resultsStore
    eventSource.addEventListener('result', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'sql' && data.steps) {
          useChatStore.getState().addSqlSteps(projectId, sessionId, exchangeId, data.steps)
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
        useChatStore.getState().setReply(projectId, sessionId, exchangeId, conclusion)
        useChatStore.getState().setStatus(projectId, sessionId, exchangeId, 'done')

        // Surface null handling annotation if present
        const nullNote = data.report?.null_handling_note
        if (nullNote) {
          useChatStore.getState().setNullHandlingNote(projectId, sessionId, exchangeId, nullNote)
        }

        // ── Dataset versions snapshot from this analysis run ──
        const datasetVersions: Record<string, string> = data.dataset_versions || {}

        // ── Finalize chart record ──
        const viz = data.viz_result
        if (viz && viz.series) {
          useResultsStore.getState().finalizeChartRecord(chartRecordId, {
            requestId: chartRecordId,
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
            datasetVersions,
          })
        } else {
          useResultsStore.getState().removeChartRecord(chartRecordId)
        }

        // ── Add SQL to SQL Tab ──
        const sqlResult = data.sql_result
        if (sqlResult?.steps?.length) {
          useResultsStore.getState().addSqlRecord({
            id: 0,
            query,
            steps: sqlResult.steps,
            status: 'done',
            datasetVersions,
          })
        }

        // ── Add report record ──
        if (data.report?.should_record) {
          const now = new Date()
          const time =
            now.getHours().toString().padStart(2, '0') +
            ':' +
            now.getMinutes().toString().padStart(2, '0')

          let chartData = null
          if (viz && viz.series) {
            chartData = {
              id: 0,
              requestId: chartRecordId,
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
              datasetVersions,
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
            datasetVersions,
          })
        }
      } catch {
        useChatStore.getState().setStatus(projectId, sessionId, exchangeId, 'done')
        useResultsStore.getState().removeChartRecord(chartRecordId)
      }
      eventSource.close()
      if (activeRun.current.exchangeId === exchangeId) {
        clearActiveRun()
      }
    })

    eventSource.addEventListener('error', (e) => {
      if (e instanceof MessageEvent) {
        try {
          const data = JSON.parse(e.data)
          useChatStore.getState().setError(
            projectId,
            sessionId,
            exchangeId,
            data.message || 'Analysis failed',
          )
        } catch {
          useChatStore.getState().setError(projectId, sessionId, exchangeId, 'Analysis failed')
        }
      } else {
        useChatStore.getState().setError(projectId, sessionId, exchangeId, 'Connection lost')
      }
      useResultsStore.getState().removeChartRecord(chartRecordId)
      eventSource.close()
      if (activeRun.current.exchangeId === exchangeId) {
        clearActiveRun()
      }
    })
  }, [stop])

  // ── continueAfterNullHandling — called when user confirms NullHandlingCard ──
  const continueAfterNullHandling = useCallback(
    async (
      query: string,
      projectId: string,
      sessionId: string,
      exchangeId: number,
      config: NullHandlingConfig,
      saveToFuture: boolean,
    ) => {
      // Persist preferences if requested
      if (saveToFuture && Object.keys(config).length > 0) {
        try {
          await fetch(`/api/projects/${encodeURIComponent(projectId)}/null-prefs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config }),
          })
        } catch {
          /* non-critical — ignore */
        }
      }

      // Transition exchange: awaiting_null_handling → pending
      useChatStore.getState().setStatus(projectId, sessionId, exchangeId, 'pending')

      const chartRecordId = useResultsStore.getState().startChartRecord(query)
      activeRun.current.chartRecordId = chartRecordId
      activeRun.current.projectId = projectId
      activeRun.current.sessionId = sessionId
      activeRun.current.exchangeId = exchangeId

      _startStream(query, projectId, sessionId, exchangeId, chartRecordId, config)
    },
    [_startStream],
  )

  // ── submit — entry point from user typing in ChatPanel ──
  const submit = useCallback(
    async (query: string, projectId: string) => {
      if (activeRun.current.source) {
        stop()
      }

      const { exchangeId, sessionId } = useChatStore.getState().addExchange(projectId, query)

      // Pre-flight: detect sparse columns (fast schema scan, no LLM)
      try {
        const pf = await fetch(
          `/api/analyze/preflight?project_id=${encodeURIComponent(projectId)}&query=${encodeURIComponent(query)}`,
        )
        if (pf.ok) {
          const pfData = await pf.json()
          const warnings: NullHandlingWarning[] = pfData?.data?.warnings ?? []
          if (warnings.length > 0) {
            // If every affected column already has a saved preference, apply silently without dialog.
            const allSaved = warnings.every((w) => w.saved_preference != null)
            if (allSaved) {
              const autoConfig: NullHandlingConfig = {}
              for (const w of warnings) autoConfig[w.column] = w.saved_preference!
              const chartRecordId = useResultsStore.getState().startChartRecord(query)
              activeRun.current.chartRecordId = chartRecordId
              activeRun.current.projectId = projectId
              activeRun.current.sessionId = sessionId
              activeRun.current.exchangeId = exchangeId
              _startStream(query, projectId, sessionId, exchangeId, chartRecordId, autoConfig)
              return
            }
            // Some columns have no saved preference — show the dialog (saved prefs are pre-selected).
            useChatStore.getState().setNullHandlingPending(projectId, sessionId, exchangeId, warnings)
            activeRun.current.projectId = projectId
            activeRun.current.sessionId = sessionId
            activeRun.current.exchangeId = exchangeId
            return
          }
        }
      } catch {
        /* preflight failure is non-fatal — proceed without dialog */
      }

      // No warnings → start stream immediately
      const chartRecordId = useResultsStore.getState().startChartRecord(query)
      activeRun.current.chartRecordId = chartRecordId
      activeRun.current.projectId = projectId
      activeRun.current.sessionId = sessionId
      activeRun.current.exchangeId = exchangeId

      _startStream(query, projectId, sessionId, exchangeId, chartRecordId)
    },
    [stop, _startStream],
  )

  return { submit, stop, continueAfterNullHandling }
}
