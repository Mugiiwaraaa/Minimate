/* --- SheetGrid.jsx --- Minimate's Excel-grade grid (S1, v0.2) ---
   In-house on @tanstack/react-virtual (both major MIT grids fail React 19).

   v0.2 (Fahad's feel-test feedback, 2026-07-11):
   - text drag-select works inside cell editors
   - fill-drag: default COPY · hold CTRL = SERIES (+1, or step from a
     two-cell source selection) — numbers only
   - column resize: drag header edges (widths live in grid state)
   - row density via rowHeight prop (consumer offers presets)
   - quick insert: Ctrl+Enter row below · Ctrl+Shift+Enter row above ·
     Ctrl+Delete delete selected rows · Ctrl+Shift+K insert column
     (only when onColumnsChange is provided)
   - select-type cells show a ▾ chevron; clicking the active select cell
     opens the dropdown
   ponytail deferred: per-row heights, frozen cols, horizontal fill, redo. */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

const HEADER_H = 34
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const coerce = (col, raw) => {
  if (col.type === 'number') {
    const n = Number(String(raw).replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : 0
  }
  if (col.type === 'checkbox') {
    if (typeof raw === 'boolean') return raw
    const s = String(raw).trim().toUpperCase()
    return s === 'TRUE' || s === 'Y' || s === 'YES' || s === '1' || s === '✓'
  }
  return String(raw ?? '').toUpperCase()
}

const emptyValue = (col) => (col.type === 'checkbox' ? false : col.type === 'number' ? 0 : '')
const emptyRow = (columns) => Object.fromEntries(columns.map((c) => [c.id, emptyValue(c)]))

export default function SheetGrid({ columns, rows, onRowsChange, onColumnsChange, height = 560, rowHeight = 30 }) {
  const scrollRef = useRef(null)
  const gridRef = useRef(null)
  const [sel, setSel] = useState(null)
  const [anchor, setAnchor] = useState(null)
  const [editing, setEditing] = useState(null)
  const [fillTo, setFillTo] = useState(null)
  const [widths, setWidths] = useState(() => columns.map((c) => c.width || 120))
  const [colOver, setColOver] = useState(null)
  const [menu, setMenu] = useState(null)
  const undoRef = useRef([])
  const dragRef = useRef(null) // 'select' | 'fill' | {resize}
  const fillModRef = useRef(false)

  useEffect(() => {
    setWidths((w) => (w.length === columns.length ? w : columns.map((c, i) => w[i] || c.width || 120)))
  }, [columns])

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })
  useEffect(() => { virt.measure() }, [rowHeight]) // density toggle

  const totalW = widths.reduce((s, w) => s + w, 0) + 44

  const commitRows = useCallback(
    (next) => {
      undoRef.current.push(rows)
      if (undoRef.current.length > 50) undoRef.current.shift()
      onRowsChange(next)
    },
    [rows, onRowsChange]
  )

  const range = () => {
    if (!sel) return null
    const a = anchor || sel
    return { r1: Math.min(a.r, sel.r), r2: Math.max(a.r, sel.r), c1: Math.min(a.c, sel.c), c2: Math.max(a.c, sel.c) }
  }

  const setCell = (r, c, raw) => {
    const next = rows.slice()
    next[r] = { ...next[r], [columns[c].id]: coerce(columns[c], raw) }
    commitRows(next)
  }

  const startEdit = (r, c, seed) => {
    const col = columns[c]
    if (col.type === 'checkbox') { setCell(r, c, !rows[r][col.id]); return }
    setEditing({ r, c, value: seed !== undefined ? seed : String(rows[r][col.id] ?? '') })
  }

  const commitEdit = (move) => {
    if (!editing) return
    setCell(editing.r, editing.c, editing.value)
    setEditing(null)
    if (move) moveSel(move.dr, move.dc, false)
  }

  const moveSel = (dr, dc, extend) => {
    setSel((prev) => {
      const base = prev || { r: 0, c: 0 }
      const n = { r: clamp(base.r + dr, 0, rows.length - 1), c: clamp(base.c + dc, 0, columns.length - 1) }
      if (!extend) setAnchor(n)
      virt.scrollToIndex(n.r)
      return n
    })
  }

  // ─── rows / columns quick insert ───────────────────────────
  const insertRow = (at) => {
    const next = rows.slice()
    next.splice(at, 0, emptyRow(columns))
    commitRows(next)
    setSel({ r: at, c: sel ? sel.c : 0 })
    setAnchor({ r: at, c: sel ? sel.c : 0 })
  }

  const deleteRows = () => {
    const rg = range()
    if (!rg) return
    const next = rows.filter((_, i) => i < rg.r1 || i > rg.r2)
    commitRows(next.length ? next : [emptyRow(columns)])
    const r = clamp(rg.r1, 0, Math.max(0, next.length - 1))
    setSel({ r, c: sel.c }); setAnchor({ r, c: sel.c })
  }

  const insertColAt = (at) => {
    if (!onColumnsChange) return
    const id = 'col_' + Date.now()
    const nextCols = columns.slice()
    nextCols.splice(at, 0, { id, title: 'NEW COLUMN', width: 120, type: 'text' })
    setWidths((w) => { const nw = w.slice(); nw.splice(at, 0, 120); return nw })
    onColumnsChange(nextCols)
    commitRows(rows.map((row) => ({ ...row, [id]: '' })))
  }
  const insertColumn = () => { if (sel) insertColAt(sel.c + 1) }
  const deleteColAt = (c) => {
    if (!onColumnsChange || columns.length <= 1) return
    const id = columns[c].id
    setWidths((w) => w.filter((_, i) => i !== c))
    onColumnsChange(columns.filter((_, i) => i !== c))
    commitRows(rows.map((row) => { const n = { ...row }; delete n[id]; return n }))
  }
  const moveColumn = (from, to) => {
    if (!onColumnsChange || to == null || from === to) return
    const nc = columns.slice(); const [m] = nc.splice(from, 1); nc.splice(to, 0, m)
    setWidths((w) => { const nw = w.slice(); const [wm] = nw.splice(from, 1); nw.splice(to, 0, wm); return nw })
    onColumnsChange(nc)
  }

  // ─── clipboard ─────────────────────────────────────────────
  const copyRange = async () => {
    const rg = range()
    if (!rg) return
    const tsv = []
    for (let r = rg.r1; r <= rg.r2; r++) {
      const line = []
      for (let c = rg.c1; c <= rg.c2; c++) line.push(String(rows[r][columns[c].id] ?? ''))
      tsv.push(line.join('\t'))
    }
    try { await navigator.clipboard.writeText(tsv.join('\n')) } catch { /* blocked */ }
  }

  const pasteAt = async () => {
    if (!sel) return
    let text = ''
    try { text = await navigator.clipboard.readText() } catch { return }
    if (!text) return
    const lines = text.replace(/\r/g, '').split('\n').filter((l, i, a) => !(l === '' && i === a.length - 1))
    const next = rows.slice()
    lines.forEach((line, dr) => {
      const r = sel.r + dr
      if (r >= next.length) next.push(emptyRow(columns)) // paste grows the sheet
      const cells = line.split('\t')
      const patch = { ...next[r] }
      cells.forEach((v, dc) => {
        const c = sel.c + dc
        if (c < columns.length) patch[columns[c].id] = coerce(columns[c], v)
      })
      next[r] = patch
    })
    commitRows(next)
    setAnchor(sel)
    setSel({ r: sel.r + lines.length - 1, c: sel.c })
  }

  const clearRange = () => {
    const rg = range()
    if (!rg) return
    const next = rows.slice()
    for (let r = rg.r1; r <= rg.r2; r++) {
      const patch = { ...next[r] }
      for (let c = rg.c1; c <= rg.c2; c++) patch[columns[c].id] = emptyValue(columns[c])
      next[r] = patch
    }
    commitRows(next)
  }

  // ─── fill-drag: COPY by default, CTRL = SERIES ─────────────
  const applyFill = (toRow, series) => {
    const rg = range()
    if (!rg || toRow >= rg.r1 && toRow <= rg.r2) return
    const next = rows.slice()
    const srcLen = rg.r2 - rg.r1 + 1
    const down = toRow > rg.r2
    const targets = down
      ? Array.from({ length: toRow - rg.r2 }, (_, i) => rg.r2 + 1 + i)
      : Array.from({ length: rg.r1 - toRow }, (_, i) => rg.r1 - 1 - i)
    targets.forEach((r, step) => {
      if (r < 0 || r >= next.length) return
      const patch = { ...next[r] }
      for (let c = rg.c1; c <= rg.c2; c++) {
        const col = columns[c]
        const firstN = Number(rows[rg.r1][col.id])
        const numeric = series && String(rows[rg.r1][col.id] ?? '') !== '' && Number.isFinite(firstN)
        if (numeric) {
          const lastN = Number(rows[rg.r2][col.id])
          const last = Number.isFinite(lastN) ? lastN : firstN
          const stride = srcLen > 1 ? (last - firstN) / (srcLen - 1) : 1
          const val = down ? last + stride * (step + 1) : firstN - stride * (step + 1)
          patch[col.id] = col.type === 'number' ? val : String(val)
        } else {
          const src = rows[rg.r1 + (((down ? r : rg.r2 - (rg.r1 - r)) - rg.r1) % srcLen + srcLen) % srcLen]
          patch[col.id] = src[col.id]
        }
      }
      next[r] = patch
    })
    commitRows(next)
    setSel({ r: toRow, c: sel.c })
  }

  // ─── keyboard ──────────────────────────────────────────────
  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (editing) {
      if (e.key === 'Enter' && !mod) { e.preventDefault(); commitEdit({ dr: 1, dc: 0 }) }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit({ dr: 0, dc: e.shiftKey ? -1 : 1 }) }
      else if (e.key === 'Escape') setEditing(null)
      return
    }
    if (!sel) return
    const nav = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
    if (nav) { e.preventDefault(); moveSel(nav[0], nav[1], e.shiftKey); return }
    switch (true) {
      case mod && e.key === 'Enter' && e.shiftKey: e.preventDefault(); insertRow(sel.r); break
      case mod && e.key === 'Enter': e.preventDefault(); insertRow(sel.r + 1); break
      case mod && (e.key === 'Delete' || e.key === 'Backspace'): e.preventDefault(); deleteRows(); break
      case mod && e.shiftKey && e.key.toLowerCase() === 'k': e.preventDefault(); insertColumn(); break
      case e.key === 'Tab': e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1, false); break
      case e.key === 'Enter' || e.key === 'F2': e.preventDefault(); startEdit(sel.r, sel.c); break
      case e.key === 'Home': e.preventDefault(); setSel({ r: sel.r, c: 0 }); setAnchor({ r: sel.r, c: 0 }); break
      case e.key === 'End': e.preventDefault(); setSel({ r: sel.r, c: columns.length - 1 }); setAnchor({ r: sel.r, c: columns.length - 1 }); break
      case e.key === 'PageDown': e.preventDefault(); moveSel(15, 0, e.shiftKey); break
      case e.key === 'PageUp': e.preventDefault(); moveSel(-15, 0, e.shiftKey); break
      case e.key === 'Delete' || e.key === 'Backspace': e.preventDefault(); clearRange(); break
      case mod && e.key.toLowerCase() === 'c': e.preventDefault(); copyRange(); break
      case mod && e.key.toLowerCase() === 'v': e.preventDefault(); pasteAt(); break
      case mod && e.key.toLowerCase() === 'z': {
        e.preventDefault()
        const prev = undoRef.current.pop()
        if (prev) onRowsChange(prev)
        break
      }
      case e.key === ' ' && columns[sel.c].type === 'checkbox': e.preventDefault(); setCell(sel.r, sel.c, !rows[sel.r][columns[sel.c].id]); break
      case e.key.length === 1 && !mod && !e.altKey: startEdit(sel.r, sel.c, e.key); break
      default: break
    }
  }

  // ─── mouse ─────────────────────────────────────────────────
  const cellFromEvent = (e) => {
    const el = e.target.closest('[data-r]')
    return el ? { r: Number(el.dataset.r), c: Number(el.dataset.c) } : null
  }

  const onMouseDown = (e) => {
    if (e.target.closest('input,select')) return // let editors own text selection
    if (e.target.dataset.fill) { dragRef.current = 'fill'; fillModRef.current = e.ctrlKey || e.metaKey; e.preventDefault(); return }
    if (e.target.dataset.resize !== undefined) {
      const c = Number(e.target.dataset.resize)
      dragRef.current = { resize: c, startX: e.clientX, startW: widths[c] }
      e.preventDefault()
      return
    }
    const head = e.target.closest('[data-colhead]')
    if (head) { dragRef.current = { colFrom: Number(head.dataset.colhead) }; e.preventDefault(); return }
    const cell = cellFromEvent(e)
    if (!cell) return
    if (editing) commitEdit(null)
    // clicking the ALREADY-active select cell opens its dropdown
    if (sel && sel.r === cell.r && sel.c === cell.c && columns[cell.c].type === 'select') {
      startEdit(cell.r, cell.c)
      return
    }
    dragRef.current = 'select'
    setSel(cell)
    setAnchor(e.shiftKey && sel ? anchor || sel : cell)
    gridRef.current?.focus()
  }

  const onMouseMove = (e) => {
    const d = dragRef.current
    if (!d) return
    if (d.resize !== undefined) {
      const w = clamp(d.startW + (e.clientX - d.startX), 50, 600)
      setWidths((ws) => ws.map((x, i) => (i === d.resize ? w : x)))
      return
    }
    if (d.colFrom !== undefined) {
      const t = document.elementFromPoint(e.clientX, e.clientY)
      const h = t && t.closest ? t.closest('[data-colhead]') : null
      setColOver(h ? Number(h.dataset.colhead) : null)
      return
    }
    if (e.ctrlKey || e.metaKey) fillModRef.current = true
    const cell = cellFromEvent(e)
    if (!cell) return
    if (d === 'select') setSel({ r: cell.r, c: cell.c })
    else if (d === 'fill') setFillTo(cell.r)
  }

  useEffect(() => {
    const up = (e) => {
      const d = dragRef.current
      if (d === 'fill' && fillTo != null) applyFill(fillTo, e.ctrlKey || e.metaKey || fillModRef.current)
      else if (d && d.colFrom !== undefined && colOver != null) moveColumn(d.colFrom, colOver)
      dragRef.current = null
      fillModRef.current = false
      setFillTo(null)
      setColOver(null)
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  })

  const rg = range()
  const inRange = (r, c) => rg && r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2
  const inFillPreview = (r) =>
    fillTo != null && rg && ((fillTo > rg.r2 && r > rg.r2 && r <= fillTo) || (fillTo < rg.r1 && r < rg.r1 && r >= fillTo))

  return (
    <div
      ref={gridRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onDoubleClick={(e) => {
        if (e.target.closest('input,select')) return
        const cell = cellFromEvent(e)
        if (cell) startEdit(cell.r, cell.c)
      }}
      className="outline-none rounded-xl border border-border bg-card overflow-hidden select-none"
      style={{ height }}
    >
      <div ref={scrollRef} className="h-full overflow-auto">
        <div style={{ width: totalW, position: 'relative' }}>
          <div className="flex sticky top-0 z-10 bg-card2 border-b border-border" style={{ height: HEADER_H }}>
            <div className="shrink-0 border-r border-border/50 text-[9px] text-dgray flex items-center justify-center" style={{ width: 44 }}>#</div>
            {columns.map((col, c) => (
              <div key={col.id} data-colhead={c} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, c }) }} title="DRAG TO REORDER · RIGHT-CLICK TO INSERT / DELETE" className={'shrink-0 border-r border-border/50 px-2 flex items-center text-[10px] font-bold text-lgray uppercase relative cursor-grab ' + (colOver === c && dragRef.current && dragRef.current.colFrom !== undefined ? 'bg-teal/30' : '')} style={{ width: widths[c] }}>
                <span className="truncate pointer-events-none">{col.title}</span>
                <span data-resize={c} className="absolute right-0 top-0 h-full w-[6px] cursor-col-resize hover:bg-teal/50" />
              </div>
            ))}
          </div>
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vr) => {
              const r = vr.index
              const row = rows[r]
              if (!row) return null
              return (
                <div key={vr.key} className={'flex absolute left-0 ' + (r % 2 ? 'bg-card2/20' : '')} style={{ top: vr.start, height: rowHeight, width: totalW }}>
                  <div className="shrink-0 border-r border-b border-border/30 text-[9px] text-dgray flex items-center justify-center bg-card2/40" style={{ width: 44 }}>{r + 1}</div>
                  {columns.map((col, c) => {
                    const active = sel && sel.r === r && sel.c === c
                    const isEdit = editing && editing.r === r && editing.c === c
                    const v = row[col.id]
                    return (
                      <div
                        key={col.id}
                        data-r={r}
                        data-c={c}
                        className={
                          'shrink-0 border-r border-b border-border/30 px-2 flex items-center text-[11px] uppercase relative ' +
                          (inRange(r, c) ? 'bg-teal/15 ' : '') +
                          (inFillPreview(r) && c >= rg.c1 && c <= rg.c2 ? 'bg-cyan/10 ' : '') +
                          (active ? 'ring-2 ring-teal ring-inset z-[1] ' : '') +
                          (col.type === 'number' ? 'justify-end text-cyan ' : 'text-white ')
                        }
                        style={{ width: widths[c] }}
                      >
                        {isEdit ? (
                          col.type === 'select' ? (
                            <select
                              autoFocus
                              size={Math.min(8, (col.options || []).length + 1)}
                              value={editing.value}
                              onChange={(e) => { setCell(r, c, e.target.value); setEditing(null); gridRef.current?.focus() }}
                              onBlur={() => setEditing(null)}
                              className="absolute left-0 top-0 min-w-full bg-navy text-white text-[11px] uppercase outline-none border-2 border-teal px-1 z-20 select-text"
                            >
                              {(col.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input
                              autoFocus
                              value={editing.value}
                              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                              onBlur={() => commitEdit(null)}
                              className="absolute inset-0 bg-navy text-white text-[11px] uppercase outline-none border-2 border-teal px-2 select-text"
                            />
                          )
                        ) : col.type === 'checkbox' ? (
                          <span className={'w-4 h-4 rounded border text-[10px] font-bold flex items-center justify-center ' + (v ? 'bg-green border-green text-white' : 'border-border text-transparent')}>✓</span>
                        ) : (
                          <>
                            <span className="truncate">{String(v ?? '')}</span>
                            {col.type === 'select' && <span className="ml-auto text-dgray text-[9px] pl-1">▾</span>}
                          </>
                        )}
                        {rg && r === rg.r2 && c === rg.c2 && !isEdit && (
                          <span data-fill="1" className="absolute -right-[4px] -bottom-[4px] w-2.5 h-2.5 bg-teal border border-navy cursor-crosshair z-[2]" title="DRAG = COPY · CTRL+DRAG = SERIES" />
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)} />
          <div className="fixed z-50 bg-card2 border border-border rounded-md shadow-lg text-[10px] uppercase py-1" style={{ left: menu.x, top: menu.y }}>
            <button onMouseDown={(e) => { e.stopPropagation(); insertColAt(menu.c); setMenu(null) }} className="block w-full text-left px-3 py-1.5 text-lgray hover:bg-teal/20 hover:text-white">INSERT COLUMN LEFT</button>
            <button onMouseDown={(e) => { e.stopPropagation(); insertColAt(menu.c + 1); setMenu(null) }} className="block w-full text-left px-3 py-1.5 text-lgray hover:bg-teal/20 hover:text-white">INSERT COLUMN RIGHT</button>
            <button onMouseDown={(e) => { e.stopPropagation(); deleteColAt(menu.c); setMenu(null) }} className="block w-full text-left px-3 py-1.5 text-red/80 hover:bg-red/20 hover:text-white">DELETE COLUMN</button>
          </div>
        </>
      )}
    </div>
  )
}
