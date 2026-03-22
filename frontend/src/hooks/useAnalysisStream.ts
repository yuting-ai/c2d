import { useCallback, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'

export function useAnalysisStream() {
  const addExchange = useChatStore((s) => s.addExchange)
  const updateTrace = useChatStore((s) => s.updateTrace)
  const addSqlSteps = useChatStore((s) => s.addSqlSteps)
  const setReply = useChatStore((s) => s.setReply)
  const setStatus = useChatStore((s) => s.setStatus)
  const setError = useChatStore((s) => s.setError)
  const activeSource = useRef<EventSource | null>(null)

  const submit = useCallback((query: string, projectId: string) => {
    // Close previous connection if still open
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

    eventSource.addEventListener('result', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'sql' && data.steps) {
          addSqlSteps(exchangeId, data.steps)
        }
      } catch {}
    })

    eventSource.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data)
        const conclusion = data.report?.conclusion || 'Analysis complete.'
        setReply(exchangeId, conclusion)
        setStatus(exchangeId, 'done')
      } catch {
        setStatus(exchangeId, 'done')
      }
      eventSource.close()
      activeSource.current = null
    })

    eventSource.addEventListener('error', (e) => {
      // SSE error can be connection error or server-sent error event
      if (e instanceof MessageEvent) {
        try {
          const data = JSON.parse(e.data)
          setError(exchangeId, data.message || 'Analysis failed')
        } catch {
          setError(exchangeId, 'Analysis failed')
        }
      } else {
        // Connection error
        setError(exchangeId, 'Connection lost')
      }
      eventSource.close()
      activeSource.current = null
    })
  }, [addExchange, updateTrace, addSqlSteps, setReply, setStatus, setError])

  return { submit }
}