import { useState, useRef, useEffect } from 'react'
import { useChatStore, type Exchange, type TraceStep } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSchemaStore } from '../../stores/schemaStore'
import { useAnalysisStream } from '../../hooks/useAnalysisStream'
import '../../styles/chat.css'

export default function ChatPanel() {
  const exchanges = useChatStore((s) => s.exchanges)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const systemMode = useSchemaStore((s) => s.systemMode)
  const { submit } = useAnalysisStream()
  const messagesRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')

  const canSubmit = systemMode === 'chat' && activeProjectId && input.trim()

  const handleSend = () => {
    if (!canSubmit) return
    submit(input.trim(), activeProjectId!)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Auto-scroll to bottom
  const lastEx = exchanges[exchanges.length - 1]
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [exchanges.length, lastEx?.trace, lastEx?.reply, lastEx?.status])

  return (
    <div className="chat-panel">
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
          <ConversationTurn key={ex.id} exchange={ex} />
        ))}
      </div>

      <div className="input-area">
        {exchanges.length === 0 && systemMode === 'chat' && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {[
              'What is this dataset about?',
              'Top 10 rows by sales',
              'Show summary statistics',
            ].map((hint) => (
              <HintChip key={hint} text={hint} onClick={() => setInput(hint)} />
            ))}
          </div>
        )}

        <div className="input-row">
          <input
            type="text"
            placeholder={
              systemMode !== 'chat'
                ? 'Confirm data decisions to start analyzing…'
                : 'Ask a question about your data…'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={systemMode !== 'chat'}
          />
          <button className="send-btn" onClick={handleSend} disabled={!canSubmit}>
            <svg viewBox="0 0 14 14"><path d="M2 7h10M7 2l5 5-5 5" /></svg>
          </button>
        </div>
      </div>
    </div>
  )
}


// ── Conversation Turn ──

function ConversationTurn({ exchange: ex }: { exchange: Exchange }) {
  const isDone = ex.status === 'done' || ex.status === 'error'
  const isWorking = ex.status === 'pending' || ex.status === 'streaming'

  return (
    <>
      {/* User */}
      <div className="msg-user">
        <div className="msg-user-bubble">{ex.query}</div>
      </div>

      {/* Analyst */}
      <div className="msg-analyst">
        <div className="analyst-header">
          <div className="analyst-avatar">A</div>
          <span className="analyst-name">analyst</span>
        </div>

        <div className="analyst-content">
          {/* Thinking block */}
          {ex.trace ? (
            <ThinkingBlock steps={ex.trace} collapsed={isDone} isWorking={isWorking && !ex.reply} />
          ) : isWorking ? (
            <div className="typing-dots"><span /><span /><span /></div>
          ) : null}

          {/* Reply */}
          {ex.reply && <div className="analyst-reply">{ex.reply}</div>}

          {/* SQL */}
          {ex.sqlSteps.length > 0 && isDone && (
            <SqlPreviewGroup steps={ex.sqlSteps} />
          )}

          {/* Error */}
          {ex.error && <div className="analyst-error">{ex.error}</div>}
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

  return (
    <div
      className={`thinking-block ${isWorking ? 'active' : ''}`}
      onClick={shouldCollapse ? () => setUserCollapsed(true) : undefined}
      style={shouldCollapse ? { cursor: 'pointer' } : undefined}
    >
      {steps.map((s, i) => (
        <div key={i} className={`thinking-step ${s.status}`}>
          <span className={`step-icon ${s.status}`}>
            {s.status === 'done' ? '✓' : s.status === 'active' ? '●' : '○'}
          </span>
          <span className="step-text">{s.label}</span>
        </div>
      ))}
      {isWorking && <div className="typing-dots"><span /><span /><span /></div>}
    </div>
  )
}


// ── SQL Preview Group ──

function SqlPreviewGroup({ steps }: { steps: any[] }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div className="sql-toggle" onClick={() => setOpen(!open)}>
        <span className={`sql-toggle-arrow ${open ? 'open' : ''}`}>▶</span>
        <span className="sql-toggle-label">SQL</span>
        <span className="sql-toggle-count">{steps.length}</span>
      </div>

      {open && steps.map((step, i) => (
        <div key={i} className="sql-block">
          <div className="sql-block-header">{step.title || `query ${i + 1}`}</div>
          <div className="sql-block-code">{step.sql}</div>
        </div>
      ))}
    </>
  )
}


// ── Hint Chip ──

function HintChip({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: 'var(--mono)', fontSize: '11px',
        padding: '4px 11px', borderRadius: 20,
        border: '1px solid var(--border2)', background: 'var(--bg0)',
        color: 'var(--text3)', cursor: 'pointer',
        whiteSpace: 'nowrap', transition: 'all 0.15s',
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.borderColor = 'var(--green)'
        e.currentTarget.style.color = 'var(--green)'
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.borderColor = 'var(--border2)'
        e.currentTarget.style.color = 'var(--text3)'
      }}
    >
      {text}
    </button>
  )
}