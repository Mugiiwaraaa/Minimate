/* --- ReportsPage.jsx --- R1 v2: KPI dashboard + configurable progress report ---
   - Sections toggle on/off and AUTO-NUMBER themselves.
   - WORK PROGRESS TABLE: engineer-defined activity lines (corporate format).
     AUTO rows pull Workdone live from device stages; MANUAL rows (cable
     meters, point termination…) are typed. Design = contract qty, editable.
   - AREA-WISE PROGRESS: location groups collapsible under their floors.
   - EXPORT PDF via print stylesheet; EXPORT EXCEL via SheetJS. */

import { useState, useEffect } from 'react'
import { fetchSnapshots, computeForecast, countStages } from '../lib/reportStore'

var STAGES = [
  { k: 'comm_cable', c: 'comm', label: 'COMM CABLE' },
  { k: 'control_cable', c: 'ctrl', label: 'CTRL CABLE' },
  { k: 'continuity', c: 'cont', label: 'CONTINUITY' },
  { k: 'termination', c: 'term', label: 'TERMINATION' },
  { k: 'device_installed', c: 'inst', label: 'INSTALLED' },
  { k: 'address_set', c: 'addr', label: 'ADDRESSED' }
]

var SECTION_DEFS = [
  { key: 'summary', label: 'EXECUTIVE SUMMARY' },
  { key: 'workTable', label: 'WORK PROGRESS TABLE' },
  { key: 'pipeline', label: 'COMMISSIONING PIPELINE' },
  { key: 'areas', label: 'AREA-WISE PROGRESS' },
  { key: 'ddcSchedule', label: 'DDC PANEL SCHEDULE', defaultOff: true },
  { key: 'gateways', label: 'GATEWAY / RTR SUMMARY' },
  { key: 'loopsReg', label: 'LOOP REGISTER' },
  { key: 'blockers', label: 'BLOCKERS / SITE CONSTRAINTS' },
  { key: 'wir', label: 'INSPECTION-READY' },
  { key: 'commReg', label: 'COMMISSIONING REGISTER (PER DEVICE)', defaultOff: true },
  { key: 'trend', label: 'TREND & FORECAST' },
  { key: 'notes', label: 'NOTES' }
]

// Report-type presets: one click flips the whole section set.
// INSTALLATION reports = quantities over time; COMMISSIONING = asset status.
var PRESETS = {
  'WEEKLY PROGRESS': ['summary', 'workTable', 'pipeline', 'areas', 'trend', 'blockers', 'notes'],
  'DDC SCHEDULE': ['ddcSchedule', 'notes'],
  'COMMISSIONING': ['summary', 'loopsReg', 'wir', 'commReg', 'blockers', 'notes'],
  'FULL REPORT': SECTION_DEFS.map(function(s) { return s.key })
}

// Suggested title per report type — auto-fills cfg.reportTitle on preset click
// (only while the engineer hasn't manually overridden it; see titleTouched).
var PRESET_TITLES = {
  'WEEKLY PROGRESS': 'BMS COMMISSIONING PROGRESS REPORT',
  'DDC SCHEDULE': 'DDC PANEL SCHEDULE',
  'COMMISSIONING': 'COMMISSIONING STATUS REPORT',
  'FULL REPORT': 'BMS COMMISSIONING REPORT'
}
var DEFAULT_TITLE = 'BMS COMMISSIONING PROGRESS REPORT'

// Column customization per table (saved in cfg.cols[table]): engineer can
// hide/show, resize S/M/L, no-wrap, and add free-text columns. SR / activity
// label / panel name stay always-visible except where listed below.
var WORK_COLS = [
  { key: 'unit', label: 'UNIT' },
  { key: 'teams', label: 'TEAMS' },
  { key: 'design', label: 'DESIGN' },
  { key: 'floors', label: 'PER-FLOOR' },
  { key: 'workdone', label: 'WORKDONE' },
  { key: 'balance', label: 'BALANCE' },
  { key: 'progress', label: 'PROGRESS %' },
  { key: 'remark', label: 'REMARK' }
]
var DDC_COLS = [
  { key: 'level', label: 'LEVEL' },
  { key: 'zone', label: 'ZONE' },
  { key: 'part', label: 'PART' },
  { key: 'panelName', label: 'PANEL NAME' },
  { key: 'location', label: 'LOCATION' },
  { key: 'canopy', label: 'CANOPY' },
  { key: 'ddcInstall', label: 'DDC INSTALL' },
  { key: 'cablePulling', label: 'CABLE PULLING' },
  { key: 'panelTerm', label: 'PANEL TERM' },
  { key: 'functionalTest', label: 'FUNC TEST' },
  { key: 'inspections', label: 'INSPECTIONS' },
  { key: 'remarks', label: 'REMARKS' }
]
// Default column order (SR / S-N fixed leftmost; custom col ids appended)
var WORK_ORDER = ['label', 'unit', 'teams', 'design', 'floors', 'workdone', 'balance', 'progress', 'remark']
var DDC_ORDER = ['level', 'zone', 'part', 'panelName', 'location', 'canopy', 'ddcInstall', 'cablePulling', 'panelTerm', 'functionalTest', 'inspections', 'remarks']

var CANOPY_OPTS = ['N/A', 'REQUIRED', 'DONE']

var stageWeights = { comm_cable: 25, control_cable: 25, continuity: 10, termination: 25, device_installed: 15, address_set: 0 }

// Panel IO point stages (PanelDetail checklists) — reportable quantities
var IO_STAGES = [
  { k: 'cable_pulled', label: 'CABLE PULLED' },
  { k: 'cable_continuity', label: 'CONTINUITY' },
  { k: 'term_ddc_side', label: 'TERM DDC SIDE' },
  { k: 'term_field_side', label: 'TERM FIELD SIDE' },
  { k: 'functional_test', label: 'FUNCTIONAL TEST' }
]

function up(v) { return (v || '').toUpperCase() }
function upKeep(v) { return (v || '').toUpperCase() } // no trim: safe for controlled onChange

function weightedPct(devs) {
  if (!devs || devs.length === 0) return 0
  var total = 0
  devs.forEach(function(d) {
    STAGES.forEach(function(s) { if (d[s.k]) total += stageWeights[s.k] })
  })
  return Math.round(total / devs.length)
}

function fmtDate(d) {
  if (!d) return '-'
  var dt = typeof d === 'string' ? new Date(d) : d
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
}

var wiCounter = 0
function wid() { wiCounter++; return 'wi-' + Date.now() + '-' + wiCounter }

export default function ReportsPage(props) {
  // props: projectId, projectName, projectClient, loops, areas, blockers,
  //        gateways, config, onConfig(newConfig)
  var loops = props.loops || []
  var areas = props.areas || []
  var blockers = props.blockers || []
  var gateways = props.gateways || []
  var panels = props.panels || []
  var equipmentMap = props.equipmentMap || {}

  var cfg = Object.assign({
    reportNo: '', periodFrom: '', periodTo: '', contractor: '', client: props.projectClient || '',
    preparedBy: '', notes: '', sections: {}, workItems: null,
    reportTitle: DEFAULT_TITLE, titleTouched: false
  }, props.config || {})
  var sections = Object.assign({}, cfg.sections)
  function sectionOn(key) {
    var def = SECTION_DEFS.find(function(s) { return s.key === key })
    if (def && def.defaultOff) return sections[key] === true // long registers: opt-in
    return sections[key] !== false // everything else: default ON
  }

  var snapsState = useState([])
  var snapshots = snapsState[0]
  var setSnapshots = snapsState[1]
  var editWorkState = useState(false)
  var editWork = editWorkState[0]
  var setEditWork = editWorkState[1]
  var collapsedState = useState({})
  var collapsed = collapsedState[0]
  var setCollapsed = collapsedState[1]
  var editDdcState = useState(false)
  var editDdc = editDdcState[0]
  var setEditDdc = editDdcState[1]
  var resizeState = useState(null)
  var resize = resizeState[0]
  var setResize = resizeState[1]
  var colDragState = useState(null)
  var colDrag = colDragState[0]
  var setColDrag = colDragState[1]
  var rowDragState = useState(null)
  var rowDrag = rowDragState[0]
  var setRowDrag = rowDragState[1]
  var ddcMode = cfg.ddcView === 'install' ? 'install' : 'commission'

  useEffect(function() {
    if (!props.projectId) return
    fetchSnapshots(props.projectId, function(err, data) {
      if (!err) setSnapshots(data || [])
    })
  }, [props.projectId])

  function setCfg(field, value) {
    var next = Object.assign({}, cfg)
    next[field] = value
    props.onConfig(next)
  }
  function setCfgMulti(obj) { props.onConfig(Object.assign({}, cfg, obj)) }

  // ── Column customization ──────────────────────────────────
  function colCfg(tbl) { return (cfg.cols && cfg.cols[tbl]) || {} }
  function colOn(tbl, key) { var h = colCfg(tbl).hide || {}; return !h[key] }
  function colWrap(tbl, key) { var n = colCfg(tbl).nowrap || {}; return n[key] ? ' whitespace-nowrap' : '' }
  function colStyle(tbl, key) {
    var live = (resize && resize.tbl === tbl && resize.key === key) ? resize.w : null
    var px = live != null ? live : (colCfg(tbl).px || {})[key]
    if (px) return { width: px + 'px', minWidth: px + 'px', maxWidth: px + 'px' }
    return undefined
  }
  function customCols(tbl) { return colCfg(tbl).custom || [] }
  function setColPart(tbl, kind, key, value) {
    var cols = Object.assign({}, cfg.cols || {})
    var t = Object.assign({ hide: {}, w: {}, nowrap: {}, custom: [] }, cols[tbl] || {})
    var g = Object.assign({}, t[kind] || {})
    if (value === undefined) { delete g[key] } else { g[key] = value }
    t[kind] = g
    cols[tbl] = t
    setCfg('cols', cols)
  }
  function toggleColHide(tbl, key) { setColPart(tbl, 'hide', key, colOn(tbl, key) ? true : undefined) }
  function toggleColWrap(tbl, key) { var n = (colCfg(tbl).nowrap || {})[key]; setColPart(tbl, 'nowrap', key, n ? undefined : true) }
  function onResizeDown(tbl, key, e) {
    e.preventDefault(); e.stopPropagation()
    var th = e.currentTarget.parentNode
    var startW = (colCfg(tbl).px || {})[key] || (th && th.offsetWidth) || 120
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
    setResize({ tbl: tbl, key: key, startX: e.clientX, startW: startW, w: startW })
  }
  function onResizeMove(e) {
    if (!resize) return
    var w = Math.max(40, resize.startW + (e.clientX - resize.startX))
    setResize(Object.assign({}, resize, { w: w }))
  }
  function onResizeUp(e) {
    if (!resize) return
    setColPart(resize.tbl, 'px', resize.key, Math.round(resize.w))
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (err) {}
    setResize(null)
  }
  function grow(el) { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' } }
  function thc(tbl, key, label, extra, rk) {
    var editing = tbl === 'work' ? editWork : editDdc
    var over = colDrag && colDrag.tbl === tbl && colDrag.overKey === key && colDrag.key !== key
    return (
      <th key={rk || key} data-colkey={key} data-coltbl={tbl} onPointerDown={function(e) { startColDrag(tbl, key, e) }} onPointerMove={colDragMove} onPointerUp={colDragUp} className={thCls + (extra || '') + colWrap(tbl, key) + ' relative' + (editing ? ' cursor-move select-none' : '') + (over ? ' bg-teal/25' : '')} style={colStyle(tbl, key)}>
        {editing && <span className="text-dgray mr-1 no-print">⠿</span>}{label}
        <span onPointerDown={function(e) { onResizeDown(tbl, key, e) }} onPointerMove={onResizeMove} onPointerUp={onResizeUp} className="absolute top-0 right-0 h-full w-2 cursor-col-resize hover:bg-teal/50 no-print" style={{ touchAction: 'none' }}></span>
      </th>
    )
  }

  // ── Column order + drag-reorder ───────────────────────────
  function baseKeys(tbl) { return tbl === 'work' ? WORK_ORDER : DDC_ORDER }
  function customById(tbl, k) { var l = customCols(tbl); for (var i = 0; i < l.length; i++) { if (l[i].id === k) return l[i] } return null }
  function pctColor(p) { return p >= 100 ? 'text-green' : (p >= 67 ? 'text-teal' : (p >= 34 ? 'text-orange' : 'text-red')) }
  function customField(cc, cur, onVal) {
    var ty = cc.type || 'text'
    if (ty === 'checkbox') {
      var on = cur === true || cur === 'true' || cur === 1 || cur === '1'
      return <button onClick={function() { onVal(!on) }} className={'w-5 h-5 rounded border text-[10px] font-bold transition ' + (on ? 'bg-green border-green text-white rpt-fill' : 'border-border text-dgray hover:border-teal')}>{on ? '✓' : ''}</button>
    }
    if (ty === 'number') return <input value={cur === undefined || cur === null ? '' : cur} onChange={function(e) { onVal(e.target.value.replace(/[^0-9.\-]/g, '')) }} placeholder="0" className={inCls + ' w-16 text-[11px] text-white text-center'} />
    return <input value={cur || ''} onChange={function(e) { onVal(up(e.target.value)) }} placeholder="" className={inCls + ' w-full text-[10px] text-lgray'} />
  }
  function orderedKeys(tbl) {
    var base = baseKeys(tbl).concat(customCols(tbl).map(function(c) { return c.id }))
    var saved = colCfg(tbl).order
    if (!saved) return base
    var out = []
    saved.forEach(function(k) { if (base.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k) })
    base.forEach(function(k) { if (out.indexOf(k) < 0) out.push(k) })
    return out
  }
  function setColMeta(tbl, field, val) {
    var cols = Object.assign({}, cfg.cols || {})
    var t = Object.assign({ hide: {}, w: {}, nowrap: {}, custom: [] }, cols[tbl] || {})
    t[field] = val
    cols[tbl] = t
    setCfg('cols', cols)
  }
  function moveColumn(tbl, key, beforeKey) {
    var ord = orderedKeys(tbl).slice()
    var from = ord.indexOf(key)
    if (from < 0) return
    ord.splice(from, 1)
    var to = ord.indexOf(beforeKey)
    if (to < 0) to = ord.length
    ord.splice(to, 0, key)
    setColMeta(tbl, 'order', ord)
  }
  function startColDrag(tbl, key, e) {
    var editing = tbl === 'work' ? editWork : editDdc
    if (!editing) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
    setColDrag({ tbl: tbl, key: key, overKey: key })
  }
  function colDragMove(e) {
    if (!colDrag) return
    var el = document.elementFromPoint(e.clientX, e.clientY)
    var th = el && el.closest ? el.closest('[data-colkey]') : null
    if (th) {
      var k = th.getAttribute('data-colkey')
      var t = th.getAttribute('data-coltbl')
      if (t === colDrag.tbl && k && k !== colDrag.overKey) setColDrag(Object.assign({}, colDrag, { overKey: k }))
    }
  }
  function colDragUp(e) {
    if (!colDrag) return
    var d = colDrag
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (err) {}
    setColDrag(null)
    if (d.overKey && d.overKey !== d.key) moveColumn(d.tbl, d.key, d.overKey)
  }

  // ── Row drag-reorder ──────────────────────────────────────
  function startRowDrag(tbl, id, e) {
    e.preventDefault(); e.stopPropagation()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
    setRowDrag({ tbl: tbl, id: id, overId: id })
  }
  function rowDragMove(e) {
    if (!rowDrag) return
    var el = document.elementFromPoint(e.clientX, e.clientY)
    var tr = el && el.closest ? el.closest('[data-rowid]') : null
    if (tr) {
      var id = tr.getAttribute('data-rowid')
      var t = tr.getAttribute('data-rowtbl')
      if (t === rowDrag.tbl && id && id !== rowDrag.overId) setRowDrag(Object.assign({}, rowDrag, { overId: id }))
    }
  }
  function rowDragUp(e) {
    if (!rowDrag) return
    var d = rowDrag
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (err) {}
    setRowDrag(null)
    if (d.overId && d.overId !== d.id) moveRow(d.tbl, d.id, d.overId)
  }
  function moveRow(tbl, id, beforeId) {
    if (tbl === 'work') {
      var arr = workItems.slice()
      var from = arr.findIndex(function(w) { return w.id === id })
      if (from < 0) return
      var it = arr.splice(from, 1)[0]
      var to = arr.findIndex(function(w) { return w.id === beforeId })
      if (to < 0) to = arr.length
      arr.splice(to, 0, it)
      setWorkItems(arr)
    } else {
      var ids = schedPanels.map(function(p) { return p.id })
      var f2 = ids.indexOf(id)
      if (f2 < 0) return
      ids.splice(f2, 1)
      var t2 = ids.indexOf(beforeId)
      if (t2 < 0) t2 = ids.length
      ids.splice(t2, 0, id)
      setColMeta('ddc', 'rowOrder', ids)
    }
  }

  // ── Data-driven header + body cell renderers ──────────────
  function workHeadMeta(k) { return { label: { l: 'DEVICES / ACTIVITY' }, unit: { l: 'UNIT' }, teams: { l: 'TEAMS' }, design: { l: 'DESIGN', x: ' text-center' }, workdone: { l: 'WORKDONE', x: ' text-center' }, balance: { l: 'BALANCE', x: ' text-center' }, progress: { l: 'PROGRESS %' }, remark: { l: 'REMARK' } }[k] }
  function workHead(k) {
    if (k === 'floors') return colOn('work', 'floors') ? floorOrder.map(function(f) { return thc('work', 'floors', f, ' text-center', f) }) : null
    var cc = customById('work', k)
    if (cc) return thc('work', cc.id, cc.label, '')
    if (!colOn('work', k)) return null
    var m = workHeadMeta(k)
    if (!m) return null
    return thc('work', k, m.l, m.x || '')
  }
  function workCell(k, it, r) {
    if (k === 'label') return (
      <td key="label" className={tdCls} style={colStyle('work', 'label')}>
        {editWork ? <input value={it.label} onChange={function(e) { updItem(it.id, { label: up(e.target.value) }) }} className={inCls + ' w-full text-[11px] text-white'} /> : it.label}
        {editWork && it.kind === 'auto' && (
          <div className="flex gap-1 mt-0.5 no-print">
            <select value={it.deviceType} onChange={function(e) { updItem(it.id, { deviceType: e.target.value }) }} className="bg-navy border border-border rounded px-1 py-0.5 text-[8px] text-teal uppercase outline-none">{typeOrder.map(function(t) { return <option key={t} value={t}>{t}</option> })}</select>
            <select value={it.stage} onChange={function(e) { updItem(it.id, { stage: e.target.value }) }} className="bg-navy border border-border rounded px-1 py-0.5 text-[8px] text-teal uppercase outline-none">{STAGES.map(function(s) { return <option key={s.k} value={s.k}>{s.label}</option> })}</select>
          </div>
        )}
        {editWork && it.kind === 'io' && (
          <div className="flex gap-1 mt-0.5 no-print">
            <span className="px-1 py-0.5 text-[8px] text-cyan uppercase font-bold">IO POINTS ×</span>
            <select value={it.stage} onChange={function(e) { updItem(it.id, { stage: e.target.value }) }} className="bg-navy border border-border rounded px-1 py-0.5 text-[8px] text-cyan uppercase outline-none">{IO_STAGES.map(function(s) { return <option key={s.k} value={s.k}>{s.label}</option> })}</select>
          </div>
        )}
      </td>
    )
    if (k === 'unit') return colOn('work', 'unit') ? <td key="unit" className={tdCls + ' text-dgray' + colWrap('work', 'unit')} style={colStyle('work', 'unit')}>{editWork ? <input value={it.unit} onChange={function(e) { updItem(it.id, { unit: up(e.target.value) }) }} className={inCls + ' w-16 text-[11px] text-dgray'} /> : it.unit}</td> : null
    if (k === 'teams') return colOn('work', 'teams') ? <td key="teams" className={tdCls + colWrap('work', 'teams')} style={colStyle('work', 'teams')}><input value={it.teams || ''} onChange={function(e) { updItem(it.id, { teams: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-16 text-[11px] text-lgray'} /></td> : null
    if (k === 'design') return colOn('work', 'design') ? <td key="design" className={tdCls + ' text-center' + colWrap('work', 'design')} style={colStyle('work', 'design')}><input value={it.design === null || it.design === undefined ? '' : it.design} onChange={function(e) { updItem(it.id, { design: e.target.value === '' ? null : e.target.value.replace(/[^0-9]/g, '') }) }} placeholder={it.kind === 'manual' ? '0' : String(r.liveDesign)} className={inCls + ' w-14 text-center text-[11px] text-white'} /></td> : null
    if (k === 'floors') return colOn('work', 'floors') ? r.perFloor.map(function(n, fi) { return <td key={'fl' + fi} className={tdCls + ' text-center text-dgray' + colWrap('work', 'floors')} style={colStyle('work', 'floors')}>{n === null ? '' : (n || '')}</td> }) : null
    if (k === 'workdone') return colOn('work', 'workdone') ? (<td key="workdone" className={tdCls + ' text-center font-bold text-green'}>{it.kind === 'manual' ? <input value={it.done || ''} onChange={function(e) { updItem(it.id, { done: e.target.value.replace(/[^0-9]/g, '') }) }} placeholder="0" className={inCls + ' w-14 text-center text-[11px] text-green font-bold'} /> : r.done}</td>) : null
    if (k === 'balance') return colOn('work', 'balance') ? <td key="balance" className={tdCls + ' text-center font-bold ' + (r.balance > 0 ? 'text-orange' : 'text-green')}>{r.balance}</td> : null
    if (k === 'progress') { if (!colOn('work', 'progress')) return null; var pv = r.design > 0 ? Math.round(r.done / r.design * 100) : (r.done > 0 ? 100 : 0); return (<td key="progress" className={tdCls} style={colStyle('work', 'progress')}><div className="flex items-center gap-1.5"><span className={'text-[10px] font-bold w-8 text-right ' + pctColor(pv)}>{pv}%</span><div className="flex-1 min-w-[28px]">{bar(pv)}</div></div></td>) }
    if (k === 'remark') return colOn('work', 'remark') ? <td key="remark" className={tdCls} style={colStyle('work', 'remark')}><textarea ref={grow} onInput={function(e) { grow(e.target) }} rows={1} value={it.remark || ''} onChange={function(e) { updItem(it.id, { remark: up(e.target.value) }) }} placeholder="" className={inCls + ' w-full text-[10px] text-orange italic resize-none overflow-hidden leading-snug bg-transparent align-top'} /></td> : null
    var cc = customById('work', k)
    if (cc) { var cv = (it.custom && it.custom[cc.id]); return <td key={cc.id} className={tdCls + (cc.type === 'checkbox' ? ' text-center' : '')} style={colStyle('work', cc.id)}>{customField(cc, cv, function(val) { var o = Object.assign({}, it.custom || {}); o[cc.id] = val; updItem(it.id, { custom: o }) })}</td> }
    return null
  }
  function ddcHeadMeta(k) { return { level: { l: 'LEVEL' }, zone: { l: 'ZONE' }, part: { l: 'PART' }, panelName: { l: 'PANEL NAME' }, location: { l: 'LOCATION' }, canopy: { l: 'CANOPY', x: ' text-center' }, ddcInstall: { l: 'DDC INSTALLATION', x: ' text-center' }, cablePulling: { l: 'CABLE PULLING', x: ' text-center' }, panelTerm: { l: 'PANEL TERMINATION', x: ' text-center' }, functionalTest: { l: 'FUNCTIONAL TEST', x: ' text-center' }, inspections: { l: 'INSPECTIONS' }, remarks: { l: 'REMARKS' } }[k] }
  function ddcHead(k) {
    var cc = customById('ddc', k)
    if (cc) return thc('ddc', cc.id, cc.label, '')
    if (!colOn('ddc', k)) return null
    var m = ddcHeadMeta(k)
    if (!m) return null
    return thc('ddc', k, m.l, m.x || '')
  }
  function ddcCell(k, p, showLvl, lvl) {
    if (k === 'level') return colOn('ddc', 'level') ? <td key="level" className={tdCls + ' font-bold text-orange' + colWrap('ddc', 'level')} style={colStyle('ddc', 'level')}>{showLvl ? (lvl || '-') : ''}</td> : null
    if (k === 'zone') return colOn('ddc', 'zone') ? <td key="zone" className={tdCls + colWrap('ddc', 'zone')} style={colStyle('ddc', 'zone')}><input value={p.zone || ''} onChange={function(e) { updPanel(p.id, { zone: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-16 text-[11px] text-lgray'} /></td> : null
    if (k === 'part') return colOn('ddc', 'part') ? <td key="part" className={tdCls + colWrap('ddc', 'part')} style={colStyle('ddc', 'part')}><input value={p.part || ''} onChange={function(e) { updPanel(p.id, { part: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-14 text-[11px] text-lgray'} /></td> : null
    if (k === 'panelName') return colOn('ddc', 'panelName') ? <td key="panelName" className={tdCls + ' font-bold text-cyan' + colWrap('ddc', 'panelName')} style={colStyle('ddc', 'panelName')}>{p.name}</td> : null
    if (k === 'location') return colOn('ddc', 'location') ? <td key="location" className={tdCls + colWrap('ddc', 'location')} style={colStyle('ddc', 'location')}>{p.location || '-'}</td> : null
    if (k === 'canopy') return colOn('ddc', 'canopy') ? (<td key="canopy" className={tdCls + ' text-center'} style={colStyle('ddc', 'canopy')}>
      <select value={p.canopy || 'N/A'} onChange={function(e) { updPanel(p.id, { canopy: e.target.value }) }} className="bg-transparent text-[10px] uppercase outline-none cursor-pointer text-lgray">
        {CANOPY_OPTS.map(function(c) { return <option key={c} value={c}>{c}</option> })}
      </select>
    </td>) : null
    if (k === 'ddcInstall') return colOn('ddc', 'ddcInstall') ? (<td key="ddcInstall" className={tdCls + ' text-center'}>
      <button onClick={function() { updPanel(p.id, { installed: !p.installed }) }} className={'w-5 h-5 rounded border text-[10px] font-bold transition ' + (p.installed ? 'bg-green border-green text-white' : 'border-border text-dgray hover:border-teal')}>{p.installed ? '✓' : ''}</button>
    </td>) : null
    if (k === 'cablePulling') return colOn('ddc', 'cablePulling') ? <td key="cablePulling" className={tdCls + ' text-center'}>{ddcMode === 'install' ? statCheck(panelStat(p, 'cable_pulled')) : statCell(panelStat(p, 'cable_pulled'))}</td> : null
    if (k === 'panelTerm') return colOn('ddc', 'panelTerm') ? <td key="panelTerm" className={tdCls + ' text-center'}>{ddcMode === 'install' ? statCheck(panelStat(p, 'term_ddc_side')) : statCell(panelStat(p, 'term_ddc_side'))}</td> : null
    if (k === 'functionalTest') return colOn('ddc', 'functionalTest') ? <td key="functionalTest" className={tdCls + ' text-center'}>{ddcMode === 'install' ? statCheck(panelStat(p, 'functional_test')) : statCell(panelStat(p, 'functional_test'))}</td> : null
    if (k === 'inspections') return colOn('ddc', 'inspections') ? <td key="inspections" className={tdCls} style={colStyle('ddc', 'inspections')}><textarea ref={grow} onInput={function(e) { grow(e.target) }} rows={1} value={p.inspection || ''} onChange={function(e) { updPanel(p.id, { inspection: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-full text-[10px] text-teal resize-none overflow-hidden leading-snug bg-transparent align-top'} /></td> : null
    if (k === 'remarks') return colOn('ddc', 'remarks') ? <td key="remarks" className={tdCls} style={colStyle('ddc', 'remarks')}><textarea ref={grow} onInput={function(e) { grow(e.target) }} rows={1} value={p.remarks || ''} onChange={function(e) { updPanel(p.id, { remarks: up(e.target.value) }) }} placeholder="" className={inCls + ' w-full text-[10px] text-orange italic resize-none overflow-hidden leading-snug bg-transparent align-top'} /></td> : null
    var cc = customById('ddc', k)
    if (cc) { var cv = (p.custom && p.custom[cc.id]); return <td key={cc.id} className={tdCls + (cc.type === 'checkbox' ? ' text-center' : '')} style={colStyle('ddc', cc.id)}>{customField(cc, cv, function(val) { var o = Object.assign({}, p.custom || {}); o[cc.id] = val; updPanel(p.id, { custom: o }) })}</td> }
    return null
  }
  function addCustomCol(tbl) {
    var name = window.prompt('NEW COLUMN NAME:')
    if (!name || !name.trim()) return
    var ty = up(window.prompt('COLUMN TYPE — TEXT / NUMBER / CHECKBOX:', 'TEXT') || 'TEXT').trim()
    ty = (ty === 'NUMBER' || ty === 'CHECKBOX') ? ty.toLowerCase() : 'text'
    var cols = Object.assign({}, cfg.cols || {})
    var t = Object.assign({ hide: {}, w: {}, nowrap: {}, custom: [] }, cols[tbl] || {})
    t.custom = (t.custom || []).concat([{ id: 'cc-' + Date.now(), label: up(name).trim(), type: ty }])
    cols[tbl] = t
    setCfg('cols', cols)
  }
  function cycleCustomType(tbl, id) {
    var order = ['text', 'number', 'checkbox']
    var cols = Object.assign({}, cfg.cols || {})
    var t = Object.assign({}, cols[tbl] || {})
    t.custom = (t.custom || []).map(function(c) { if (c.id !== id) return c; return Object.assign({}, c, { type: order[(order.indexOf(c.type || 'text') + 1) % 3] }) })
    cols[tbl] = t
    setCfg('cols', cols)
  }
  function delCustomCol(tbl, id) {
    var cols = Object.assign({}, cfg.cols || {})
    var t = Object.assign({}, cols[tbl] || {})
    t.custom = (t.custom || []).filter(function(c) { return c.id !== id })
    cols[tbl] = t
    setCfg('cols', cols)
  }
  function columnManager(tbl, list) {
    return (
      <div className="no-print bg-navy/40 border border-border rounded p-2 mb-2">
        <div className="text-[9px] text-dgray uppercase mb-1.5 font-semibold">COLUMNS · CLICK = HIDE/SHOW · ↔ = NO-WRAP · IN THE TABLE BELOW: DRAG A HEADER TO REORDER, DRAG ITS RIGHT EDGE TO RESIZE</div>
        <div className="flex flex-wrap gap-1 items-center">
          {list.map(function(col) {
            var on = colOn(tbl, col.key)
            var nw = (colCfg(tbl).nowrap || {})[col.key]
            return (
              <span key={col.key} className={'inline-flex items-center rounded overflow-hidden border ' + (on ? 'border-border' : 'border-border/40')}>
                <button onClick={function() { toggleColHide(tbl, col.key) }} className={'px-1.5 py-0.5 text-[9px] font-bold uppercase ' + (on ? 'bg-teal/15 text-teal' : 'bg-card2 text-dgray line-through')}>{col.label}</button>
                {on && <button onClick={function() { toggleColWrap(tbl, col.key) }} className={'px-1 py-0.5 text-[9px] border-l border-border ' + (nw ? 'bg-cyan/20 text-cyan' : 'bg-card2 text-dgray hover:text-white')}>↔</button>}
              </span>
            )
          })}
          {customCols(tbl).map(function(cc) {
            return (
              <span key={cc.id} className="inline-flex items-center rounded overflow-hidden border border-purple/40">
                <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase bg-purple/15 text-purple">{cc.label}</span>
                <button onClick={function() { cycleCustomType(tbl, cc.id) }} title="COLUMN TYPE" className="px-1 py-0.5 text-[9px] font-bold bg-card2 text-lgray hover:text-white border-l border-border">{(cc.type || 'text') === 'checkbox' ? '☑' : (cc.type === 'number' ? '#' : 'T')}</button>
                <button onClick={function() { delCustomCol(tbl, cc.id) }} className="px-1 py-0.5 text-[9px] bg-card2 text-dgray hover:text-red border-l border-border">✕</button>
              </span>
            )
          })}
          <button onClick={function() { addCustomCol(tbl) }} className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-card2 text-dgray hover:text-white border border-border">+ COLUMN</button>
        </div>
      </div>
    )
  }

  function toggleSection(key) {
    var next = Object.assign({}, cfg, { sections: Object.assign({}, sections) })
    next.sections[key] = !sectionOn(key)
    props.onConfig(next)
  }

  // Report-type presets: built-in + engineer-saved (per project)
  function applyPreset(name) {
    var on = PRESETS[name] || (cfg.presets || {})[name] || []
    var next = Object.assign({}, cfg, { sections: {} })
    SECTION_DEFS.forEach(function(s) { next.sections[s.key] = on.indexOf(s.key) >= 0 })
    if (!cfg.titleTouched && PRESET_TITLES[name]) next.reportTitle = PRESET_TITLES[name]
    var pv = { 'WEEKLY PROGRESS': 'install', 'DDC SCHEDULE': 'install', 'COMMISSIONING': 'commission', 'FULL REPORT': 'commission' }[name]
    if (pv) next.ddcView = pv
    props.onConfig(next)
  }
  function saveCurrentPreset() {
    var name = window.prompt('PRESET NAME (E.G. ADEK CLIENT FORMAT):')
    if (!name || !name.trim()) return
    var presets = Object.assign({}, cfg.presets || {})
    presets[up(name).trim()] = enabledKeys.slice()
    props.onConfig(Object.assign({}, cfg, { presets: presets }))
  }

  // ─── Aggregations ─────────────────────────────────────────
  var allDevices = []
  loops.forEach(function(l) { allDevices = allDevices.concat(l.devices || []) })
  var counts = countStages(loops)
  var overallPct = weightedPct(allDevices)

  function devFloor(d, l) { return up(d.floor || (l ? l.floor : '') || '') || 'UNSPECIFIED' }

  var floorOrder = []
  var floorSeen = {}
  loops.forEach(function(l) {
    ;(l.devices || []).forEach(function(d) {
      var f = devFloor(d, l)
      if (!floorSeen[f]) { floorSeen[f] = true; floorOrder.push(f) }
    })
  })
  floorOrder.sort()

  var typeOrder = []
  var typeSeen = {}
  allDevices.forEach(function(d) {
    var t = up(d.device_type || 'DEVICE')
    if (!typeSeen[t]) { typeSeen[t] = true; typeOrder.push(t) }
  })

  // ─── WORK ITEMS (engineer-defined activity lines) ─────────
  function defaultWorkItems() {
    var items = []
    typeOrder.forEach(function(t) {
      STAGES.forEach(function(s) {
        items.push({ id: wid(), label: t + ' — ' + s.label, unit: 'NOS', teams: '', kind: 'auto', deviceType: t, stage: s.k, design: null, done: 0, remark: '' })
      })
    })
    return items
  }
  var workItems = (cfg.workItems && cfg.workItems.length > 0) ? cfg.workItems : defaultWorkItems()

  function setWorkItems(list) { props.onConfig(Object.assign({}, cfg, { workItems: list })) }
  function updItem(id, patch) {
    setWorkItems(workItems.map(function(w) { return w.id === id ? Object.assign({}, w, patch) : w }))
  }
  function delItem(id) { setWorkItems(workItems.filter(function(w) { return w.id !== id })) }
  function moveItem(id, dir) {
    var idx = workItems.findIndex(function(w) { return w.id === id })
    var to = idx + dir
    if (idx < 0 || to < 0 || to >= workItems.length) return
    var next = workItems.slice()
    var t = next[idx]; next[idx] = next[to]; next[to] = t
    setWorkItems(next)
  }
  function addItem(kind) {
    setWorkItems(workItems.concat([{
      id: wid(),
      label: kind === 'auto' ? 'NEW TRACKED ACTIVITY' : (kind === 'io' ? 'POINT TERMINATION (NO OF PTS)' : 'NEW MANUAL ACTIVITY'),
      unit: kind === 'manual' ? 'METERS' : 'NOS', teams: '', kind: kind,
      deviceType: typeOrder[0] || 'DEVICE', stage: kind === 'io' ? 'term_ddc_side' : 'comm_cable',
      design: kind === 'manual' ? 0 : null, done: 0, remark: ''
    }]))
  }

  // Panel IO points: design = active point qty across panels; done = qty
  // where the point's stage checkbox is ticked; per-floor via panel.floor
  function ioPoints(fn) {
    panels.forEach(function(p) {
      var f = up(p.floor || '') || 'UNSPECIFIED'
      ;(equipmentMap[p.id] || []).forEach(function(eq) {
        ;(eq.points || []).forEach(function(pt) {
          if (pt.excluded) return
          fn(pt, f)
        })
      })
    })
  }
  function ioDesign() {
    var n = 0
    ioPoints(function(pt) { n += (Number(pt.qty) || 1) })
    return n
  }
  function ioCountAll(stage) {
    var n = 0
    ioPoints(function(pt) { if (pt[stage]) n += (Number(pt.qty) || 1) })
    return n
  }
  function ioCountFloor(stage, floor) {
    var n = 0
    ioPoints(function(pt, f) { if (f === floor && pt[stage]) n += (Number(pt.qty) || 1) })
    return n
  }

  function autoCount(it, floor) {
    var n = 0
    loops.forEach(function(l) {
      ;(l.devices || []).forEach(function(d) {
        if (up(d.device_type || 'DEVICE') !== up(it.deviceType)) return
        if (floor && devFloor(d, l) !== floor) return
        if (floor === null || !floor) { if (!floor && floor !== null) return }
        if (d[it.stage]) n++
      })
    })
    return n
  }
  function autoDesign(it) {
    return allDevices.filter(function(d) { return up(d.device_type || 'DEVICE') === up(it.deviceType) }).length
  }
  function workRow(it) {
    var isAuto = it.kind === 'auto'
    var isIo = it.kind === 'io'
    var liveDesign = isAuto ? autoDesign(it) : (isIo ? ioDesign() : 0)
    var design = (it.design === null || it.design === undefined || it.design === '') ? liveDesign : Number(it.design) || 0
    var done = isAuto ? autoCountAll(it) : (isIo ? ioCountAll(it.stage) : (Number(it.done) || 0))
    var perFloor = isAuto ? floorOrder.map(function(f) { return autoCountFloor(it, f) })
      : (isIo ? floorOrder.map(function(f) { return ioCountFloor(it.stage, f) }) : floorOrder.map(function() { return null }))
    return { design: design, done: done, balance: design - done, perFloor: perFloor, liveDesign: liveDesign }
  }
  function autoCountAll(it) {
    var n = 0
    allDevicesWithLoop(function(d, l) {
      if (up(d.device_type || 'DEVICE') === up(it.deviceType) && d[it.stage]) n++
    })
    return n
  }
  function autoCountFloor(it, f) {
    var n = 0
    allDevicesWithLoop(function(d, l) {
      if (up(d.device_type || 'DEVICE') === up(it.deviceType) && d[it.stage] && devFloor(d, l) === f) n++
    })
    return n
  }
  function allDevicesWithLoop(fn) {
    loops.forEach(function(l) { (l.devices || []).forEach(function(d) { fn(d, l) }) })
  }

  // ─── DDC PANEL SCHEDULE helpers ────────────────────────────
  // Status cells DERIVE from the per-point IO checklists:
  // all done = ✓ green · partial = n/m orange · none = · · no points = —
  function panelStat(p, stageKey) {
    var done = 0
    var total = 0
    ;(equipmentMap[p.id] || []).forEach(function(eq) {
      ;(eq.points || []).forEach(function(pt) {
        if (pt.excluded) return
        var q = Number(pt.qty) || 1
        total += q
        if (pt[stageKey]) done += q
      })
    })
    return { done: done, total: total }
  }
  function updPanel(id, patch) {
    if (props.onUpdatePanels) props.onUpdatePanels(panels.map(function(p) { return p.id === id ? Object.assign({}, p, patch) : p }))
  }
  function statCell(st) {
    if (st.total === 0) return <span className="text-dgray">—</span>
    if (st.done >= st.total) return <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-green/20 text-green rpt-fill">✓</span>
    if (st.done > 0) return <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange/20 text-orange rpt-fill">{st.done}/{st.total}</span>
    return <span className="text-dgray">·</span>
  }
  function statCheck(st) {
    if (st.total === 0) return <span className="text-dgray">—</span>
    var done = st.done >= st.total
    return <span className={'inline-block w-4 h-4 rounded border text-[9px] font-bold leading-4 text-center rpt-fill ' + (done ? 'bg-green border-green text-white' : 'border-border text-dgray')}>{done ? '✓' : ''}</span>
  }
  function ioList(p) {
    var eqs = equipmentMap[p.id] || []
    var rows = []
    eqs.forEach(function(eq) { (eq.points || []).forEach(function(pt) { if (!pt.excluded) rows.push({ eq: eq, pt: pt }) }) })
    if (rows.length === 0) return <div className="text-[10px] text-dgray uppercase py-1">NO IO POINTS LOGGED FOR THIS PANEL.</div>
    return (
      <div>
        <div className="text-[9px] text-teal uppercase font-bold mb-1">IO POINTS — {p.name}</div>
        <table className="w-full">
          <thead><tr>
            <th className={thCls}>EQUIPMENT</th><th className={thCls}>POINT</th><th className={thCls}>TYPE</th>
            {IO_STAGES.map(function(s) { return <th key={s.k} className={thCls + ' text-center'}>{s.label}</th> })}
          </tr></thead>
          <tbody>
            {rows.map(function(row, ri) {
              return (<tr key={row.pt.id} className={'border-b border-border/20' + (ri % 2 ? ' bg-card2/20' : '')}>
                <td className={tdCls + ' text-cyan'}>{row.eq.name}</td>
                <td className={tdCls}>{row.pt.description}</td>
                <td className={tdCls + ' text-dgray'}>{row.pt.type || '-'}</td>
                {IO_STAGES.map(function(s) { return <td key={s.k} className={tdCls + ' text-center'}>{row.pt[s.k] ? <span className="text-green font-bold">✓</span> : <span className="text-dgray">·</span>}</td> })}
              </tr>)
            })}
          </tbody>
        </table>
      </div>
    )
  }
  function statTxt(st) {
    if (st.total === 0) return ''
    if (st.done >= st.total) return '✓'
    return st.done > 0 ? st.done + '/' + st.total : ''
  }
  var schedPanels = panels.slice().sort(function(a, b) {
    var fa = up(a.floor || 'ZZZZ')
    var fb = up(b.floor || 'ZZZZ')
    if (fa !== fb) return fa < fb ? -1 : 1
    return up(a.name || '') < up(b.name || '') ? -1 : 1
  })
  var ddcRowOrder = colCfg('ddc').rowOrder || []
  if (ddcRowOrder.length) {
    var rowPos = {}
    ddcRowOrder.forEach(function(id, ix) { rowPos[id] = ix })
    schedPanels = schedPanels.slice().sort(function(a, b) {
      var pa = rowPos[a.id] === undefined ? 1e9 : rowPos[a.id]
      var pb = rowPos[b.id] === undefined ? 1e9 : rowPos[b.id]
      return pa - pb
    })
  }

  // ─── AREA-WISE (location groups under floors) ──────────────
  var devInfo = {} // devId -> {dev, loop}
  loops.forEach(function(l) { (l.devices || []).forEach(function(d) { devInfo[d.id] = { dev: d, loop: l } }) })
  var grouped = {} // floor -> [{name, devs}]
  var groupedIds = {}
  areas.forEach(function(a) {
    var byFloor = {}
    ;(a.device_ids || []).forEach(function(did) {
      var info = devInfo[did]
      if (!info) return
      groupedIds[did] = true
      var f = devFloor(info.dev, info.loop)
      if (!byFloor[f]) byFloor[f] = []
      byFloor[f].push(info.dev)
    })
    Object.keys(byFloor).forEach(function(f) {
      if (!grouped[f]) grouped[f] = []
      grouped[f].push({ name: up(a.name || 'AREA'), devs: byFloor[f] })
    })
  })
  floorOrder.forEach(function(f) {
    var ungrouped = []
    allDevicesWithLoop(function(d, l) {
      if (!groupedIds[d.id] && devFloor(d, l) === f) ungrouped.push(d)
    })
    if (ungrouped.length > 0) {
      if (!grouped[f]) grouped[f] = []
      grouped[f].push({ name: 'UNGROUPED', devs: ungrouped })
    }
  })
  function floorDevs(f) {
    var out = []
    allDevicesWithLoop(function(d, l) { if (devFloor(d, l) === f) out.push(d) })
    return out
  }
  function toggleCollapse(key) {
    var next = Object.assign({}, collapsed)
    next[key] = !next[key]
    setCollapsed(next)
  }

  // ─── Registers ─────────────────────────────────────────────
  var loopRows = loops.map(function(l) {
    var devs = l.devices || []
    var inst = devs.filter(function(d) { return d.device_installed }).length
    var term = devs.filter(function(d) { return d.termination }).length
    var status = devs.length === 0 ? '-' :
      (inst === devs.length ? 'INSTALLED' : (term === devs.length ? 'WIR READY' : 'IN PROGRESS'))
    return { loop: l, inst: inst, term: term, pct: weightedPct(devs), status: status }
  })
  var wirReady = loopRows.filter(function(r) { return r.status === 'WIR READY' })
  var openBlockers = blockers.filter(function(b) { return b.status !== 'resolved' })
  var forecast = computeForecast(snapshots, counts.inst, counts.total)

  var movement = null
  if (cfg.periodFrom && snapshots.length > 0) {
    var fromT = new Date(cfg.periodFrom).getTime()
    var base = null
    snapshots.forEach(function(s) {
      var t = new Date(s.snapped_at).getTime()
      if (t <= fromT + 86400000 && (!base || t > new Date(base.snapped_at).getTime())) base = s
    })
    if (base) movement = { installed: counts.inst - base.inst, terminated: counts.term - base.term }
  }

  function ageDays(iso) {
    if (!iso) return '-'
    return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) + 'D'
  }

  function loopsOf(gName) {
    return loops.filter(function(l) { return up(l.gateway) === up(gName) && up(gName) !== '' })
  }

  // ─── Auto numbering ────────────────────────────────────────
  var enabledKeys = SECTION_DEFS.filter(function(s) { return sectionOn(s.key) }).map(function(s) { return s.key })
  function secTitle(key) {
    var def = SECTION_DEFS.find(function(s) { return s.key === key })
    var no = enabledKeys.indexOf(key) + 1
    return (
      <div className="flex items-center gap-2 mt-6 mb-2 border-b border-border pb-1">
        <span className="inline-block w-1.5 h-4 bg-teal rounded rpt-fill"></span>
        <span className="text-[11px] font-extrabold text-teal uppercase tracking-widest">{no}. {def.label}</span>
      </div>
    )
  }

  // ─── Excel export ─────────────────────────────────────────
  function exportExcel() {
    if (!window.XLSX) { alert('SPREADSHEET LIBRARY NOT LOADED - CHECK CONNECTION AND RELOAD'); return }
    var X = window.XLSX
    var wb = X.utils.book_new()

    var summary = [
      [up(cfg.reportTitle) || DEFAULT_TITLE],
      ['PROJECT', up(props.projectName)],
      ['CLIENT', up(cfg.client)],
      ['CONTRACTOR', up(cfg.contractor)],
      ['REPORT NO', up(cfg.reportNo)],
      ['PERIOD', (cfg.periodFrom || '-') + ' TO ' + (cfg.periodTo || '-')],
      ['PREPARED BY', up(cfg.preparedBy)],
      ['GENERATED', new Date().toISOString().substring(0, 10)],
      [],
      ['OVERALL WEIGHTED PROGRESS', overallPct + '%'],
      ['TOTAL DEVICES', counts.total],
      ['LOOPS', loops.length],
      ['OPEN BLOCKERS', openBlockers.length],
      [],
      ['STAGE', 'DONE', 'TOTAL', '%']
    ]
    STAGES.forEach(function(s) {
      summary.push([s.label, counts[s.c], counts.total, counts.total ? Math.round(counts[s.c] / counts.total * 100) + '%' : '0%'])
    })
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(summary), 'SUMMARY')

    // Company-format Work Progress sheet (engineer-defined activities)
    var work = [
      ['WORK PROGRESS REPORT'],
      ['MEP CONTRACTOR: ' + up(cfg.contractor)],
      ['SUPERINTENDENT: ' + up(cfg.preparedBy)],
      ['PROJECT NAME: ' + up(props.projectName)],
      [],
      ['S/N', 'DEVICES / ACTIVITY', 'UNIT', 'TEAMS', 'DESIGN'].concat(floorOrder).concat(['QTY (WORKDONE)', 'BALANCE', 'REMARK'])
    ]
    workItems.forEach(function(it, i) {
      var r = workRow(it)
      work.push([i + 1, up(it.label), up(it.unit), up(it.teams || ''), r.design]
        .concat(r.perFloor.map(function(n) { return n === null ? '' : n }))
        .concat([r.done, r.balance, up(it.remark || '')]))
    })
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(work), 'WORK PROGRESS')

    // Area-wise sheet: floor rows + indented area rows
    var areasSheet = [['FLOOR / AREA', 'DEVICES'].concat(STAGES.map(function(s) { return s.label })).concat(['WEIGHTED %'])]
    floorOrder.forEach(function(f) {
      var fd = floorDevs(f)
      var frow = [f, fd.length]
      STAGES.forEach(function(s) { frow.push(fd.filter(function(d) { return d[s.k] }).length) })
      frow.push(weightedPct(fd) + '%')
      areasSheet.push(frow)
      ;(grouped[f] || []).forEach(function(g) {
        var grow = ['    ' + g.name, g.devs.length]
        STAGES.forEach(function(s) { grow.push(g.devs.filter(function(d) { return d[s.k] }).length) })
        grow.push(weightedPct(g.devs) + '%')
        areasSheet.push(grow)
      })
    })
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(areasSheet), 'AREAS')

    // DDC Panel Schedule sheet (corporate format)
    var ddcSheet = [['SR', 'LEVEL', 'ZONE', 'PART', 'PANEL NAME', 'LOCATION', 'CANOPY', 'DDC INSTALLATION', 'CABLE PULLING', 'PANEL TERMINATION', 'FUNCTIONAL TEST', 'INSPECTIONS', 'REMARKS']]
    schedPanels.forEach(function(p, i) {
      ddcSheet.push([i + 1, up(p.floor || ''), up(p.zone || ''), up(p.part || ''), p.name, p.location || '', p.canopy || 'N/A', p.installed ? '✓' : '', statTxt(panelStat(p, 'cable_pulled')), statTxt(panelStat(p, 'term_ddc_side')), statTxt(panelStat(p, 'functional_test')), up(p.inspection || ''), up(p.remarks || '')])
    })
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(ddcSheet), 'DDC SCHEDULE')

    var loopSheet = [['FLOOR', 'LOOP', 'GATEWAY', 'DDC REF', 'PROTOCOL', 'DEVICES', 'TERMINATED', 'INSTALLED', 'STATUS', '%']]
    loopRows.forEach(function(r) {
      loopSheet.push([r.loop.floor || '', r.loop.name, r.loop.gateway || '', r.loop.ddc_ref || '', r.loop.protocol || '', (r.loop.devices || []).length, r.term, r.inst, r.status, r.pct + '%'])
    })
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(loopSheet), 'LOOPS')

    var devSheet = [['LOOP', 'TYPE', 'EQUIP TAG', 'ROOM', 'FLOOR', 'ADDR', 'SERIAL', 'COMM', 'CTRL', 'CONT', 'TERM', 'INST', 'ADDRESSED', 'REMARKS']]
    loops.forEach(function(l) {
      ;(l.devices || []).forEach(function(d) {
        devSheet.push([l.name, d.device_type, d.tag, d.room_name || '', d.floor || l.floor || '', d.address || '', d.serial || '',
          d.comm_cable ? 'Y' : '', d.control_cable ? 'Y' : '', d.continuity ? 'Y' : '', d.termination ? 'Y' : '', d.device_installed ? 'Y' : '', d.address_set ? 'Y' : '', d.remarks || ''])
      })
    })
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(devSheet), 'DEVICES')

    var blkSheet = [['STATUS', 'LOOP', 'FROM', 'TO', 'FLOOR', 'DESCRIPTION', 'RAISED', 'AGE']]
    blockers.forEach(function(b) {
      blkSheet.push([up(b.status || 'open'), b.loop || '', b.from || '', b.to || '', b.floor || '', b.text || '', (b.createdAt || '').substring(0, 10), ageDays(b.createdAt)])
    })
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(blkSheet), 'BLOCKERS')

    var fname = up(props.projectName || 'PROJECT').replace(/[^A-Z0-9]+/g, '-') + '-PROGRESS-' + new Date().toISOString().substring(0, 10) + '.xlsx'
    X.writeFile(wb, fname)
  }

  // ─── UI helpers ───────────────────────────────────────────
  function bar(pct, cls) {
    return (
      <div className="w-full h-2 bg-navy rounded overflow-hidden">
        <div className={'h-full rounded rpt-fill ' + (cls || (pct >= 100 ? 'bg-green' : pct >= 50 ? 'bg-teal' : pct > 0 ? 'bg-orange' : 'bg-red/30'))} style={{ width: Math.min(100, pct) + '%' }}></div>
      </div>
    )
  }

  var thCls = 'text-[9px] text-dgray text-left px-2 py-1.5 uppercase'
  var tdCls = 'text-[11px] px-2 py-1.5 uppercase'
  var inCls = 'bg-transparent border-b border-transparent focus:border-teal outline-none uppercase'

  return (
    <div>
      {/* ─── Toolbar + config (never printed) ─── */}
      <div className="no-print">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-4">
          <h1 className="text-lg md:text-xl font-bold uppercase">REPORTS <span className="text-dgray font-normal text-xs ml-2">LIVE FROM SITE DATA</span></h1>
          <div className="flex gap-2">
            <button onClick={function() { window.print() }} className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 uppercase">⬇ EXPORT PDF</button>
            <button onClick={exportExcel} className="px-4 py-2 bg-green/20 text-green text-xs font-semibold rounded-md hover:bg-green/30 uppercase">⬇ EXPORT EXCEL</button>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4 mb-4">
          <div className="text-[10px] text-dgray uppercase font-semibold mb-2">REPORT HEADER — SAVED WITH THE PROJECT</div>
          <div className="mb-2">
            <label className="text-[9px] text-dgray block mb-0.5">REPORT TITLE — SHOWN ON THE REPORT (AUTO-FILLS FROM REPORT TYPE UNTIL YOU EDIT IT)</label>
            <input value={cfg.reportTitle} onChange={function(e) { setCfgMulti({ reportTitle: upKeep(e.target.value), titleTouched: true }) }} placeholder={DEFAULT_TITLE} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-sm text-white uppercase outline-none focus:border-teal font-bold" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
            <div><label className="text-[9px] text-dgray block mb-0.5">REPORT NO</label><input value={cfg.reportNo} onChange={function(e) { setCfg('reportNo', up(e.target.value)) }} placeholder="WPR-012" className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white uppercase outline-none focus:border-teal" /></div>
            <div><label className="text-[9px] text-dgray block mb-0.5">PERIOD FROM</label><input type="date" value={cfg.periodFrom} onChange={function(e) { setCfg('periodFrom', e.target.value) }} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal" /></div>
            <div><label className="text-[9px] text-dgray block mb-0.5">PERIOD TO</label><input type="date" value={cfg.periodTo} onChange={function(e) { setCfg('periodTo', e.target.value) }} className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal" /></div>
            <div><label className="text-[9px] text-dgray block mb-0.5">CONTRACTOR</label><input value={cfg.contractor} onChange={function(e) { setCfg('contractor', up(e.target.value)) }} placeholder="YOUR COMPANY" className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white uppercase outline-none focus:border-teal" /></div>
            <div><label className="text-[9px] text-dgray block mb-0.5">CLIENT/CONSULTANT</label><input value={cfg.client} onChange={function(e) { setCfg('client', up(e.target.value)) }} placeholder="CLIENT" className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white uppercase outline-none focus:border-teal" /></div>
            <div><label className="text-[9px] text-dgray block mb-0.5">PREPARED BY</label><input value={cfg.preparedBy} onChange={function(e) { setCfg('preparedBy', up(e.target.value)) }} placeholder="NAME" className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white uppercase outline-none focus:border-teal" /></div>
          </div>
          <div className="text-[10px] text-dgray uppercase font-semibold mb-1.5">REPORT TYPE — ONE CLICK SETS THE SECTIONS</div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {Object.keys(PRESETS).map(function(name) {
              return <button key={name} onClick={function() { applyPreset(name) }} className="px-2.5 py-1 rounded text-[9px] font-bold uppercase bg-card2 text-lgray hover:bg-teal/20 hover:text-teal transition">{name}</button>
            })}
            {Object.keys(cfg.presets || {}).map(function(name) {
              return <button key={'c-' + name} onClick={function() { applyPreset(name) }} className="px-2.5 py-1 rounded text-[9px] font-bold uppercase bg-purple/15 text-purple hover:bg-purple/30 transition">{name}</button>
            })}
            <button onClick={saveCurrentPreset} className="px-2.5 py-1 rounded text-[9px] font-bold uppercase bg-card2 text-dgray hover:text-white transition">+ SAVE CURRENT AS PRESET</button>
          </div>
          <div className="text-[10px] text-dgray uppercase font-semibold mb-1.5">SECTIONS IN THIS REPORT (AUTO-NUMBERED)</div>
          <div className="flex flex-wrap gap-1.5">
            {SECTION_DEFS.map(function(s) {
              var on = sectionOn(s.key)
              return <button key={s.key} onClick={function() { toggleSection(s.key) }} className={'px-2.5 py-1 rounded text-[9px] font-bold uppercase transition ' + (on ? 'bg-teal/20 text-teal' : 'bg-card2 text-dgray hover:text-white line-through')}>{on ? (enabledKeys.indexOf(s.key) + 1) + '. ' : ''}{s.label}</button>
            })}
          </div>
        </div>
      </div>

      {/* ─── Report body (screen + print) ─── */}
      <div id="report-body" className="bg-card rounded-xl border border-border p-5 md:p-8">
        <div className="border-b-2 border-teal pb-4 mb-2">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xl font-black uppercase">{cfg.contractor || 'CONTRACTOR'}</div>
              <div className="text-sm font-bold text-teal uppercase mt-1">{cfg.reportTitle || DEFAULT_TITLE}</div>
            </div>
            <div className="text-right text-[11px] uppercase">
              <div><span className="text-dgray">REPORT NO: </span><span className="font-bold">{cfg.reportNo || '-'}</span></div>
              <div><span className="text-dgray">DATE: </span><span className="font-bold">{fmtDate(new Date())}</span></div>
              <div><span className="text-dgray">PERIOD: </span><span className="font-bold">{cfg.periodFrom ? fmtDate(cfg.periodFrom) : '-'} — {cfg.periodTo ? fmtDate(cfg.periodTo) : '-'}</span></div>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-[11px] uppercase">
            <div><span className="text-dgray">PROJECT: </span><span className="font-bold">{up(props.projectName)}</span></div>
            <div><span className="text-dgray">CLIENT: </span><span className="font-bold">{cfg.client || '-'}</span></div>
            <div><span className="text-dgray">PREPARED BY: </span><span className="font-bold">{cfg.preparedBy || '-'}</span></div>
            <div><span className="text-dgray">SYSTEM: </span><span className="font-bold">BMS FIELD DEVICES</span></div>
          </div>
        </div>

        {sectionOn('summary') && (
          <div>
            {secTitle('summary')}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
              <div className="bg-card2 rounded-lg p-3"><div className="text-[9px] text-dgray uppercase">OVERALL PROGRESS</div><div className="text-2xl font-extrabold text-teal">{overallPct}%</div></div>
              <div className="bg-card2 rounded-lg p-3"><div className="text-[9px] text-dgray uppercase">DEVICES</div><div className="text-2xl font-extrabold text-cyan">{counts.total}</div></div>
              <div className="bg-card2 rounded-lg p-3"><div className="text-[9px] text-dgray uppercase">INSTALLED</div><div className="text-2xl font-extrabold text-green">{counts.inst}/{counts.total}</div></div>
              <div className="bg-card2 rounded-lg p-3"><div className="text-[9px] text-dgray uppercase">LOOPS</div><div className="text-2xl font-extrabold text-cyan">{loops.length}</div></div>
              <div className="bg-card2 rounded-lg p-3"><div className="text-[9px] text-dgray uppercase">OPEN BLOCKERS</div><div className={'text-2xl font-extrabold ' + (openBlockers.length > 0 ? 'text-red' : 'text-green')}>{openBlockers.length}</div></div>
            </div>
            {movement && (
              <div className="text-[11px] uppercase mb-1"><span className="text-dgray">THIS PERIOD: </span><span className="font-bold text-green">+{movement.installed} INSTALLED</span><span className="text-dgray"> · </span><span className="font-bold text-teal">+{movement.terminated} TERMINATED</span></div>
            )}
            {forecast && forecast.projectedDate && (
              <div className="text-[11px] uppercase"><span className="text-dgray">VELOCITY: </span><span className="font-bold">{forecast.perDay} DEVICES/DAY</span><span className="text-dgray"> · PROJECTED INSTALLATION COMPLETE: </span><span className="font-bold text-teal">{fmtDate(forecast.projectedDate)}</span></div>
            )}
          </div>
        )}

        {sectionOn('workTable') && (
          <div>
            {secTitle('workTable')}
            <div className="no-print flex items-center gap-3 mb-2">
              <button onClick={function() { setEditWork(!editWork) }} className={'px-3 py-1 rounded text-[9px] font-bold uppercase transition ' + (editWork ? 'bg-orange text-white' : 'bg-orange/20 text-orange hover:bg-orange/30')}>{editWork ? '✓ DONE EDITING' : '✎ CUSTOMIZE ACTIVITIES'}</button>
              {editWork && (
                <span className="flex gap-2">
                  <button onClick={function() { addItem('auto') }} className="px-2.5 py-1 bg-teal/20 text-teal rounded text-[9px] font-bold uppercase hover:bg-teal/30">+ DEVICES (AUTO QTY)</button>
                  <button onClick={function() { addItem('io') }} className="px-2.5 py-1 bg-cyan/20 text-cyan rounded text-[9px] font-bold uppercase hover:bg-cyan/30">+ IO POINTS (AUTO QTY)</button>
                  <button onClick={function() { addItem('manual') }} className="px-2.5 py-1 bg-purple/20 text-purple rounded text-[9px] font-bold uppercase hover:bg-purple/30">+ MANUAL (TYPED QTY)</button>
                  <button onClick={function() { if (window.confirm('RESET TO DEFAULT ACTIVITY LIST FROM CURRENT DEVICE TYPES?')) setWorkItems(defaultWorkItems()) }} className="px-2.5 py-1 bg-card2 text-dgray rounded text-[9px] font-bold uppercase hover:text-white">RESET</button>
                </span>
              )}
            </div>
            {editWork && columnManager('work', WORK_COLS)}
            <div className="overflow-x-auto">
              <table className="w-full"><thead><tr className="border-b border-border">
                <th className={thCls}>S/N</th>
                {orderedKeys('work').map(function(k) { return workHead(k) })}
                {editWork && <th className={thCls + ' no-print'}></th>}
              </tr></thead><tbody>
                {workItems.map(function(it, i) {
                  var r = workRow(it)
                  var rowOver = rowDrag && rowDrag.tbl === 'work' && rowDrag.overId === it.id && rowDrag.id !== it.id
                  return (<tr key={it.id} data-rowid={it.id} data-rowtbl="work" className={'border-b border-border/30' + (rowOver ? ' bg-teal/10' : (i % 2 ? ' bg-card2/20' : ''))}>
                    <td className={tdCls + ' text-dgray'}>{i + 1}</td>
                    {orderedKeys('work').map(function(k) { return workCell(k, it, r) })}
                    {editWork && (<td className={tdCls + ' no-print whitespace-nowrap'}>
                      <span onPointerDown={function(e) { startRowDrag('work', it.id, e) }} onPointerMove={rowDragMove} onPointerUp={rowDragUp} className="cursor-grab text-dgray hover:text-teal px-0.5 inline-block" style={{ touchAction: 'none' }}>⠿</span>
                      <button onClick={function() { delItem(it.id) }} className="text-dgray hover:text-red px-0.5">✕</button>
                    </td>)}
                  </tr>)
                })}
              </tbody></table>
            </div>
            <div className="text-[9px] text-dgray uppercase mt-1 no-print">TRACKED ROWS PULL WORKDONE LIVE FROM DEVICE STAGES · MANUAL ROWS (CABLES, POINTS…) ARE TYPED · DESIGN = CONTRACT QTY (BLANK = LIVE DEVICE COUNT)</div>
          </div>
        )}

        {sectionOn('pipeline') && (
          <div>
            {secTitle('pipeline')}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              {STAGES.map(function(s) {
                var done = counts[s.c]
                var pct = counts.total ? Math.round(done / counts.total * 100) : 0
                return (
                  <div key={s.k}>
                    <div className="text-[9px] text-dgray uppercase mb-0.5">{s.label}</div>
                    <div className="text-sm font-bold mb-1">{done}/{counts.total} <span className="text-dgray text-[10px]">({pct}%)</span></div>
                    {bar(pct)}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {sectionOn('areas') && floorOrder.length > 0 && (
          <div>
            {secTitle('areas')}
            <table className="w-full"><thead><tr className="border-b border-border">
              <th className={thCls}>FLOOR / AREA</th><th className={thCls + ' text-center'}>DEVICES</th>
              {STAGES.map(function(s) { return <th key={s.k} className={thCls + ' text-center'}>{s.label}</th> })}
              <th className={thCls + ' text-right'}>WEIGHTED %</th>
            </tr></thead><tbody>
              {floorOrder.map(function(f) {
                var fd = floorDevs(f)
                var isCollapsed = collapsed['f:' + f]
                var groups = grouped[f] || []
                var rows = []
                rows.push(
                  <tr key={'f-' + f} className="border-b border-border/50 bg-card2/50 cursor-pointer hover:bg-card2" onClick={function() { toggleCollapse('f:' + f) }}>
                    <td className={tdCls + ' font-bold text-orange'}><span className="no-print text-dgray mr-1">{isCollapsed ? '▸' : '▾'}</span>{f}</td>
                    <td className={tdCls + ' text-center font-bold'}>{fd.length}</td>
                    {STAGES.map(function(s) { return <td key={s.k} className={tdCls + ' text-center font-bold'}>{fd.filter(function(d) { return d[s.k] }).length}</td> })}
                    <td className={tdCls + ' text-right font-bold'}>{weightedPct(fd)}%</td>
                  </tr>
                )
                if (!isCollapsed) {
                  groups.forEach(function(g, gi) {
                    rows.push(
                      <tr key={'g-' + f + '-' + gi} className="border-b border-border/20">
                        <td className={tdCls + ' pl-7 text-lgray'}>{g.name}</td>
                        <td className={tdCls + ' text-center text-dgray'}>{g.devs.length}</td>
                        {STAGES.map(function(s) { return <td key={s.k} className={tdCls + ' text-center text-dgray'}>{g.devs.filter(function(d) { return d[s.k] }).length}</td> })}
                        <td className={tdCls + ' text-right'}>{weightedPct(g.devs)}%</td>
                      </tr>
                    )
                  })
                }
                return rows
              })}
            </tbody></table>
            <div className="text-[9px] text-dgray uppercase mt-1 no-print">AREAS COME FROM LOCATION VIEW GROUPS + TRACE STUDIO ZONES · CLICK A FLOOR ROW TO COLLAPSE · COLLAPSED FLOORS PRINT COLLAPSED</div>
          </div>
        )}

        {sectionOn('ddcSchedule') && panels.length > 0 && (
          <div>
            {secTitle('ddcSchedule')}
            <div className="no-print flex items-center gap-3 mb-2 flex-wrap">
              <button onClick={function() { setEditDdc(!editDdc) }} className={'px-3 py-1 rounded text-[9px] font-bold uppercase transition ' + (editDdc ? 'bg-orange text-white' : 'bg-orange/20 text-orange hover:bg-orange/30')}>{editDdc ? '✓ DONE' : '⚙ CUSTOMIZE COLUMNS'}</button>
              <span className="inline-flex rounded overflow-hidden border border-border text-[9px] font-bold uppercase">
                <button onClick={function() { setCfg('ddcView', 'install') }} className={'px-2.5 py-1 ' + (ddcMode === 'install' ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>INSTALLATION</button>
                <button onClick={function() { setCfg('ddcView', 'commission') }} className={'px-2.5 py-1 border-l border-border ' + (ddcMode === 'commission' ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>COMMISSIONING</button>
              </span>
              <span className="text-[9px] text-dgray uppercase">{ddcMode === 'install' ? 'CHECKBOXES — DONE / NOT DONE' : 'IO COUNTS · CLICK ▸ ON A ROW FOR POINT-WISE TRACKING'}</span>
            </div>
            {editDdc && columnManager('ddc', DDC_COLS)}
            <div className="overflow-x-auto">
              <table className="w-full"><thead><tr className="border-b border-border">
                <th className={thCls}>SR</th>
                {orderedKeys('ddc').map(function(k) { return ddcHead(k) })}
              </tr></thead><tbody>
                {schedPanels.map(function(p, i) {
                  var prevP = schedPanels[i - 1]
                  var lvl = up(p.floor || '')
                  var showLvl = !prevP || up(prevP.floor || '') !== lvl
                  var rowOver = rowDrag && rowDrag.tbl === 'ddc' && rowDrag.overId === p.id && rowDrag.id !== p.id
                  var expanded = ddcMode === 'commission' && collapsed['ddcio:' + p.id]
                  var mainRow = (<tr key={p.id} data-rowid={p.id} data-rowtbl="ddc" className={'border-b border-border/30' + (rowOver ? ' bg-teal/10' : (i % 2 ? ' bg-card2/20' : ''))}>
                    <td className={tdCls + ' text-dgray whitespace-nowrap'}>{editDdc && <span onPointerDown={function(e) { startRowDrag('ddc', p.id, e) }} onPointerMove={rowDragMove} onPointerUp={rowDragUp} className="cursor-grab text-dgray hover:text-teal mr-1 inline-block no-print" style={{ touchAction: 'none' }}>⠿</span>}{ddcMode === 'commission' && <button onClick={function() { toggleCollapse('ddcio:' + p.id) }} className="text-dgray hover:text-teal mr-1 no-print">{collapsed['ddcio:' + p.id] ? '▾' : '▸'}</button>}{i + 1}</td>
                    {orderedKeys('ddc').map(function(k) { return ddcCell(k, p, showLvl, lvl) })}
                  </tr>)
                  if (!expanded) return mainRow
                  return [mainRow, (<tr key={p.id + '-io'} className="bg-navy/40"><td colSpan={99} className="px-4 py-2">{ioList(p)}</td></tr>)]
                })}
              </tbody></table>
            </div>
            <div className="text-[9px] text-dgray uppercase mt-1 no-print">CABLE PULLING / TERMINATION / FUNCTIONAL TEST DERIVE LIVE FROM IO POINT CHECKLISTS (✓ = ALL · N/M = PARTIAL) · ZONE, PART, CANOPY, INSTALLATION, INSPECTIONS, REMARKS EDIT HERE AND SAVE WITH THE PROJECT</div>
          </div>
        )}

        {sectionOn('gateways') && gateways.length > 0 && (
          <div>
            {secTitle('gateways')}
            <table className="w-full"><thead><tr className="border-b border-border">
              <th className={thCls}>GATEWAY/RTR</th><th className={thCls}>TYPE</th><th className={thCls}>DDC REF</th><th className={thCls}>IP</th><th className={thCls}>BACNET ID</th><th className={thCls + ' text-center'}>LOOPS</th><th className={thCls + ' text-center'}>DEVICES</th><th className={thCls + ' text-right'}>%</th>
            </tr></thead><tbody>
              {gateways.map(function(g) {
                var gl = loopsOf(g.name)
                var gd = []
                gl.forEach(function(l) { gd = gd.concat(l.devices || []) })
                return (<tr key={g.id} className="border-b border-border/30">
                  <td className={tdCls + ' font-bold'}>{g.name}</td>
                  <td className={tdCls}>{g.kind}</td>
                  <td className={tdCls + ' text-cyan'}>{g.ddc_ref || '-'}</td>
                  <td className={tdCls}>{g.ip || '-'}</td>
                  <td className={tdCls}>{g.bacnet_id || '-'}</td>
                  <td className={tdCls + ' text-center'}>{gl.length}</td>
                  <td className={tdCls + ' text-center'}>{gd.length}</td>
                  <td className={tdCls + ' text-right font-bold'}>{weightedPct(gd)}%</td>
                </tr>)
              })}
            </tbody></table>
          </div>
        )}

        {sectionOn('loopsReg') && (
          <div>
            {secTitle('loopsReg')}
            <table className="w-full"><thead><tr className="border-b border-border">
              <th className={thCls}>FLOOR</th><th className={thCls}>LOOP</th><th className={thCls}>GATEWAY</th><th className={thCls}>DDC</th><th className={thCls + ' text-center'}>DEV</th><th className={thCls + ' text-center'}>TERM</th><th className={thCls + ' text-center'}>INST</th><th className={thCls}>STATUS</th><th className={thCls + ' text-right'}>%</th>
            </tr></thead><tbody>
              {loopRows.map(function(r) {
                return (<tr key={r.loop.id} className="border-b border-border/30">
                  <td className={tdCls + ' text-orange'}>{r.loop.floor || '-'}</td>
                  <td className={tdCls + ' font-bold'}>{r.loop.name}</td>
                  <td className={tdCls + ' text-cyan'}>{r.loop.gateway || '-'}</td>
                  <td className={tdCls}>{r.loop.ddc_ref || '-'}</td>
                  <td className={tdCls + ' text-center'}>{(r.loop.devices || []).length}</td>
                  <td className={tdCls + ' text-center'}>{r.term}</td>
                  <td className={tdCls + ' text-center'}>{r.inst}</td>
                  <td className={tdCls + (r.status === 'INSTALLED' ? ' text-green font-bold' : r.status === 'WIR READY' ? ' text-teal font-bold' : ' text-dgray')}>{r.status}</td>
                  <td className={tdCls + ' text-right font-bold'}>{r.pct}%</td>
                </tr>)
              })}
            </tbody></table>
          </div>
        )}

        {sectionOn('blockers') && (
          <div>
            {secTitle('blockers')}
            {openBlockers.length === 0 ? (
              <div className="text-[11px] text-green uppercase font-bold">NO OPEN BLOCKERS.</div>
            ) : (
              <table className="w-full"><thead><tr className="border-b border-border">
                <th className={thCls}>LOOP</th><th className={thCls}>BETWEEN</th><th className={thCls}>FLOOR</th><th className={thCls}>DESCRIPTION</th><th className={thCls + ' text-right'}>AGE</th>
              </tr></thead><tbody>
                {openBlockers.map(function(b) {
                  return (<tr key={b.id} className="border-b border-border/30">
                    <td className={tdCls + ' font-bold'}>{b.loop || '-'}</td>
                    <td className={tdCls + ' text-cyan'}>{b.from ? b.from + ' → ' + b.to : '-'}</td>
                    <td className={tdCls + ' text-orange'}>{b.floor || '-'}</td>
                    <td className={tdCls}>{b.text}</td>
                    <td className={tdCls + ' text-right text-red font-bold'}>{ageDays(b.createdAt)}</td>
                  </tr>)
                })}
              </tbody></table>
            )}
            <div className="text-[9px] text-dgray uppercase mt-1">{blockers.length - openBlockers.length} RESOLVED TO DATE</div>
          </div>
        )}

        {sectionOn('wir') && (
          <div>
            {secTitle('wir')}
            {wirReady.length === 0 ? (
              <div className="text-[11px] text-dgray uppercase">NO LOOPS CURRENTLY AWAITING INSPECTION.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {wirReady.map(function(r) {
                  return <span key={r.loop.id} className="px-2.5 py-1 bg-teal/15 text-teal rounded text-[10px] font-bold uppercase">{(r.loop.floor ? r.loop.floor + ' · ' : '') + r.loop.name} ({(r.loop.devices || []).length} DEV)</span>
                })}
              </div>
            )}
          </div>
        )}

        {sectionOn('commReg') && (
          <div>
            {secTitle('commReg')}
            <table className="w-full"><thead><tr className="border-b border-border">
              <th className={thCls}>LOOP</th><th className={thCls}>EQUIP TAG</th><th className={thCls}>TYPE</th><th className={thCls}>ROOM</th><th className={thCls + ' text-center'}>ADDR</th>
              {STAGES.map(function(s) { return <th key={s.k} className={thCls + ' text-center'}>{s.label}</th> })}
              <th className={thCls}>REMARKS</th>
            </tr></thead><tbody>
              {loops.map(function(l) {
                return (l.devices || []).map(function(d, di) {
                  return (<tr key={d.id} className="border-b border-border/20">
                    <td className={tdCls + ' text-dgray'}>{di === 0 ? l.name : ''}</td>
                    <td className={tdCls + ' font-bold'}>{d.tag}</td>
                    <td className={tdCls + ' text-purple'}>{d.device_type}</td>
                    <td className={tdCls}>{d.room_name || '-'}</td>
                    <td className={tdCls + ' text-center text-cyan'}>{d.address || '-'}</td>
                    {STAGES.map(function(s) { return <td key={s.k} className={tdCls + ' text-center'}>{d[s.k] ? <span className="text-green font-bold">✓</span> : <span className="text-dgray">·</span>}</td> })}
                    <td className={tdCls + ' text-orange italic text-[10px]'}>{d.remarks || ''}</td>
                  </tr>)
                })
              })}
            </tbody></table>
          </div>
        )}

        {sectionOn('trend') && (
          <div>
            {secTitle('trend')}
            {snapshots.length < 2 ? (
              <div className="text-[11px] text-dgray uppercase">COLLECTING DAILY PROGRESS DATA — TREND APPEARS AFTER A FEW DAYS OF USE.</div>
            ) : (
              <div>
                <div className="flex items-end gap-1 h-24 mb-1">
                  {snapshots.slice(-21).map(function(s) {
                    var pct = s.total ? Math.round(s.inst / s.total * 100) : 0
                    return <div key={s.id} title={fmtDate(s.snapped_at) + ': ' + s.inst + '/' + s.total + ' INSTALLED'} className="flex-1 bg-teal/70 rpt-fill rounded-t" style={{ height: Math.max(3, pct) + '%' }}></div>
                  })}
                </div>
                <div className="text-[9px] text-dgray uppercase mb-2">INSTALLED % BY DAY (LAST {Math.min(21, snapshots.length)} SNAPSHOTS)</div>
                {forecast && (
                  <div className="text-[11px] uppercase">
                    <span className="text-dgray">CURRENT VELOCITY: </span><span className="font-bold">{forecast.perDay} DEVICES/DAY</span>
                    {forecast.projectedDate && (<span><span className="text-dgray"> · REMAINING {counts.total - counts.inst} DEVICES · PROJECTED COMPLETE: </span><span className="font-bold text-teal">{fmtDate(forecast.projectedDate)} ({forecast.daysLeft} DAYS)</span></span>)}
                    {!forecast.projectedDate && (<span className="text-orange"> · NO INSTALLS IN RECENT WINDOW — PROJECTION UNAVAILABLE</span>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {sectionOn('notes') && (
          <div>
            {secTitle('notes')}
            <textarea value={cfg.notes} onChange={function(e) { setCfg('notes', up(e.target.value)) }} rows="3" placeholder="SITE NOTES, CONSTRAINTS, NEXT WEEK LOOK-AHEAD..." className="w-full bg-navy border border-border rounded px-3 py-2 text-[11px] text-white uppercase outline-none focus:border-teal" />
          </div>
        )}

        <div className="mt-8 pt-3 border-t border-border flex justify-between text-[9px] text-dgray uppercase">
          <span>GENERATED BY MINIMATE — LIVE SITE DATA AS OF {fmtDate(new Date())}</span>
          <span>SIGNATURE: ______________________</span>
        </div>
      </div>
    </div>
  )
}
