import { useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NullHandlingOption {
  method: string
  label: string
  impact: string
}

export interface NullHandlingWarning {
  column: string
  table: string
  sparsity_rate: number
  column_type: string
  recommended: string
  recommended_reason: string
  options: NullHandlingOption[]
  saved_preference?: string
}

export interface NullHandlingConfig {
  [column: string]: string
}

interface NullHandlingCardProps {
  warnings: NullHandlingWarning[]
  onConfirm: (config: NullHandlingConfig, saveToFuture: boolean) => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NullHandlingCard({ warnings, onConfirm }: NullHandlingCardProps) {
  // Initialize selections: prefer saved_preference, fall back to recommended
  const [selections, setSelections] = useState<NullHandlingConfig>(() => {
    const init: NullHandlingConfig = {}
    for (const w of warnings) {
      init[w.column] = w.saved_preference ?? w.recommended
    }
    return init
  })
  const [saveToFuture, setSaveToFuture] = useState(false)
  const [expandedCol, setExpandedCol] = useState<string | null>(
    warnings.length === 1 ? warnings[0].column : null
  )

  const handleSelect = (col: string, method: string) => {
    setSelections((prev) => ({ ...prev, [col]: method }))
  }

  const handleConfirm = () => {
    onConfirm(selections, saveToFuture)
  }

  const handleUseDefaults = () => {
    const defaults: NullHandlingConfig = {}
    for (const w of warnings) {
      defaults[w.column] = w.recommended
    }
    onConfirm(defaults, false)
  }

  return (
    <div className="null-card">
      <div className="null-card-header">
        <span className="null-card-icon">⚠</span>
        <div>
          <div className="null-card-title">Data Quality Notice</div>
          <div className="null-card-subtitle">
            {warnings.length === 1
              ? `1 column with significant missing values detected.`
              : `${warnings.length} columns with significant missing values detected.`}
            {' '}Choose how to handle them before running the analysis.
          </div>
        </div>
      </div>

      <div className="null-card-columns">
        {warnings.map((w) => {
          const selected = selections[w.column] ?? w.recommended
          const isExpanded = expandedCol === w.column

          return (
            <div key={w.column} className="null-col-group">
              {/* Column header row — click to expand/collapse */}
              <button
                className="null-col-header"
                onClick={() => setExpandedCol(isExpanded ? null : w.column)}
                aria-expanded={isExpanded}
              >
                <div className="null-col-meta">
                  <span className="null-col-name">{w.column}</span>
                  <span className="null-col-pct">{Math.round(w.sparsity_rate * 100)}% missing</span>
                </div>
                <div className="null-col-right">
                  <span className="null-col-selected-label">{labelForMethod(selected)}</span>
                  <svg
                    className={`null-col-chevron ${isExpanded ? 'open' : ''}`}
                    viewBox="0 0 10 6"
                  >
                    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </button>

              {/* Recommended reason */}
              {isExpanded && (
                <div className="null-col-body">
                  <div className="null-col-reason">{w.recommended_reason}</div>

                  <div className="null-options">
                    {w.options.map((opt) => {
                      const isSelected = selected === opt.method
                      const isRecommended = opt.method === w.recommended

                      return (
                        <label
                          key={opt.method}
                          className={`null-option ${isSelected ? 'selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name={`null-${w.column}`}
                            value={opt.method}
                            checked={isSelected}
                            onChange={() => handleSelect(w.column, opt.method)}
                          />
                          <div className="null-option-content">
                            <div className="null-option-top">
                              <span className="null-option-label">{opt.label}</span>
                              {isRecommended && (
                                <span className="null-option-badge">Recommended</span>
                              )}
                            </div>
                            <div className="null-option-impact">{opt.impact}</div>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="null-card-footer">
        <label className="null-save-toggle">
          <input
            type="checkbox"
            checked={saveToFuture}
            onChange={(e) => setSaveToFuture(e.target.checked)}
          />
          <span>Apply these choices to all future analyses for this dataset</span>
        </label>

        <div className="null-card-actions">
          <button className="null-btn-ghost" onClick={handleUseDefaults}>
            Use recommended defaults
          </button>
          <button className="null-btn-primary" onClick={handleConfirm}>
            Start Analysis
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function labelForMethod(method: string): string {
  switch (method) {
    case 'median':    return 'Median fill'
    case 'mean':      return 'Mean fill'
    case 'keep_null': return 'Keep NULL'
    case 'exclude':   return 'Exclude column'
    default:          return method
  }
}
