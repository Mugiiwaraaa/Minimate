/* --- GroupingStudio.jsx --- Design Engine V2: DDC grouping floating canvas ---
   Blank canvas + two block libraries (DDC panels, imported equipment). Create a
   DDC block, pull an equipment block from the library, click one then the
   other to wire them — the DDC's as-built IO totals update live from the same
   equipmentMap/panels state everything else (IoSheetGrid/ReportsPage) reads.
   No new data model: this is a friendlier front end over the exact operation
   PanelDetail's V1 picker already performs (see estimateDiff.js). */

import { useState, useRef, useEffect } from 'react'
import { estimateEquipmentToPanelEquipment } from '../lib/estimateDiff'

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase().trim() }

var gid = 0
function panelId() { gid++; return 'panel-' + Date.now() + '-' + gid }
function localId() { gid++; return 'placed-' + Date.now() + '-' + gid }

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
  //        onUpdateEquipment, onUpdatePanelPos, onClose
  var panels = props.panels || []
  var equipmentMap = props.equipmentMap || {}
  var equipment = ioEquipment(props.scope)

  var viewState = useState({ scale: 1, tx: 60, ty: 60 })
  var view = viewState[0]; var setView = viewState[1]
  var placedState = useState([]) // [{localId, estEq, x, y}] — transient, unwired
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

  var wrapRef = useRef(null)
  var panRef = useRef(null)
  var dragRef = useRef(null) // {kind:'panel'|'placed', id, startX, startY, origX, origY, moved}
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

  // ─── Canvas pan ───
  function onCanvasPointerDown(e) {
    if (e.target !== e.currentTarget) return
    setSelected(null)
    setExpanded(null)
    panRef.current = { startX: e.clientX, startY: e.clientY, origTx: view.tx, origTy: view.ty }
  }
  function onCanvasPointerMove(e) {
    if (!panRef.current) return
    var dx = e.clientX - panRef.current.startX
    var dy = e.clientY - panRef.current.startY
    setView(function(v) { return Object.assign({}, v, { tx: panRef.current.origTx + dx, ty: panRef.current.origTy + dy }) })
  }
  function onCanvasPointerUp() { panRef.current = null }

  // ─── Block drag (panel or placed-equipment) ───
  function startDrag(kind, id, x, y, e) {
    e.stopPropagation()
    dragRef.current = { kind: kind, id: id, startX: e.clientX, startY: e.clientY, origX: x, origY: y, moved: false }
    e.target.setPointerCapture(e.pointerId)
  }
  function onBlockPointerMove(e) {
    var d = dragRef.current
    if (!d) return
    var dx = (e.clientX - d.startX) / viewRef.current.scale
    var dy = (e.clientY - d.startY) / viewRef.current.scale
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true
    var nx = d.origX + dx
    var ny = d.origY + dy
    if (d.kind === 'panel') {
      if (props.onUpdatePanelPos) props.onUpdatePanelPos(d.id, nx, ny)
    } else {
      setPlaced(function(prev) { return prev.map(function(p) { return p.localId === d.id ? Object.assign({}, p, { x: nx, y: ny }) : p }) })
    }
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

  var filteredEquip = equipment.filter(function(eq) {
    return !search || up(eq.type).indexOf(up(search)) !== -1
  })

  return (
    <div className="fixed inset-0 z-50 bg-navy flex" style={{ textTransform: 'uppercase' }}>
      {/* ─── Side rail ─── */}
      <div className="w-72 shrink-0 border-r border-border bg-card flex flex-col overflow-y-auto">
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
          CLICK AN EQUIPMENT BLOCK TO SELECT IT, THEN CLICK A DDC BLOCK TO WIRE IT. DRAG BLOCKS TO ARRANGE. SCROLL TO ZOOM, DRAG BACKGROUND TO PAN.
        </div>
      </div>

      {/* ─── Canvas ─── */}
      <div ref={wrapRef} className="flex-1 relative overflow-hidden"
        onPointerDown={onCanvasPointerDown} onPointerMove={onCanvasPointerMove} onPointerUp={onCanvasPointerUp}
        style={{ cursor: panRef.current ? 'grabbing' : 'grab', backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)', backgroundSize: '24px 24px' }}>
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
          </svg>

          {panels.map(function(panel, idx) {
            var pp = panelPos(panel, idx)
            var eqs = equipmentMap[panel.id] || []
            var totals = pointTotals(eqs)
            return (
              <div key={panel.id}>
                <div
                  role="button" tabIndex={0} aria-label={'DDC BLOCK ' + panel.name}
                  onPointerDown={function(e) { startDrag('panel', panel.id, pp.x, pp.y, e) }}
                  onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                  onClick={function() { if (!dragRef.current || !dragRef.current.moved) clickDdc(panel) }}
                  style={{ position: 'absolute', left: pp.x, top: pp.y, width: 200, touchAction: 'none' }}
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
                </div>
                {eqs.map(function(eq, i) {
                  var col = i % 4, row = Math.floor(i / 4)
                  var ex = pp.x + 240 + col * 130
                  var ey = pp.y + 20 + row * 60
                  var isExpanded = expanded && expanded.panelId === panel.id && expanded.eqId === eq.id
                  return (
                    <div key={eq.id}>
                      <div role="button" tabIndex={0} aria-label={'CONNECTED UNIT ' + eq.name}
                        onClick={function() { setExpanded(isExpanded ? null : { panelId: panel.id, eqId: eq.id }) }}
                        style={{ position: 'absolute', left: ex, top: ey, width: 110, touchAction: 'none' }}
                        className="rounded border border-teal/60 bg-card2 px-2 py-1 cursor-pointer select-none">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-white truncate">{eq.name}</span>
                          <button onClick={function(e) { e.stopPropagation(); disconnect(panel.id, eq.id) }} className="text-[8px] text-red/50 hover:text-red ml-1">✕</button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div style={{ position: 'absolute', left: ex, top: ey + 30, width: 170, zIndex: 10 }} className="rounded border border-teal bg-navy p-2 shadow-xl">
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
            return (
              <div key={block.localId}
                role="button" tabIndex={0} aria-label={'UNWIRED BLOCK ' + block.estEq.type}
                onPointerDown={function(e) { startDrag('placed', block.localId, block.x, block.y, e) }}
                onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                onClick={function() { if (!dragRef.current || !dragRef.current.moved) clickPlaced(block.localId) }}
                style={{ position: 'absolute', left: block.x, top: block.y, width: 130, touchAction: 'none' }}
                className={'rounded border-2 px-2 py-1.5 cursor-pointer select-none shadow ' + (isSel ? 'border-orange bg-orange/20' : 'border-dgray/50 bg-card2')}>
                <div className="text-[10px] text-white truncate">{block.estEq.type}</div>
                <div className="text-[8px] text-dgray">{isSel ? 'CLICK A DDC TO WIRE' : 'UNWIRED'}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
