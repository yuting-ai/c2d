import { useState, useRef, useEffect } from 'react'
import { useChatStore, type Exchange, type TraceStep } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSchemaStore } from '../../stores/schemaStore'
import { useUIStore } from '../../stores/uiStore'
import { useAnalysisStream } from '../../hooks/useAnalysisStream'
import { ChatMarkdown } from './ChatMarkdown'
import { NullHandlingCard, type NullHandlingConfig } from './NullHandlingCard'
import '../../styles/chat.css'

const EMPTY_EXCHANGES: Exchange[] = []

export default function ChatPanel() {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeSessionId = useChatStore((s) => (activeProjectId ? s.activeSessionIdByProject[activeProjectId] || null : null))
  const exchanges = useChatStore((s) => {
    if (!activeProjectId) return EMPTY_EXCHANGES
    const sessions = s.sessionsByProject[activeProjectId] || []
    const active = sessions.find((sess) => sess.id === activeSessionId) || sessions[0]
    return active?.exchanges || EMPTY_EXCHANGES
  })
  const sessionTitle = useChatStore((s) => {
    if (!activeProjectId) return 'No active session'
    const sessions = s.sessionsByProject[activeProjectId] || []
    const active = sessions.find((sess) => sess.id === activeSessionId) || sessions[0]
    return active?.title || 'Untitled session'
  })
  const systemMode = useSchemaStore((s) => s.systemMode)
  const toggleChatDrawer = useUIStore((s) => s.toggleChatDrawer)
  const { submit, stop, continueAfterNullHandling } = useAnalysisStream()
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')

  const isStreaming = exchanges.some(
    (ex) => ex.status === 'pending' || ex.status === 'streaming',
  )
  const isAwaitingNullHandling = exchanges.some((ex) => ex.status === 'awaiting_null_handling')
  const canSubmit = systemMode === 'chat' && activeProjectId && input.trim() && !isAwaitingNullHandling

  const trySubmit = (query: string, projectId: string) => {
    const normalized = query.trim()
    if (!normalized) return
    submit(normalized, projectId)
  }

  const handleSend = () => {
    if (!canSubmit) return
    trySubmit(input.trim(), activeProjectId!)
    setInput('')
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
    }
  }

  const handleStop = () => {
    stop()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const resizeTextarea = () => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }

  useEffect(() => {
    resizeTextarea()
  }, [input])

  // Auto-scroll to bottom
  const lastEx = exchanges[exchanges.length - 1]
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [exchanges.length, lastEx?.trace, lastEx?.reply, lastEx?.status])

  // Listen for quick-chart queries dispatched by DatasetTab column selection
  useEffect(() => {
    const handler = (e: Event) => {
      const { query, projectId } = (e as CustomEvent<{ query: string; projectId: string }>).detail
      if (query && projectId) {
        trySubmit(query, projectId)
      }
    }
    window.addEventListener('c2d:send-query', handler)
    return () => window.removeEventListener('c2d:send-query', handler)
  }, [submit])

  return (
    <div className="chat-panel">
      <div className="chat-drawer-header">
        <div className="chat-drawer-title">{sessionTitle}</div>
        <button className="chat-drawer-close" onClick={toggleChatDrawer} title="Collapse chat">
          ✕
        </button>
      </div>

      <div className="chat-messages" ref={messagesRef}>
        {exchanges.length === 0 && (
          <div className="placeholder">
            <div className="placeholder-icon">💬</div>
            <div className="placeholder-title">start analyzing</div>
            <div className="placeholder-desc">
              {systemMode !== 'chat'
                ? 'Upload a dataset and confirm data decisions first.'
                : 'Ask a question about your data.'}
            </div>
          </div>
        )}

        {exchanges.map((ex) => (
          <ConversationTurn
            key={ex.id}
            exchange={ex}
            projectId={activeProjectId ?? ''}
            onRetry={(query) => {
              if (activeProjectId) trySubmit(query, activeProjectId)
            }}
            onNullHandlingConfirm={(exchangeId, sessionId, config, saveToFuture) => {
              if (activeProjectId) {
                continueAfterNullHandling(ex.query, activeProjectId, sessionId, exchangeId, config, saveToFuture)
              }
            }}
          />
        ))}
      </div>

      <div className="input-area">
        {systemMode === 'chat' && exchanges.length === 0 && (
          <div className="chat-hints">
            {[
              'Why did Southwest decline?',
              'Forecast Q1 2025 revenue',
              'Compare to same period last year',
              'Export current report',
            ].map((hint) => (
              <HintChip
                key={hint}
                text={hint}
                onClick={() => {
                  setInput(hint)
                  textareaRef.current?.focus()
                }}
              />
            ))}
          </div>
        )}

        <div className="input-row">
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={
              systemMode !== 'chat'
                ? 'Confirm data decisions to start analyzing…'
                : 'Ask a follow-up question, or upload a new dataset to start...'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={systemMode !== 'chat'}
            className="chat-textarea"
          />
          <button
            className={`send-btn ${isStreaming ? 'stop-btn' : ''}`}
            onClick={isStreaming ? handleStop : handleSend}
            disabled={isStreaming ? false : !canSubmit}
            title={isStreaming ? 'Stop' : 'Send'}
            aria-label={isStreaming ? 'Stop generation' : 'Send message'}
          >
            {isStreaming ? (
              <svg viewBox="0 0 14 14"><rect x="4" y="4" width="6" height="6" rx="1" /></svg>
            ) : (
              <svg viewBox="0 0 14 14"><path d="M7 12V3M7 3l-4 4M7 3l4 4" /></svg>
            )}
          </button>
        </div>
      </div>

    </div>
  )
}


// ── Conversation Turn ──

function ConversationTurn({
  exchange: ex,
  projectId,
  onRetry,
  onNullHandlingConfirm,
}: {
  exchange: Exchange
  projectId: string
  onRetry: (query: string) => void
  onNullHandlingConfirm: (
    exchangeId: number,
    sessionId: string,
    config: NullHandlingConfig,
    saveToFuture: boolean,
  ) => void
}) {
  const isDone = ex.status === 'done' || ex.status === 'error'
  const isWorking = ex.status === 'pending' || ex.status === 'streaming'
  const isAwaitingNull = ex.status === 'awaiting_null_handling'
  const [sqlOpen, setSqlOpen] = useState(false)

  // Grab the session ID for this exchange from the store
  const sessionId = useChatStore((s) => {
    for (const sessions of Object.values(s.sessionsByProject)) {
      for (const sess of sessions) {
        if (sess.exchanges.some((e) => e.id === ex.id)) return sess.id
      }
    }
    return ''
  })

  return (
    <>
      {/* User */}
      <div className="msg-user">
        <div className="msg-user-bubble">{ex.query}</div>
      </div>

      {/* Analyst */}
      <div className="msg-analyst">
        <div className="analyst-content">
          {/* NULL handling card — shown before stream starts */}
          {isAwaitingNull && ex.nullHandlingWarnings && (
            <NullHandlingCard
              warnings={ex.nullHandlingWarnings}
              onConfirm={(config, saveToFuture) =>
                onNullHandlingConfirm(ex.id, sessionId, config, saveToFuture)
              }
            />
          )}

          {/* Thinking block */}
          {!isAwaitingNull && ex.trace ? (
            <ThinkingBlock steps={ex.trace} collapsed={isDone} isWorking={isWorking && !ex.reply} />
          ) : !isAwaitingNull && isWorking ? (
            <div className="typing-dots"><span /><span /><span /></div>
          ) : null}

          {/* Reply */}
          {ex.reply && (
            <div className="analyst-reply">
              <ChatMarkdown text={ex.reply} />
            </div>
          )}

          {/* NULL handling annotation */}
          {ex.nullHandlingNote && (
            <div className="null-handling-note">{ex.nullHandlingNote}</div>
          )}

          {/* Error */}
          {ex.error && <div className="analyst-error">{ex.error}</div>}

          {/* Action bar: SQL | Retry | Copy */}
          {isDone && (ex.reply || ex.sqlSteps.length > 0) && (
            <div className="reply-actions">
              {ex.sqlSteps.length > 0 && (
                <button className="reply-action-btn" onClick={() => setSqlOpen(!sqlOpen)} title={`View SQL (${ex.sqlSteps.length})`}>
                  <svg viewBox="0 0 16 16"><path d="M4.5 3h7a1.5 1.5 0 011.5 1.5v7a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 11.5v-7A1.5 1.5 0 014.5 3z" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M5.5 7l1.5 1.5L5.5 10M8.5 10h2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              )}
              <button className="reply-action-btn" onClick={() => onRetry(ex.query)} title="Retry">
                <svg viewBox="0 0 20 20"><path d="M4.5 9a4.5 4.5 0 017.6-3.25M13.5 9a4.5 4.5 0 01-7.6 3.25" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/><path d="M12.2 3.5v2.4h-2.4M5.8 12.1v2.4h2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {ex.reply && (
                <CopyActionButton text={ex.reply} />
              )}
            </div>
          )}

          {/* SQL expanded */}
          {sqlOpen && ex.sqlSteps.length > 0 && (
            <SqlPreviewGroup steps={ex.sqlSteps} />
          )}
        </div>
      </div>
    </>
  )
}


// ── Thinking Block (trace) ──

function ThinkingBlock({
  steps,
  collapsed: shouldCollapse,
  isWorking,
}: {
  steps: TraceStep[]
  collapsed: boolean
  isWorking: boolean
}) {
  const [userCollapsed, setUserCollapsed] = useState(false)
  const collapsed = shouldCollapse && (userCollapsed || shouldCollapse)
  const doneCount = steps.filter((s) => s.status === 'done').length

  // Auto-collapse when finished
  useEffect(() => {
    if (shouldCollapse) {
      const t = setTimeout(() => setUserCollapsed(true), 600)
      return () => clearTimeout(t)
    }
  }, [shouldCollapse])

  if (userCollapsed && shouldCollapse) {
    return (
      <div className="thinking-block collapsed" onClick={() => setUserCollapsed(false)}>
        <div className="thinking-summary">
          <span className="thinking-summary-icon">✓</span>
          {doneCount} {doneCount === 1 ? 'step' : 'steps'} completed
        </div>
      </div>
    )
  }

  // When working, promote the first "waiting" step to "active" so
  // the blinking dot shows during gaps between agent progress events.
  const hasActive = isWorking && steps.some((s) => s.status === 'active')
  let promotedFirst = false
  const displaySteps = isWorking ? steps.slice(-3) : steps

  return (
    <div
      className={`thinking-block ${isWorking ? 'active' : ''}`}
      onClick={shouldCollapse ? () => setUserCollapsed(true) : undefined}
      style={shouldCollapse ? { cursor: 'pointer' } : undefined}
    >
      {displaySteps.map((s, i) => {
        let displayStatus = s.status
        if (isWorking && !hasActive && !promotedFirst && s.status === 'waiting') {
          displayStatus = 'active'
          promotedFirst = true
        }
        const label = displayStatus === 'active' ? `running · ${s.label}` : s.label
        return (
          <div key={i} className={`thinking-step ${displayStatus}`}>
            <span className={`step-dot ${displayStatus}`} />
            <span className="step-text">{label}</span>
          </div>
        )
      })}
    </div>
  )
}


// ── SQL Preview Group ──

function SqlPreviewGroup({ steps }: { steps: any[] }) {
  return (
    <>
      {steps.map((step, i) => (
        <div key={i} className="sql-block">
          <div className="sql-block-header">
            <span>{step.title || `query ${i + 1}`}</span>
            <CopyMiniButton text={step.sql || ''} label="copy sql" />
          </div>
          <div className="sql-block-code">{step.sql}</div>
        </div>
      ))}
    </>
  )
}

async function copyToClipboard(text: string): Promise<boolean> {
  const value = String(text || '')
  if (!value.trim()) return false

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {}

  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', 'true')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CopyMiniButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1100)
  }

  return (
    <button className={`copy-mini-btn ${copied ? 'copied' : ''}`} onClick={onCopy} title={label} aria-label={label}>
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

function CopyActionButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1100)
  }

  return (
    <button className={`reply-action-btn ${copied ? 'copied' : ''}`} onClick={onCopy} title={copied ? 'Copied' : 'Copy'}>
      {copied ? (
        <svg viewBox="0 0 16 16"><path d="M4 8.5l2.5 2.5L12 5" fill="none" stroke="var(--green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg viewBox="0 0 16 16"><rect x="5" y="5" width="7.5" height="7.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M5 10.5h-1.5a1.2 1.2 0 01-1.2-1.2V3.7a1.2 1.2 0 011.2-1.2h5.6a1.2 1.2 0 011.2 1.2V5" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
      )}
    </button>
  )
}


// ── Hint Chip ──

function HintChip({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      className="chat-hint-chip"
      onClick={onClick}
    >
      {text}
    </button>
  )
}

