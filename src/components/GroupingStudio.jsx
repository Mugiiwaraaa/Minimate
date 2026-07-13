/* --- GroupingStudio.jsx --- Design Engine V2: DDC grouping floating canvas ---
   Blank canvas + two block libraries (DDC panels, imported equipment). Create a
   DDC block, pull an equipment block from the library, click one then the
   other to wire them — the DDC's as-built IO totals update live from the same
   equipmentMap/panels state everything else (IoSheetGrid/ReportsPage) reads.
   No new data model for wiring: this is a friendlier front end over the exact
   operation PanelDetail's V1 picker already performs (see estimateDiff.js).
   Freeform annotations (lines/text remarks) DO need a small new persisted
   field — project-level data.designCanvasNotes, threaded in as notes/
   onUpdateNotes (see App.jsx). */

import { useState, useRef, useEffect } from 'react'
import { estimateEquipmentToPanelEquipment } from '../lib/estimateDiff'

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase().trim() }

var gid = 0
function panelId() { gid++; return 'panel-' + Date.now() + '-' + gid }
function localId() { gid++; return 'placed-' + Date.now() + '-' + gid }
function noteId() { gid++; return 'note-' + Date.now() + '-' + gid }

var COLORS = ['teal', 'cyan', 'orange', 'red', 'purple', 'green']
var COLOR_HEX = { teal: '#2dd4bf', cyan: '#22d3ee', orange: '#fb923c', red: '#f87171', purple: '#a78bfa', green: '#4ade80' }
var MIN_W = 90
var MIN_H = 40

function ioEquipment(scope) {
  var sheet = ((scope && scope.sheets) || []).filter(function(s) { return s.kind === 'io_summary' })[0]
  return (sheet && sheet.data && sheet.data.equipment) || []
}

function pointTotals(eqs) {
  var t = { DI: 0, DO: 0, AI: 0, AO: 0, INT: 0, total: 0 }
  ;(eqs || []).forEach(function(eq) {
    ;(eq.points || []).forEach(function(p) {
      var n = Number(p.qty) || 0
      if (t[p.type] != null) t[p.type] += n
      t.total += n
    })
  })
  return t
}

export default function GroupingStudio(props) {
  // props: panels, equipmentMap, scope, onCreatePanel, onDeletePanel,
  //        onUpdateEquipment, onUpdatePanelLayout, notes, onUpdateNotes, onClose
  var panels = props.panels || []
  var equipmentMap = props.equipmentMap || {}
  var equipment = ioEquipment(props.scope)
  var notes = props.notes || []

  var viewState = useState({ scale: 1, tx: 60, ty: 60 })
  var view = viewState[0]; var setView = viewState[1]
  var placedState = useState([]) // [{localId, estEq, x, y, w, h}] — transient, unwired
  var placed = placedState[0]; var setPlaced = placedState[1]
  var selectedState = useState(null) // localId of a placed equipment block, or null
  var selected = selectedState[0]; var setSelected = selectedState[1]
  var searchState = useState('')
  var search = searchState[0]; var setSearch = searchState[1]
  var newDdcState = useState('')
  var newDdcName = newDdcState[0]; var setNewDdcName = newDdcState[1]
  var expandedState = useState(null) // {panelId, eqId} of a connected unit whose points are shown
  var expanded = expandedState[0]; var setExpanded = expandedState[1]
  var libOpenState = useState({ ddc: true, equip: true })
  var libOpen = libOpenState[0]; var setLibOpen = libOpenState[1]
  var modeState = useState('select') // 'select' | 'line' | 'text'
  var mode = modeState[0]; var setMode = modeState[1]
  var noteColorState = useState('teal')
  var noteColor = noteColorState[0]; var setNoteColor = noteColorState[1]
  var lineDraftState = useState(null) // {x1,y1,x2,y2} while dragging a new line
  var lineDraft = lineDraftState[0]; var setLineDraft = lineDraftState[1]
  var railOpenState = useState(false) // mobile-only: side rail is an off-canvas drawer below md
  var railOpen = railOpenState[0]; var setRailOpen = railOpenState[1]

  var wrapRef = useRef(null)
  var panRef = useRef(null)
  var dragRef = useRef(null) // {kind:'panel'|'placed'|'equipment'|'note', mode:'move'|'resize', id, panelId, startX, startY, origX, origY, origW, origH, moved}
  var viewRef = useRef(view); viewRef.current = view

  useEffect(function() {
    var wrap = wrapRef.current
    if (!wrap) return
    function onWheel(e) {
      e.preventDefault()
      setView(function(v) {
        var next = Math.min(2.5, Math.max(0.3, v.scale - e.deltaY * 0.001))
        return Object.assign({}, v, { scale: next })
      })
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return function() { wrap.removeEventListener('wheel', onWheel) }
  }, [])

  function commitNotes(next) { if (props.onUpdateNotes) props.onUpdateNotes(next) }

  // Touch devices have no wheel event — these buttons are the only zoom control there.
  function zoomBy(delta) {
    setView(function(v) { return Object.assign({}, v, { scale: Math.min(2.5, Math.max(0.3, v.scale + delta)) }) })
  }

  function screenToWorld(clientX, clientY) {
    var rect = wrapRef.current.getBoundingClientRect()
    var v = viewRef.current
    return { x: (clientX - rect.left - v.tx) / v.scale, y: (clientY - rect.top - v.ty) / v.scale }
  }

  // ─── Allocation across all panels (per-unit model, same basis as PanelDetail.jsx) ───
  var allocatedByType = {}
  Object.keys(equipmentMap).forEach(function(pid) {
    ;(equipmentMap[pid] || []).forEach(function(eq) {
      var k = up(eq.estimateType || eq.name)
      allocatedByType[k] = (allocatedByType[k] || 0) + 1
    })
  })

  function remainingFor(estEq) {
    var total = Number(estEq.qty) || 1
    return total - (allocatedByType[up(estEq.type)] || 0)
  }

  // ─── Canvas pan / line draw / text place ───
  function onCanvasPointerDown(e) {
    if (e.target !== e.currentTarget) return
    setSelected(null)
    setExpanded(null)
    if (mode === 'line') {
      var wp = screenToWorld(e.clientX, e.clientY)
      setLineDraft({ x1: wp.x, y1: wp.y, x2: wp.x, y2: wp.y })
      return
    }
    if (mode === 'text') {
      var wp2 = screenToWorld(e.clientX, e.clientY)
      commitNotes(notes.concat([{ id: noteId(), type: 'text', color: noteColor, x: wp2.x, y: wp2.y, text: '' }]))
      return
    }
    panRef.current = { startX: e.clientX, startY: e.clientY, origTx: view.tx, origTy: view.ty }
  }
  function onCanvasPointerMove(e) {
    if (lineDraft) {
      var wp = screenToWorld(e.clientX, e.clientY)
      setLineDraft(function(d) { return d ? Object.assign({}, d, { x2: wp.x, y2: wp.y }) : d })
      return
    }
    if (!panRef.current) return
    var dx = e.clientX - panRef.current.startX
    var dy = e.clientY - panRef.current.startY
    setView(function(v) { return Object.assign({}, v, { tx: panRef.current.origTx + dx, ty: panRef.current.origTy + dy }) })
  }
  function onCanvasPointerUp() {
    if (lineDraft) {
      var dist = Math.hypot(lineDraft.x2 - lineDraft.x1, lineDraft.y2 - lineDraft.y1)
      if (dist > 5) commitNotes(notes.concat([{ id: noteId(), type: 'line', color: noteColor, x1: lineDraft.x1, y1: lineDraft.y1, x2: lineDraft.x2, y2: lineDraft.y2 }]))
      setLineDraft(null)
      return
    }
    panRef.current = null
  }

  // ─── Block drag/resize (panel, placed-equipment, connected-equipment, note) ───
  function startDrag(info, e) {
    e.stopPropagation()
    dragRef.current = Object.assign({ startX: e.clientX, startY: e.clientY, moved: false }, info)
    e.target.setPointerCapture(e.pointerId)
  }
  function onBlockPointerMove(e) {
    var d = dragRef.current
    if (!d) return
    var dx = (e.clientX - d.startX) / viewRef.current.scale
    var dy = (e.clientY - d.startY) / viewRef.current.scale
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true
    if (d.mode === 'resize') {
      var nw = Math.max(MIN_W, d.origW + dx)
      var nh = Math.max(MIN_H, d.origH + dy)
      if (d.kind === 'panel') { if (props.onUpdatePanelLayout) props.onUpdatePanelLayout(d.id, { w: nw, h: nh }) }
      else if (d.kind === 'placed') { setPlaced(function(prev) { return prev.map(function(p) { return p.localId === d.id ? Object.assign({}, p, { w: nw, h: nh }) : p }) }) }
      else if (d.kind === 'equipment') {
        var existing = equipmentMap[d.panelId] || []
        if (props.onUpdateEquipment) props.onUpdateEquipment(d.panelId, existing.map(function(eq) { return eq.id === d.id ? Object.assign({}, eq, { w: nw, h: nh }) : eq }))
      }
      return
    }
    var nx = d.origX + dx
    var ny = d.origY + dy
    if (d.kind === 'panel') { if (props.onUpdatePanelLayout) props.onUpdatePanelLayout(d.id, { dx: nx, dy: ny }) }
    else if (d.kind === 'placed') { setPlaced(function(prev) { return prev.map(function(p) { return p.localId === d.id ? Object.assign({}, p, { x: nx, y: ny }) : p }) }) }
    else if (d.kind === 'note') { commitNotes(notes.map(function(n) { return n.id === d.id ? Object.assign({}, n, { x: nx, y: ny }) : n })) }
  }
  function onBlockPointerUp() { dragRef.current = null }

  function panelPos(panel, idx) {
    if (typeof panel.dx === 'number' && typeof panel.dy === 'number') return { x: panel.dx, y: panel.dy }
    var col = idx % 4
    var row = Math.floor(idx / 4)
    return { x: 60 + col * 260, y: 60 + row * 220 }
  }

  // ─── Library actions ───
  function createDdc() {
    var name = newDdcName.trim()
    if (!name || !props.onCreatePanel) return
    var idx = panels.length
    var pos = { x: 60 + (idx % 4) * 260, y: 60 + Math.floor(idx / 4) * 220 }
    props.onCreatePanel({ id: panelId(), name: up(name), location: '', floor: '', dx: pos.x, dy: pos.y })
    setNewDdcName('')
  }

  function placeEquipment(estEq) {
    if (remainingFor(estEq) <= 0) return
    var n = placed.length
    setPlaced(function(prev) { return prev.concat([{
      localId: localId(), estEq: estEq,
      x: 500 + (n % 5) * 40, y: 60 + Math.floor(n / 5) * 60
    }]) })
  }

  function clickPlaced(pid) {
    setSelected(function(s) { return s === pid ? null : pid })
  }

  // NOTE: clickDdc only ever acts when `selected` is set, and `selected` is
  // only ever set by clickPlaced (an unwired equipment block) — there is no
  // path for a DDC block to select another DDC block. DDC-to-DDC wiring is
  // deliberately impossible; don't "fix" this into existing later.
  function clickDdc(panel) {
    if (!selected) return
    var block = placed.filter(function(p) { return p.localId === selected })[0]
    if (!block) { setSelected(null); return }
    var startIndex = (allocatedByType[up(block.estEq.type)] || 0) + 1
    var units = estimateEquipmentToPanelEquipment(block.estEq, 1, startIndex)
    var existing = equipmentMap[panel.id] || []
    if (props.onUpdateEquipment) props.onUpdateEquipment(panel.id, existing.concat(units))
    setPlaced(function(prev) { return prev.filter(function(p) { return p.localId !== selected }) })
    setSelected(null)
  }

  function disconnect(panelId_, eqId) {
    var existing = equipmentMap[panelId_] || []
    if (props.onUpdateEquipment) props.onUpdateEquipment(panelId_, existing.filter(function(e) { return e.id !== eqId }))
    setExpanded(null)
  }

  function editNoteText(id, text) {
    commitNotes(notes.map(function(n) { return n.id === id ? Object.assign({}, n, { text: text }) : n }))
  }
  function deleteNote(id) {
    commitNotes(notes.filter(function(n) { return n.id !== id }))
  }

  var filteredEquip = equipment.filter(function(eq) {
    return !search || up(eq.type).indexOf(up(search)) !== -1
  })

  function ResizeHandle(rp) {
    return (
      <div onPointerDown={function(e) { startDrag(Object.assign({ mode: 'resize' }, rp.info), e) }}
        onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
        style={{ position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, cursor: 'nwse-resize', touchAction: 'none' }}
        className="border-b-2 border-r-2 border-dgray/50 hover:border-teal" />
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-navy flex" style={{ textTransform: 'uppercase' }}>
      {/* Mobile-only backdrop behind the off-canvas side rail */}
      {railOpen && (
        <div className="md:hidden fixed inset-0 bg-black/60 z-30" onClick={function() { setRailOpen(false) }} />
      )}

      {/* ─── Side rail — always visible at md+, an off-canvas drawer below md ─── */}
      <div className={'w-72 shrink-0 border-r border-border bg-card flex flex-col overflow-y-auto fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0 ' + (railOpen ? 'translate-x-0' : '-translate-x-full')}>
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="text-sm font-bold text-white">DDC GROUPING CANVAS</div>
          <button onClick={props.onClose} className="text-[11px] text-dgray hover:text-white px-2 py-1">✕ CLOSE</button>
        </div>

        <div className="border-b border-border">
          <button onClick={function() { setLibOpen(Object.assign({}, libOpen, { ddc: !libOpen.ddc })) }} className="w-full text-left px-3 py-2 text-[11px] font-bold text-teal flex items-center justify-between">
            <span>DDC PANELS ({panels.length})</span><span>{libOpen.ddc ? '▾' : '▸'}</span>
          </button>
          {libOpen.ddc && (
            <div className="px-3 pb-3 space-y-2">
              <div className="flex gap-1.5">
                <input value={newDdcName} onChange={function(e) { setNewDdcName(e.target.value) }}
                  onKeyDown={function(e) { if (e.key === 'Enter') createDdc() }}
                  placeholder="NEW DDC NAME" style={{ textTransform: 'uppercase' }}
                  className="flex-1 bg-navy border border-border rounded px-2 py-1 text-[11px] text-white outline-none focus:border-teal" />
                <button onClick={createDdc} disabled={!newDdcName.trim()} className="px-2 py-1 bg-teal text-white text-[10px] font-bold rounded disabled:opacity-40">+ ADD</button>
              </div>
              <div className="flex flex-wrap gap-1">
                {panels.map(function(p) {
                  return <span key={p.id} className="text-[9px] px-2 py-1 rounded bg-card2 text-dgray">{p.name}</span>
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <button onClick={function() { setLibOpen(Object.assign({}, libOpen, { equip: !libOpen.equip })) }} className="w-full text-left px-3 py-2 text-[11px] font-bold text-cyan flex items-center justify-between sticky top-0 bg-card">
            <span>EQUIPMENT ({equipment.length})</span><span>{libOpen.equip ? '▾' : '▸'}</span>
          </button>
          {libOpen.equip && (
            <div className="px-3 pb-3 space-y-1.5">
              <input value={search} onChange={function(e) { setSearch(e.target.value) }}
                placeholder="SEARCH EQUIPMENT..." style={{ textTransform: 'uppercase' }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white outline-none focus:border-teal mb-1" />
              {equipment.length === 0 && <div className="text-[10px] text-dgray italic">NO I-O SUMMARY IMPORTED YET</div>}
              {filteredEquip.map(function(eq, i) {
                var remaining = remainingFor(eq)
                var total = Number(eq.qty) || 1
                return (
                  <button key={i} onClick={function() { placeEquipment(eq) }} disabled={remaining <= 0}
                    className={'w-full text-left px-2 py-1.5 rounded text-[10px] flex items-center justify-between ' + (remaining <= 0 ? 'bg-card2/50 text-dgray/50' : 'bg-card2 text-white hover:bg-cyan/20')}>
                    <span>{eq.type}</span>
                    <span className={remaining <= 0 ? 'text-dgray/50' : 'text-cyan'}>{Math.max(remaining, 0)}/{total}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="p-2 border-t border-border text-[9px] text-dgray leading-snug">
          CLICK AN EQUIPMENT BLOCK TO SELECT IT, THEN CLICK A DDC BLOCK TO WIRE IT. DRAG BLOCKS TO ARRANGE, DRAG THE CORNER TO RESIZE. SCROLL TO ZOOM, DRAG BACKGROUND TO PAN.
        </div>
      </div>

      {/* ─── Canvas ─── */}
      <div className="flex-1 relative flex flex-col min-w-0">
        {/* Annotation toolbar */}
        <div className="flex items-center gap-3 flex-wrap px-3 py-1.5 border-b border-border bg-card z-10">
          <button onClick={function() { setRailOpen(true) }} className="md:hidden px-2.5 py-1 rounded text-[9px] font-bold uppercase bg-card2 text-dgray hover:text-white">☰ LIBRARY</button>
          <div className="flex gap-1">
            {['select', 'line', 'text'].map(function(m) {
              return <button key={m} onClick={function() { setMode(m) }} className={'px-2.5 py-1 rounded text-[9px] font-bold uppercase ' + (mode === m ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>{m === 'select' ? 'SELECT / PAN' : m}</button>
            })}
          </div>
          <div className="flex gap-1 items-center">
            <span className="text-[9px] text-dgray">COLOR</span>
            {COLORS.map(function(c) {
              return <button key={c} onClick={function() { setNoteColor(c) }} title={c}
                style={{ width: 16, height: 16, borderRadius: 4, background: COLOR_HEX[c], outline: noteColor === c ? '2px solid white' : 'none' }} />
            })}
          </div>
        </div>

        <div ref={wrapRef} className="flex-1 relative overflow-hidden"
          onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp}
          style={{ cursor: mode !== 'select' ? 'crosshair' : (panRef.current ? 'grabbing' : 'grab'), backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)', backgroundSize: '24px 24px' }}>
          <div style={{ position: 'absolute', top: 0, left: 0, transform: 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.scale + ')', transformOrigin: '0 0' }}>
            <svg style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
              {panels.map(function(panel, idx) {
                var pp = panelPos(panel, idx)
                var eqs = equipmentMap[panel.id] || []
                return eqs.map(function(eq, i) {
                  var col = i % 4, row = Math.floor(i / 4)
                  var ex = pp.x + 240 + col * 130
                  var ey = pp.y + 20 + row * 60
                  return <line key={panel.id + '-' + eq.id} x1={pp.x + 100} y1={pp.y + 40} x2={ex} y2={ey + 16} stroke="rgba(45,212,191,0.5)" strokeWidth={2} />
                })
              })}
              {notes.filter(function(n) { return n.type === 'line' }).map(function(n) {
                return <line key={n.id} x1={n.x1} y1={n.y1} x2={n.x2} y2={n.y2} stroke={COLOR_HEX[n.color] || COLOR_HEX.teal} strokeWidth={2.5} />
              })}
              {lineDraft && <line x1={lineDraft.x1} y1={lineDraft.y1} x2={lineDraft.x2} y2={lineDraft.y2} stroke={COLOR_HEX[noteColor]} strokeWidth={2.5} strokeDasharray="4 3" />}
            </svg>

            {notes.filter(function(n) { return n.type === 'line' }).map(function(n) {
              var mx = (n.x1 + n.x2) / 2, my = (n.y1 + n.y2) / 2
              return (
                <button key={n.id + '-del'} onClick={function() { deleteNote(n.id) }} title="DELETE LINE"
                  style={{ position: 'absolute', left: mx - 7, top: my - 7, width: 14, height: 14, borderRadius: 7, fontSize: 8, lineHeight: '14px' }}
                  className="bg-navy/80 text-dgray hover:text-red border border-dgray/40">✕</button>
              )
            })}

            {panels.map(function(panel, idx) {
              var pp = panelPos(panel, idx)
              var eqs = equipmentMap[panel.id] || []
              var totals = pointTotals(eqs)
              var pw = panel.w || 200
              var ph = panel.h || 110
              return (
                <div key={panel.id}>
                  <div
                    role="button" tabIndex={0} aria-label={'DDC BLOCK ' + panel.name}
                    onPointerDown={function(e) { startDrag({ kind: 'panel', mode: 'move', id: panel.id, origX: pp.x, origY: pp.y }, e) }}
                    onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                    onClick={function() { if (!dragRef.current || !dragRef.current.moved) clickDdc(panel) }}
                    style={{ position: 'absolute', left: pp.x, top: pp.y, width: pw, height: ph, touchAction: 'none', overflow: 'hidden' }}
                    className={'rounded-lg border-2 p-2.5 cursor-pointer select-none shadow-lg ' + (selected ? 'border-teal bg-teal/10' : 'border-cyan bg-card')}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[11px] font-bold text-white truncate">{panel.name}</div>
                      <button onPointerDown={function(e) { e.stopPropagation() }}
                        onClick={function(e) { e.stopPropagation(); if (window.confirm('DELETE PANEL ' + panel.name + '?') && props.onDeletePanel) props.onDeletePanel(panel.id) }}
                        className="text-[9px] text-red/40 hover:text-red">✕</button>
                    </div>
                    <div className="text-[9px] text-dgray">{eqs.length} UNIT{eqs.length === 1 ? '' : 'S'}</div>
                    <div className="flex gap-1 flex-wrap mt-1">
                      {['DI', 'DO', 'AI', 'AO'].map(function(k) {
                        return totals[k] > 0 ? <span key={k} className="text-[8px] px-1 py-0.5 rounded bg-card2 text-cyan">{k} {totals[k]}</span> : null
                      })}
                    </div>
                    <ResizeHandle info={{ kind: 'panel', id: panel.id, origW: pw, origH: ph }} />
                  </div>
                  {eqs.map(function(eq, i) {
                    var col = i % 4, row = Math.floor(i / 4)
                    var ex = pp.x + 240 + col * 130
                    var ey = pp.y + 20 + row * 60
                    var ew = eq.w || 110
                    var eh = eq.h || 46
                    var isExpanded = expanded && expanded.panelId === panel.id && expanded.eqId === eq.id
                    return (
                      <div key={eq.id}>
                        <div role="button" tabIndex={0} aria-label={'CONNECTED UNIT ' + eq.name}
                          onClick={function() { setExpanded(isExpanded ? null : { panelId: panel.id, eqId: eq.id }) }}
                          style={{ position: 'absolute', left: ex, top: ey, width: ew, height: eh, touchAction: 'none', overflow: 'hidden' }}
                          className="rounded border border-teal/60 bg-card2 px-2 py-1 cursor-pointer select-none">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] text-white truncate">{eq.name}</span>
                            <button onClick={function(e) { e.stopPropagation(); disconnect(panel.id, eq.id) }} className="text-[8px] text-red/50 hover:text-red ml-1">✕</button>
                          </div>
                          <ResizeHandle info={{ kind: 'equipment', id: eq.id, panelId: panel.id, origW: ew, origH: eh }} />
                        </div>
                        {isExpanded && (
                          <div style={{ position: 'absolute', left: ex, top: ey + eh + 4, width: 170, zIndex: 10 }} className="rounded border border-teal bg-navy p-2 shadow-xl">
                            <div className="text-[9px] font-bold text-teal mb-1">{eq.name} POINTS</div>
                            {(eq.points || []).filter(function(p) { return p.type }).map(function(p, pi) {
                              return <div key={pi} className="text-[8px] text-dgray flex justify-between"><span className="truncate mr-1">{p.description || p.type}</span><span className="text-cyan shrink-0">{p.type} {p.qty}</span></div>
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {placed.map(function(block) {
              var isSel = selected === block.localId
              var bw = block.w || 130
              var bh = block.h || 46
              return (
                <div key={block.localId}
                  role="button" tabIndex={0} aria-label={'UNWIRED BLOCK ' + block.estEq.type}
                  onPointerDown={function(e) { startDrag({ kind: 'placed', mode: 'move', id: block.localId, origX: block.x, origY: block.y }, e) }}
                  onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                  onClick={function() { if (!dragRef.current || !dragRef.current.moved) clickPlaced(block.localId) }}
                  style={{ position: 'absolute', left: block.x, top: block.y, width: bw, height: bh, touchAction: 'none', overflow: 'hidden' }}
                  className={'rounded border-2 px-2 py-1.5 cursor-pointer select-none shadow ' + (isSel ? 'border-orange bg-orange/20' : 'border-dgray/50 bg-card2')}>
                  <div className="text-[10px] text-white truncate">{block.estEq.type}</div>
                  <div className="text-[8px] text-dgray">{isSel ? 'CLICK A DDC TO WIRE' : 'UNWIRED'}</div>
                  <ResizeHandle info={{ kind: 'placed', id: block.localId, origW: bw, origH: bh }} />
                </div>
              )
            })}

            {notes.filter(function(n) { return n.type === 'text' }).map(function(n) {
              return (
                <div key={n.id} style={{ position: 'absolute', left: n.x, top: n.y, width: 150 }} className="rounded shadow-lg overflow-hidden">
                  <div
                    onPointerDown={function(e) { startDrag({ kind: 'note', mode: 'move', id: n.id, origX: n.x, origY: n.y }, e) }}
                    onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                    style={{ background: COLOR_HEX[n.color] || COLOR_HEX.teal, touchAction: 'none' }}
                    className="px-1.5 py-0.5 text-[8px] text-navy font-bold flex items-center justify-between cursor-move select-none">
                    <span>REMARK</span>
                    <button onPointerDown={function(e) { e.stopPropagation() }} onClick={function(e) { e.stopPropagation(); deleteNote(n.id) }} className="hover:text-red">✕</button>
                  </div>
                  <div contentEditable suppressContentEditableWarning
                    onBlur={function(e) { editNoteText(n.id, e.target.innerText) }}
                    style={{ borderLeft: '3px solid ' + (COLOR_HEX[n.color] || COLOR_HEX.teal) }}
                    className="text-[10px] text-white bg-navy/95 px-1.5 py-1 min-h-[26px] outline-none">{n.text}</div>
                </div>
              )
            })}
          </div>

          {/* Zoom controls — the only way to zoom on touch devices (no wheel event) */}
          <div className="absolute bottom-3 right-3 flex flex-col gap-1 z-10">
            <button onClick={function() { zoomBy(0.15) }} className="w-8 h-8 rounded bg-card2 text-white text-sm font-bold border border-border hover:border-teal">+</button>
            <button onClick={function() { zoomBy(-0.15) }} className="w-8 h-8 rounded bg-card2 text-white text-sm font-bold border border-border hover:border-teal">−</button>
          </div>
        </div>
      </div>
    </div>
  )
}
