import { useState } from 'react'
import SchemaPanel from '../schema/SchemaPanel'
import { useSchemaStore } from '../../stores/schemaStore'

export default function MainColumn() {
  const systemMode = useSchemaStore((s) => s.systemMode)

  // empty: show schema panel (upload zone) + chat (placeholder)
  // clean: schema panel takes over, no chat
  // chat: collapsed schema header + full chat
  const showChat = systemMode === 'empty' || systemMode === 'chat'

  return (
    <div className="main-column">
      <SchemaPanel />
      {showChat && <ChatPanel />}
    </div>
  )
}

function ChatPanel() {
  const [input, setInput] = useState('')

  const handleSend = () => {
    if (!input.trim()) return
    // Phase 3: will connect to useAnalysisStream
    console.log('Send:', input)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        <div className="placeholder">
          <div className="placeholder-icon">💬</div>
          <div className="placeholder-title">start analyzing</div>
          <div className="placeholder-desc">
            Upload a dataset, confirm data decisions, then ask a question.
          </div>
        </div>
      </div>

      <div className="input-area">
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {['Monthly revenue trend by region?', 'Which product has the highest margin?', 'Compare online vs offline sales'].map((hint) => (
            <button
              key={hint}
              onClick={() => setInput(hint)}
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
              {hint}
            </button>
          ))}
        </div>

        <div className="input-row">
          <input
            type="text"
            placeholder="Ask a follow-up question, or upload a new dataset to start…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="send-btn" onClick={handleSend}>
            <svg viewBox="0 0 14 14"><path d="M2 7h10M7 2l5 5-5 5" /></svg>
          </button>
        </div>
      </div>
    </div>
  )
}