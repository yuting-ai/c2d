/**
 * DataGrid — sortable, selectable, inline-editable data table.
 *
 * Features
 * --------
 * - Click column header → sort (asc → desc → asc)
 * - Click column header while holding Shift → select/deselect column (max 2)
 * - Double-click cell → inline edit (text input, Enter/Escape to commit/cancel)
 * - Footer: row count, selected columns, load-more button
 */

import { useState, useRef, useCallback } from 'react'
import { useDatasetStore, type PreviewData } from '../../../stores/datasetStore'

// ─── Type helpers ─────────────────────────────────────────────

function isNumericType(type: string): boolean {
  const t = type.toUpperCase()
  return ['DOUBLE', 'FLOAT', 'INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC', 'REAL', 'HUGEINT', 'SMALLINT', 'TINYINT'].some((k) => t.startsWith(k))
}

function isDateType(type: string): boolean {
  const t = type.toUpperCase()
  return ['DATE', 'TIMESTAMP', 'TIME'].some((k) => t.startsWith(k))
}

function cellColor(type: string, isNull: boolean): string {
  if (isNull) return 'var(--text3)'
  if (isNumericType(type)) return 'var(--green)'
  if (isDateType(type)) return '#3a9ff5'
  return 'var(--text2)'
}

function formatCell(value: any, type: string): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' && isNumericType(type)) {
    return value.toLocaleString()
  }
  return String(value)
}

// ─── Inline editor ────────────────────────────────────────────

interface EditingCell { rowIndex: number; colName: string; initVal: string }

// ─── Props ────────────────────────────────────────────────────

interface DataGridProps {
  projectId: string
  datasetId: string
  preview: PreviewData
  selectedCols: Set<string>
  sortCol: string
  sortDir: 'asc' | 'desc'
}

// ─── Component ────────────────────────────────────────────────

export default function DataGrid({
  projectId,
  datasetId,
  preview,
  selectedCols,
  sortCol,
  sortDir,
}: DataGridProps) {
  const setSort    = useDatasetStore((s) => s.setSort)
  const toggleCol  = useDatasetStore((s) => s.toggleCol)
  const applyEdit  = useDatasetStore((s) => s.applyEdit)
  const loadMore   = useDatasetStore((s) => s.loadMore)
  const loading    = useDatasetStore((s) => s.loading[datasetId] ?? false)

  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [editVal, setEditVal]  = useState('')
  const inputRef               = useRef<HTMLInputElement>(null)

  // ── Header click handler ────────────────────────────────────
  const handleHeaderClick = useCallback(
    (e: React.MouseEvent, colName: string) => {
      if (e.shiftKey) {
        toggleCol(datasetId, colName)
      } else {
        setSort(projectId, datasetId, colName)
      }
    },
    [projectId, datasetId, setSort, toggleCol]
  )

  // ── Cell double-click → enter edit mode ────────────────────
  const startEdit = useCallback((rowIndex: number, colName: string, raw: any) => {
    const init = raw === null || raw === undefined ? '' : String(raw)
    setEditing({ rowIndex, colName, initVal: init })
    setEditVal(init)
    // Focus the input on next tick
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  // ── Commit / cancel edit ───────────────────────────────────
  const commitEdit = useCallback(() => {
    if (!editing) return
    const { rowIndex, colName, initVal } = editing
    if (editVal !== initVal) {
      // null if user cleared the field
      const finalVal = editVal.trim() === '' ? null : editVal
      applyEdit(projectId, datasetId, rowIndex, colName, finalVal)
    }
    setEditing(null)
  }, [editing, editVal, applyEdit, projectId, datasetId])

  const cancelEdit = useCallback(() => setEditing(null), [])

  const hasMore = preview.rows.length < preview.total

  // ── Render ─────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>

      {/* Scrollable table area */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
        className="dg-scroll"
      >
        <table style={{
          width: 'max-content', minWidth: '100%',
          borderCollapse: 'collapse',
          fontFamily: 'var(--mono)', fontSize: 11,
        }}>
          <thead>
            <tr>
              {/* Row-number header */}
              <th style={RNH_STYLE}>#</th>

              {preview.columns.map((col) => {
                const colType = preview.colTypes[col] || ''
                const isSorted = sortCol === col
                const isSelected = selectedCols.has(col)
                return (
                  <th key={col} style={{ position: 'sticky', top: 0, zIndex: 5,
                    background: isSelected ? 'rgba(62,255,160,0.06)' : 'var(--bg2)',
                    padding: 0,
                    borderBottom: '1px solid var(--border)',
                    fontWeight: 500, textAlign: 'left', userSelect: 'none',
                  }}>
                    <div
                      onClick={(e) => handleHeaderClick(e, col)}
                      title={isSelected ? 'Shift+click to deselect · click to sort' : 'Shift+click to select · click to sort'}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        padding: '7px 12px', cursor: 'pointer',
                        transition: 'background .12s',
                        minWidth: 100,
                      }}
                      onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg3)' }}
                      onMouseOut={(e) => { e.currentTarget.style.background = '' }}
                    >
                      <span style={{ color: isSelected ? 'var(--green)' : 'var(--text2)', whiteSpace: 'nowrap' }}>
                        {col}
                      </span>
                      <span style={{
                        fontSize: 9, color: 'var(--text3)', padding: '1px 4px',
                        borderRadius: 3, background: 'var(--bg0)',
                        border: '1px solid var(--border)',
                      }}>
                        {colType}
                      </span>
                      <span style={{
                        fontSize: 8, color: isSorted ? 'var(--green)' : 'var(--text3)',
                        marginLeft: 'auto', opacity: isSorted ? 1 : 0,
                        transition: 'opacity .12s',
                      }}>
                        {isSorted ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {preview.rows.map((row, ri) => (
              <tr key={ri}
                style={{ transition: 'background .06s' }}
                onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
                onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
              >
                {/* Row number */}
                <td style={RN_STYLE}>{ri + 1}</td>

                {preview.columns.map((col, ci) => {
                  const colType  = preview.colTypes[col] || ''
                  const raw      = row[ci]
                  const isNull   = raw === null || raw === undefined
                  const isEdit   = editing?.rowIndex === ri && editing?.colName === col
                  const isSel    = selectedCols.has(col)

                  return (
                    <td
                      key={col}
                      onDoubleClick={() => startEdit(ri, col, raw)}
                      style={{
                        padding: isEdit ? '2px 8px' : '4px 12px',
                        borderBottom: '1px solid var(--border)',
                        color: isNull ? 'var(--text3)' : cellColor(colType, false),
                        fontStyle: isNull ? 'italic' : 'normal',
                        whiteSpace: 'nowrap',
                        maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis',
                        textAlign: isNumericType(colType) ? 'right' : 'left',
                        background: isSel ? 'rgba(62,255,160,0.03)' : undefined,
                        cursor: 'text',
                      }}
                    >
                      {isEdit ? (
                        <input
                          ref={inputRef}
                          value={editVal}
                          onChange={(e) => setEditVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit()
                            if (e.key === 'Escape') cancelEdit()
                          }}
                          onBlur={commitEdit}
                          style={{
                            width: 120, fontFamily: 'var(--mono)', fontSize: 11,
                            background: 'var(--bg3)',
                            border: '1px solid var(--green)',
                            borderRadius: 3, color: 'var(--text1)',
                            padding: '1px 5px', outline: 'none',
                          }}
                        />
                      ) : (
                        formatCell(raw, colType)
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div style={{
        height: 26, minHeight: 26, flexShrink: 0,
        background: 'var(--bg2)', borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center',
        padding: '0 14px', gap: 14,
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)',
      }}>
        <span>rows: <span style={{ color: 'var(--green)' }}>{preview.total.toLocaleString()}</span></span>
        <span>cols: <span style={{ color: 'var(--text2)' }}>{preview.columns.length}</span></span>
        {selectedCols.size > 0 && (
          <span>selected: <span style={{ color: 'var(--green)' }}>{[...selectedCols].join(', ')}</span></span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          showing: <span style={{ color: 'var(--text2)' }}>{preview.rows.length} of {preview.total.toLocaleString()}</span>
        </span>
        {hasMore && (
          <button
            onClick={() => loadMore(projectId, datasetId)}
            disabled={loading}
            style={{
              fontFamily: 'var(--mono)', fontSize: 10,
              padding: '2px 8px', borderRadius: 4,
              border: '1px solid var(--border2)',
              background: 'var(--bg3)', color: 'var(--text3)',
              cursor: loading ? 'default' : 'pointer',
              transition: 'all .15s',
            }}
            onMouseOver={(e) => {
              if (!loading) {
                e.currentTarget.style.borderColor = 'var(--green)'
                e.currentTarget.style.color = 'var(--green)'
              }
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = 'var(--border2)'
              e.currentTarget.style.color = 'var(--text3)'
            }}
          >
            {loading ? 'loading…' : '+ load more'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Shared cell styles ────────────────────────────────────────

const RNH_STYLE: React.CSSProperties = {
  position: 'sticky', left: 0, top: 0, zIndex: 6,
  background: 'var(--bg2)',
  minWidth: 38,
  borderRight: '1px solid var(--border)',
  borderBottom: '1px solid var(--border)',
  fontSize: 9, color: 'var(--text3)', textAlign: 'center',
  padding: '7px 4px',
  fontWeight: 400,
}

const RN_STYLE: React.CSSProperties = {
  position: 'sticky', left: 0, zIndex: 3,
  background: 'var(--bg2)', color: 'var(--text3)',
  fontSize: 9, padding: '4px 8px', textAlign: 'right',
  minWidth: 38, borderRight: '1px solid var(--border)',
  borderBottom: '1px solid var(--border)',
  userSelect: 'none',
}
