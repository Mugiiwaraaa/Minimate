/* --- GroupingStudio.jsx --- Design Engine V3: as-built architecture canvas ---
   Blank canvas + block libraries (locations, DDC panels, imported equipment).
   Create a DDC block, pull an equipment block from the library, click one then
   the other to wire them — the DDC's as-built IO totals update live from the
   same equipmentMap/panels state everything else (IoSheetGrid/ReportsPage)
   reads. No new data model for wiring: this is a friendlier front end over the
   exact operation PanelDetail's V1 picker already performs (see
   estimateDiff.js). Point-level detail intentionally lives ONLY in the panel's
   own IO Summary (PanelDetail/IoSheetGrid) — this canvas is for "what
   equipment sits under what DDC, in what location," nothing deeper.

   Location grouping reuses the existing panel.location text field as the
   grouping key (also displayed elsewhere in the app as a plain label) — no
   new per-panel field. designLocations is a small persisted registry
   ({id,name,dx,dy,w,h}) that lets a location block exist (and remember its
   position) before any DDC is assigned to it; site-view locations are the
   union of that registry and whatever distinct panel.location values are
   actually in use, so a location never vanishes just because its registry
   row was removed.

   Perf: every drag/resize updates one local `dragPreview` state only: parent
   state (panels/equipmentMap/notes/locations) is committed ONCE on release,
   not per pixel — this is also what makes drop-to-assign-location and clean
   one-step undo possible. */

import { useState, useRef, useEffect } from 'react'
import { estimateEquipmentToPanelEquipment } from '../lib/estimateDiff'

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase().trim() }

var gid = 0
function panelId() { gid++; return 'panel-' + Date.now() + '-' + gid }
function localId() { gid++; return 'placed-' + Date.now() + '-' + gid }
function noteId() { gid++; return 'note-' + Date.now() + '-' + gid }
function locId() { gid++; return 'loc-' + Date.now() + '-' + gid }

var COLORS = ['teal', 'cyan', 'orange', 'red', 'purple', 'green']
var COLOR_HEX = { teal: '#2dd4bf', cyan: '#22d3ee', orange: '#fb923c', red: '#f87171', purple: '#a78bfa', green: '#4ade80' }
var MIN_W = 90
var MIN_H = 40
var RAIL_MIN = 220
var RAIL_MAX = 480
var RAIL_DEFAULT = 288

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
  //        onUpdateEquipment, onUpdatePanelLayout, notes, onUpdateNotes,
  //        locations, onUpdateLocations, onUnassignLocation, onClose
  var panels = props.panels || []
  var equipmentMap = props.equipmentMap || {}
  var equipment = ioEquipment(props.scope)
  var notes = props.notes || []
  var locations = props.locations || []

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
  var newLocState = useState('')
  var newLocName = newLocState[0]; var setNewLocName = newLocState[1]
  var libOpenState = useState({ loc: true, ddc: true, equip: true })
  var libOpen = libOpenState[0]; var setLibOpen = libOpenState[1]
  var modeState = useState('select') // 'select' | 'line' | 'text'
  var mode = modeState[0]; var setMode = modeState[1]
  var noteColorState = useState('teal')
  var noteColor = noteColorState[0]; var setNoteColor = noteColorState[1]
  var lineDraftState = useState(null) // {x1,y1,x2,y2} while dragging a new line
  var lineDraft = lineDraftState[0]; var setLineDraft = lineDraftState[1]
  var railOpenState = useState(false) // mobile-only: side rail is an off-canvas drawer below md
  var railOpen = railOpenState[0]; var setRailOpen = railOpenState[1]
  var railWidthState = useState(RAIL_DEFAULT) // session-local only, not persisted
  var railWidth = railWidthState[0]; var setRailWidth = railWidthState[1]
  var activeLocationState = useState(null) // null = site view, else drilled into this location name
  var activeLocation = activeLocationState[0]; var setActiveLocation = activeLocationState[1]
  var dragPreviewState = useState(null) // {kind,id,panelId,x,y,w,h} — visual-only during a drag/resize
  var dragPreview = dragPreviewState[0]; var setDragPreview = dragPreviewState[1]

  var wrapRef = useRef(null)
  var panRef = useRef(null)
  var dragRef = useRef(null) // {kind:'panel'|'placed'|'equipment'|'note'|'location', mode:'move'|'resize', id, panelId, startX, startY, origX, origY, origW, origH, moved}
  var railDragRef = useRef(null)
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
  function commitLocations(next) { if (props.onUpdateLocations) props.onUpdateLocations(next) }

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

  // ─── Location derivation: union of the registry + any location strings in use ───
  var siteLocations = (function() {
    var byKey = {}
    locations.forEach(function(l) { byKey[up(l.name)] = { name: l.name, reg: l } })
    panels.forEach(function(p) {
      if (p.location) { var k = up(p.location); if (!byKey[k]) byKey[k] = { name: p.location, reg: null } }
    })
    return Object.keys(byKey).map(function(k) { return byKey[k] })
  })()

  function locationMembers(name) {
    return panels.filter(function(p) { return up(p.location || '') === up(name) })
  }

  var visiblePanels = activeLocation
    ? locationMembers(activeLocation)
    : panels.filter(function(p) { return !p.location })

  // ─── Canvas pan / line draw / text place ───
  function onCanvasPointerDown(e) {
    if (e.target !== e.currentTarget) return
    setSelected(null)
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

  // ─── Position helpers (each checks the live drag preview, else falls back) ───
  function panelPos(panel, idx) {
    if (typeof panel.dx === 'number' && typeof panel.dy === 'number') return { x: panel.dx, y: panel.dy }
    var col = idx % 4
    var row = Math.floor(idx / 4)
    return { x: 60 + col * 260, y: 60 + row * 220 }
  }
  function panelRect(panel, idx) {
    var base = panelPos(panel, idx)
    var x = base.x, y = base.y, w = panel.w || 200, h = panel.h || 110
    if (dragPreview && dragPreview.kind === 'panel' && dragPreview.id === panel.id) {
      if (dragPreview.x != null) { x = dragPreview.x; y = dragPreview.y }
      if (dragPreview.w != null) { w = dragPreview.w; h = dragPreview.h }
    }
    return { x: x, y: y, w: w, h: h }
  }
  function equipAutoPos(pp, i) {
    var col = i % 4, row = Math.floor(i / 4)
    return { x: pp.x + 240 + col * 130, y: pp.y + 20 + row * 60 }
  }
  function equipRect(eq, pp, i) {
    var fallback = equipAutoPos(pp, i)
    var x = (typeof eq.ex === 'number') ? eq.ex : fallback.x
    var y = (typeof eq.ey === 'number') ? eq.ey : fallback.y
    var w = eq.w || 110, h = eq.h || 46
    if (dragPreview && dragPreview.kind === 'equipment' && dragPreview.id === eq.id) {
      if (dragPreview.x != null) { x = dragPreview.x; y = dragPreview.y }
      if (dragPreview.w != null) { w = dragPreview.w; h = dragPreview.h }
    }
    return { x: x, y: y, w: w, h: h }
  }
  // While a DDC panel is being dragged, its connected equipment (and the wires
  // drawn to them) visually ride along by this same delta — otherwise moving a
  // panel just stretches the wires elastically toward equipment left behind.
  // Equipment with no explicit ex/ey already tracks the panel for free via
  // equipAutoPos's fallback; this only matters for equipment someone has
  // individually repositioned before (explicit ex/ey, now absolute).
  function panelFollowDelta(panel, idx, pr) {
    if (dragPreview && dragPreview.kind === 'panel' && dragPreview.id === panel.id && dragPreview.x != null) {
      var basePos = panelPos(panel, idx)
      return { dx: pr.x - basePos.x, dy: pr.y - basePos.y }
    }
    return { dx: 0, dy: 0 }
  }
  function locationPos(idx) {
    var col = idx % 4, row = Math.floor(idx / 4)
    return { x: 60 + col * 300, y: 60 + row * 220 }
  }
  function locationRect(loc, idx) {
    var reg = loc.reg
    var base = reg ? { x: reg.dx, y: reg.dy } : locationPos(idx)
    var x = base.x, y = base.y, w = (reg && reg.w) || 240, h = (reg && reg.h) || 120
    if (dragPreview && dragPreview.kind === 'location' && up(dragPreview.id) === up(loc.name)) {
      if (dragPreview.x != null) { x = dragPreview.x; y = dragPreview.y }
      if (dragPreview.w != null) { w = dragPreview.w; h = dragPreview.h }
    }
    return { x: x, y: y, w: w, h: h }
  }
  function noteRect(n) {
    var x = n.x, y = n.y
    if (dragPreview && dragPreview.kind === 'note' && dragPreview.id === n.id && dragPreview.x != null) { x = dragPreview.x; y = dragPreview.y }
    return { x: x, y: y }
  }
  function upsertLocationByName(name, patch) {
    var found = false
    var next = locations.map(function(l) {
      if (up(l.name) === up(name)) { found = true; return Object.assign({}, l, patch) }
      return l
    })
    if (!found) next = next.concat([Object.assign({ id: locId(), name: name, dx: 60, dy: 60, w: 240, h: 120 }, patch)])
    return next
  }

  // ─── Block drag/resize (panel, placed, equipment, note, location) ───
  function startDrag(info, e) {
    e.stopPropagation()
    dragRef.current = Object.assign({ startX: e.clientX, startY: e.clientY, moved: false }, info)
    e.target.setPointerCapture(e.pointerId)
  }
  function onBlockPointerMove(e) {
    var d = dragRef.current
    if (!d) return
    d.lastClientX = e.clientX; d.lastClientY = e.clientY
    var dx = (e.clientX - d.startX) / viewRef.current.scale
    var dy = (e.clientY - d.startY) / viewRef.current.scale
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true
    if (d.mode === 'resize') {
      var nw = Math.max(MIN_W, d.origW + dx)
      var nh = Math.max(MIN_H, d.origH + dy)
      setDragPreview({ kind: d.kind, id: d.id, panelId: d.panelId, w: nw, h: nh })
      return
    }
    var nx = d.origX + dx
    var ny = d.origY + dy
    if (d.kind === 'placed') {
      // Local-only state, never touches App.jsx — no perf reason to defer this one.
      setPlaced(function(prev) { return prev.map(function(p) { return p.localId === d.id ? Object.assign({}, p, { x: nx, y: ny }) : p }) })
      return
    }
    setDragPreview({ kind: d.kind, id: d.id, panelId: d.panelId, x: nx, y: ny })
  }
  function onBlockPointerUp() {
    var d = dragRef.current
    var dp = dragPreview
    dragRef.current = null
    setDragPreview(null)
    if (!d || d.kind === 'placed') return
    if (!dp) return
    if (d.mode === 'resize') {
      if (d.kind === 'panel') { if (props.onUpdatePanelLayout) props.onUpdatePanelLayout(d.id, { w: dp.w, h: dp.h }) }
      else if (d.kind === 'equipment') {
        var existing = equipmentMap[d.panelId] || []
        if (props.onUpdateEquipment) props.onUpdateEquipment(d.panelId, existing.map(function(eq) { return eq.id === d.id ? Object.assign({}, eq, { w: dp.w, h: dp.h }) : eq }))
      } else if (d.kind === 'location') {
        commitLocations(upsertLocationByName(d.id, { w: dp.w, h: dp.h }))
      }
      return
    }
    // move
    if (d.kind === 'panel') {
      var patch = { dx: dp.x, dy: dp.y }
      var eqShiftDx = 0, eqShiftDy = 0
      // Dropped onto a sidebar location pill (or the UNASSIGNED chip) — takes
      // priority over the canvas-overlap check below. This is a JUMP into a
      // different location's view, not a drag gesture, so it lands at a fresh
      // auto-layout slot (like a newly created DDC) instead of wherever the
      // cursor happened to be over the rail — otherwise it can end up stuck
      // behind the sidebar. Equipment doesn't follow a jump like this.
      var dropEl = (d.lastClientX != null) ? document.elementFromPoint(d.lastClientX, d.lastClientY) : null
      var dropTarget = dropEl && dropEl.closest ? dropEl.closest('[data-loc-target]') : null
      if (dropTarget) {
        var targetLoc = dropTarget.getAttribute('data-loc-target')
        patch.location = targetLoc
        var memberCount = targetLoc ? locationMembers(targetLoc).length : 0
        patch.dx = 60 + (memberCount % 4) * 260
        patch.dy = 60 + Math.floor(memberCount / 4) * 220
      } else {
        eqShiftDx = dp.x - d.origX
        eqShiftDy = dp.y - d.origY
        if (!activeLocation) {
          var cx = dp.x + (d.origW || 200) / 2, cy = dp.y + (d.origH || 110) / 2
          for (var i = 0; i < siteLocations.length; i++) {
            var r = locationRect(siteLocations[i], i)
            if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) { patch.location = siteLocations[i].name; break }
          }
        }
      }
      if (props.onUpdatePanelLayout) props.onUpdatePanelLayout(d.id, patch)
      // Carry equipment with an explicit (individually-dragged-before) position
      // along by the same delta the panel just moved, so it doesn't get left
      // behind with an elastically-stretched wire. Equipment still on the
      // auto-layout fallback already tracks the panel for free.
      if (Math.abs(eqShiftDx) > 0.5 || Math.abs(eqShiftDy) > 0.5) {
        var eqsToShift = equipmentMap[d.id] || []
        if (eqsToShift.some(function(e) { return typeof e.ex === 'number' }) && props.onUpdateEquipment) {
          props.onUpdateEquipment(d.id, eqsToShift.map(function(e) {
            return (typeof e.ex === 'number') ? Object.assign({}, e, { ex: e.ex + eqShiftDx, ey: e.ey + eqShiftDy }) : e
          }))
        }
      }
    } else if (d.kind === 'equipment') {
      var existing2 = equipmentMap[d.panelId] || []
      if (props.onUpdateEquipment) props.onUpdateEquipment(d.panelId, existing2.map(function(eq) { return eq.id === d.id ? Object.assign({}, eq, { ex: dp.x, ey: dp.y }) : eq }))
    } else if (d.kind === 'note') {
      commitNotes(notes.map(function(n) { return n.id === d.id ? Object.assign({}, n, { x: dp.x, y: dp.y }) : n }))
    } else if (d.kind === 'location') {
      commitLocations(upsertLocationByName(d.id, { dx: dp.x, dy: dp.y }))
    }
  }

  // ─── Rail width resize (local-only, not part of the drag/undo system) ───
  function startRailResize(e) {
    e.stopPropagation()
    railDragRef.current = { startX: e.clientX, origW: railWidth }
    e.target.setPointerCapture(e.pointerId)
  }
  function onRailResizeMove(e) {
    if (!railDragRef.current) return
    var nw = Math.max(RAIL_MIN, Math.min(RAIL_MAX, railDragRef.current.origW + (e.clientX - railDragRef.current.startX)))
    setRailWidth(nw)
  }
  function onRailResizeUp() { railDragRef.current = null }

  // ─── Library actions ───
  function createDdc() {
    var name = newDdcName.trim()
    if (!name || !props.onCreatePanel) return
    var idx = panels.length
    var pos = { x: 60 + (idx % 4) * 260, y: 60 + Math.floor(idx / 4) * 220 }
    props.onCreatePanel({ id: panelId(), name: up(name), location: activeLocation || '', floor: '', dx: pos.x, dy: pos.y })
    setNewDdcName('')
  }

  function createLocation() {
    var name = newLocName.trim()
    if (!name) return
    if (siteLocations.some(function(l) { return up(l.name) === up(name) })) { setNewLocName(''); return }
    var idx = locations.length
    var pos = locationPos(idx)
    commitLocations(locations.concat([{ id: locId(), name: up(name), dx: pos.x, dy: pos.y, w: 240, h: 120 }]))
    setNewLocName('')
  }

  function deleteLocation(name) {
    if (!window.confirm('DELETE LOCATION ' + name + '? DDCS INSIDE WILL BECOME UNASSIGNED.')) return
    if (props.onUnassignLocation) props.onUnassignLocation(name)
    commitLocations(locations.filter(function(l) { return up(l.name) !== up(name) }))
  }

  function goToLocation(name) { setSelected(null); setActiveLocation(name) }
  function goToSite() { setSelected(null); setActiveLocation(null) }

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
  }

  function renameEquipment(panelId_, eqId, curName) {
    var val = window.prompt('EQUIPMENT NAME:', curName)
    if (!val || !val.trim() || up(val) === up(curName)) return
    var existing = equipmentMap[panelId_] || []
    if (props.onUpdateEquipment) props.onUpdateEquipment(panelId_, existing.map(function(e) { return e.id === eqId ? Object.assign({}, e, { name: up(val) }) : e }))
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

      {/* ─── Side rail — always visible at md+, an off-canvas drawer below md, resizable width ─── */}
      <div style={{ width: railWidth }} className={'shrink-0 border-r border-border bg-card flex flex-col overflow-y-auto fixed inset-y-0 left-0 z-40 relative transition-transform duration-200 md:static md:translate-x-0 ' + (railOpen ? 'translate-x-0' : '-translate-x-full')}>
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="text-sm font-bold text-white">DDC GROUPING CANVAS</div>
          <button onClick={props.onClose} className="text-[11px] text-dgray hover:text-white px-2 py-1">✕ CLOSE</button>
        </div>

        <div className="border-b border-border">
          <button onClick={function() { setLibOpen(Object.assign({}, libOpen, { loc: !libOpen.loc })) }} className="w-full text-left px-3 py-2 text-[11px] font-bold text-orange flex items-center justify-between">
            <span>LOCATIONS ({siteLocations.length})</span><span>{libOpen.loc ? '▾' : '▸'}</span>
          </button>
          {libOpen.loc && (
            <div className="px-3 pb-3 space-y-2">
              <div className="flex gap-1.5">
                <input value={newLocName} onChange={function(e) { setNewLocName(e.target.value) }}
                  onKeyDown={function(e) { if (e.key === 'Enter') createLocation() }}
                  placeholder="NEW LOCATION NAME" style={{ textTransform: 'uppercase' }}
                  className="flex-1 bg-navy border border-border rounded px-2 py-1 text-[11px] text-white outline-none focus:border-orange" />
                <button onClick={createLocation} disabled={!newLocName.trim()} className="px-2 py-1 bg-orange text-navy text-[10px] font-bold rounded disabled:opacity-40">+ ADD</button>
              </div>
              <div className="flex flex-wrap gap-1">
                <span data-loc-target="" title="DRAG A DDC HERE TO UNASSIGN IT" className="text-[9px] px-2 py-1 rounded bg-navy border border-dgray/40 text-dgray/70">UNASSIGNED</span>
                {siteLocations.map(function(l) {
                  return <button key={l.name} data-loc-target={l.name} onClick={function() { goToLocation(l.name) }} title={'CLICK TO OPEN · DRAG A DDC HERE TO MOVE IT IN'} className="text-[9px] px-2 py-1 rounded bg-card2 text-dgray hover:text-orange">{l.name}</button>
                })}
              </div>
            </div>
          )}
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
                  return <span key={p.id} className="text-[9px] px-2 py-1 rounded bg-card2 text-dgray">{p.name}{p.location ? ' · ' + p.location : ''}</span>
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
          DRAG A DDC ONTO A LOCATION (SITE VIEW) OR ONTO A LOCATION PILL ABOVE (ANY VIEW) TO GROUP IT — DROP ON UNASSIGNED TO UNGROUP. CLICK AN EQUIPMENT BLOCK TO SELECT, THEN CLICK A DDC TO WIRE IT — DOUBLE-CLICK A WIRED UNIT TO RENAME IT. DRAG BLOCKS TO ARRANGE, DRAG THE CORNER TO RESIZE. DRAG THIS PANEL'S RIGHT EDGE TO RESIZE IT.
        </div>
        {/* Rail width resize handle */}
        <div onPointerDown={startRailResize} onPointerMove={onRailResizeMove} onPointerUp={onRailResizeUp}
          style={{ position: 'absolute', top: 0, right: -3, bottom: 0, width: 6, cursor: 'ew-resize', touchAction: 'none' }} />
      </div>

      {/* ─── Canvas ─── */}
      <div className="flex-1 relative flex flex-col min-w-0">
        {/* Annotation toolbar */}
        <div className="flex items-center gap-3 flex-wrap px-3 py-1.5 border-b border-border bg-card z-10">
          <button onClick={function() { setRailOpen(true) }} className="md:hidden px-2.5 py-1 rounded text-[9px] font-bold uppercase bg-card2 text-dgray hover:text-white">☰ LIBRARY</button>
          {activeLocation && (
            <button onClick={goToSite} className="px-2.5 py-1 rounded text-[9px] font-bold uppercase bg-orange/20 text-orange hover:bg-orange/30">← BACK TO SITE</button>
          )}
          {activeLocation && <div className="text-[10px] font-bold text-white">{activeLocation}</div>}
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
              {visiblePanels.map(function(panel, idx) {
                var pr = panelRect(panel, idx)
                var eqs = equipmentMap[panel.id] || []
                var fd = panelFollowDelta(panel, idx, pr)
                return eqs.map(function(eq, i) {
                  var er = equipRect(eq, pr, i)
                  var ex = er.x + fd.dx, ey = er.y + fd.dy
                  return <line key={panel.id + '-' + eq.id} x1={pr.x + pr.w / 2} y1={pr.y + pr.h / 2} x2={ex + er.w / 2} y2={ey + er.h / 2} stroke={fd.dx || fd.dy ? 'rgba(255,255,255,0.7)' : 'rgba(45,212,191,0.5)'} strokeWidth={2} />
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

            {/* ─── Location hub blocks (site view only) ─── */}
            {!activeLocation && siteLocations.map(function(loc, idx) {
              var lr = locationRect(loc, idx)
              var members = locationMembers(loc.name)
              var allEqs = []
              members.forEach(function(p) { allEqs = allEqs.concat(equipmentMap[p.id] || []) })
              var totals = pointTotals(allEqs)
              return (
                <div key={loc.name}
                  role="button" tabIndex={0} aria-label={'LOCATION BLOCK ' + loc.name}
                  onPointerDown={function(e) { startDrag({ kind: 'location', mode: 'move', id: loc.name, origX: lr.x, origY: lr.y, origW: lr.w, origH: lr.h }, e) }}
                  onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                  onClick={function() { if (!dragRef.current || !dragRef.current.moved) goToLocation(loc.name) }}
                  style={{ position: 'absolute', left: lr.x, top: lr.y, width: lr.w, height: lr.h, touchAction: 'none', overflow: 'hidden' }}
                  className="rounded-lg border-2 border-orange bg-orange/10 p-2.5 cursor-pointer select-none shadow-lg">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[12px] font-bold text-white truncate">{loc.name}</div>
                    <button onPointerDown={function(e) { e.stopPropagation() }}
                      onClick={function(e) { e.stopPropagation(); deleteLocation(loc.name) }}
                      className="text-[9px] text-red/50 hover:text-red">✕</button>
                  </div>
                  <div className="text-[9px] text-dgray">{members.length} DDC{members.length === 1 ? '' : 'S'}</div>
                  <div className="flex gap-1 flex-wrap mt-1">
                    {['DI', 'DO', 'AI', 'AO'].map(function(k) {
                      return totals[k] > 0 ? <span key={k} className="text-[8px] px-1 py-0.5 rounded bg-card2 text-orange">{k} {totals[k]}</span> : null
                    })}
                  </div>
                  <div className="text-[8px] text-dgray/70 mt-1">CLICK TO OPEN</div>
                  <ResizeHandle info={{ kind: 'location', id: loc.name, origW: lr.w, origH: lr.h }} />
                </div>
              )
            })}

            {visiblePanels.map(function(panel, idx) {
              var pr = panelRect(panel, idx)
              var eqs = equipmentMap[panel.id] || []
              var totals = pointTotals(eqs)
              var fd = panelFollowDelta(panel, idx, pr)
              var isDraggingThis = !!(fd.dx || fd.dy)
              return (
                <div key={panel.id}>
                  <div
                    role="button" tabIndex={0} aria-label={'DDC BLOCK ' + panel.name}
                    onPointerDown={function(e) { startDrag({ kind: 'panel', mode: 'move', id: panel.id, origX: pr.x, origY: pr.y, origW: pr.w, origH: pr.h }, e) }}
                    onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                    onClick={function() { if (!dragRef.current || !dragRef.current.moved) clickDdc(panel) }}
                    style={{ position: 'absolute', left: pr.x, top: pr.y, width: pr.w, height: pr.h, touchAction: 'none', overflow: 'hidden' }}
                    className={'rounded-lg border-2 p-2.5 cursor-pointer select-none shadow-lg ' + (isDraggingThis ? 'border-white bg-card2 shadow-2xl ring-2 ring-white/40' : selected ? 'border-teal bg-teal/10' : 'border-cyan bg-card')}>
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
                    <input
                      key={panel.id + '-room'}
                      defaultValue={panel.room || ''}
                      onClick={function(e) { e.stopPropagation() }}
                      onPointerDown={function(e) { e.stopPropagation() }}
                      onBlur={function(e) { var v = up(e.target.value); if (v !== (panel.room || '') && props.onUpdatePanelLayout) props.onUpdatePanelLayout(panel.id, { room: v }) }}
                      placeholder="ROOM NAME" style={{ textTransform: 'uppercase' }}
                      className="mt-1 w-full bg-navy border border-border rounded text-[8px] text-dgray px-1 py-0.5 outline-none focus:border-cyan" />
                    <ResizeHandle info={{ kind: 'panel', id: panel.id, origW: pr.w, origH: pr.h }} />
                  </div>
                  {eqs.map(function(eq, i) {
                    var er0 = equipRect(eq, pr, i)
                    var er = isDraggingThis ? { x: er0.x + fd.dx, y: er0.y + fd.dy, w: er0.w, h: er0.h } : er0
                    return (
                      <div key={eq.id}
                        role="button" tabIndex={0} aria-label={'CONNECTED UNIT ' + eq.name}
                        onPointerDown={function(e) { startDrag({ kind: 'equipment', mode: 'move', id: eq.id, panelId: panel.id, origX: er0.x, origY: er0.y, origW: er0.w, origH: er0.h }, e) }}
                        onPointerMove={onBlockPointerMove} onPointerUp={onBlockPointerUp}
                        onDoubleClick={function(e) { e.stopPropagation(); renameEquipment(panel.id, eq.id, eq.name) }}
                        style={{ position: 'absolute', left: er.x, top: er.y, width: er.w, height: er.h, touchAction: 'none', overflow: 'hidden' }}
                        className={'rounded border px-2 py-1 cursor-pointer select-none ' + (isDraggingThis ? 'border-white/70 bg-card2 shadow-md' : 'border-teal/60 bg-card2')} title="DOUBLE-CLICK TO RENAME">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-white truncate">{eq.name}</span>
                          <button onPointerDown={function(e) { e.stopPropagation() }} onClick={function(e) { e.stopPropagation(); disconnect(panel.id, eq.id) }} className="text-[8px] text-red/50 hover:text-red ml-1">✕</button>
                        </div>
                        <ResizeHandle info={{ kind: 'equipment', id: eq.id, panelId: panel.id, origW: er.w, origH: er.h }} />
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
              var nr = noteRect(n)
              return (
                <div key={n.id} style={{ position: 'absolute', left: nr.x, top: nr.y, width: 150 }} className="rounded shadow-lg overflow-hidden">
                  <div
                    onPointerDown={function(e) { startDrag({ kind: 'note', mode: 'move', id: n.id, origX: nr.x, origY: nr.y }, e) }}
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
