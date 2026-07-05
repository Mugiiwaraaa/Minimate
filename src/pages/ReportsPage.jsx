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
    preparedBy: '', notes: '', sections: {}, workItems: null
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
    if (st.done >= st.total) return <span className="text-green font-bold">✓</span>
    if (st.done > 0) return <span className="text-orange font-bold">{st.done}/{st.total}</span>
    return <span className="text-dgray">·</span>
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
    return <div className="text-[11px] font-extrabold text-teal uppercase tracking-widest mt-6 mb-2 border-b border-border pb-1">{no}. {def.label}</div>
  }

  // ─── Excel export ─────────────────────────────────────────
  function exportExcel() {
    if (!window.XLSX) { alert('SPREADSHEET LIBRARY NOT LOADED - CHECK CONNECTION AND RELOAD'); return }
    var X = window.XLSX
    var wb = X.utils.book_new()

    var summary = [
      ['MINIMATE PROGRESS REPORT'],
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
              <div className="text-sm font-bold text-teal uppercase mt-1">BMS COMMISSIONING PROGRESS REPORT</div>
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
            <div className="overflow-x-auto">
              <table className="w-full"><thead><tr className="border-b border-border">
                <th className={thCls}>S/N</th><th className={thCls}>DEVICES / ACTIVITY</th><th className={thCls}>UNIT</th><th className={thCls}>TEAMS</th><th className={thCls + ' text-center'}>DESIGN</th>
                {floorOrder.map(function(f) { return <th key={f} className={thCls + ' text-center'}>{f}</th> })}
                <th className={thCls + ' text-center'}>WORKDONE</th><th className={thCls + ' text-center'}>BALANCE</th><th className={thCls}>REMARK</th>
                {editWork && <th className={thCls + ' no-print'}></th>}
              </tr></thead><tbody>
                {workItems.map(function(it, i) {
                  var r = workRow(it)
                  var isAuto = it.kind === 'auto'
                  return (<tr key={it.id} className="border-b border-border/30">
                    <td className={tdCls + ' text-dgray'}>{i + 1}</td>
                    <td className={tdCls}>
                      {editWork ? <input value={it.label} onChange={function(e) { updItem(it.id, { label: up(e.target.value) }) }} className={inCls + ' w-full text-[11px] text-white'} /> : it.label}
                      {editWork && isAuto && (
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
                    <td className={tdCls + ' text-dgray'}>{editWork ? <input value={it.unit} onChange={function(e) { updItem(it.id, { unit: up(e.target.value) }) }} className={inCls + ' w-16 text-[11px] text-dgray'} /> : it.unit}</td>
                    <td className={tdCls}><input value={it.teams || ''} onChange={function(e) { updItem(it.id, { teams: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-16 text-[11px] text-lgray'} /></td>
                    <td className={tdCls + ' text-center'}><input value={it.design === null || it.design === undefined ? '' : it.design} onChange={function(e) { updItem(it.id, { design: e.target.value === '' ? null : e.target.value.replace(/[^0-9]/g, '') }) }} placeholder={it.kind === 'manual' ? '0' : String(r.liveDesign)} className={inCls + ' w-14 text-center text-[11px] text-white'} /></td>
                    {r.perFloor.map(function(n, fi) { return <td key={fi} className={tdCls + ' text-center text-dgray'}>{n === null ? '' : (n || '')}</td> })}
                    <td className={tdCls + ' text-center font-bold text-green'}>
                      {it.kind === 'manual' ? <input value={it.done || ''} onChange={function(e) { updItem(it.id, { done: e.target.value.replace(/[^0-9]/g, '') }) }} placeholder="0" className={inCls + ' w-14 text-center text-[11px] text-green font-bold'} /> : r.done}
                    </td>
                    <td className={tdCls + ' text-center ' + (r.balance > 0 ? 'text-orange' : 'text-green')}>{r.balance}</td>
                    <td className={tdCls}><input value={it.remark || ''} onChange={function(e) { updItem(it.id, { remark: up(e.target.value) }) }} placeholder="" className={inCls + ' w-full text-[10px] text-orange italic'} /></td>
                    {editWork && (<td className={tdCls + ' no-print whitespace-nowrap'}>
                      <button onClick={function() { moveItem(it.id, -1) }} className="text-dgray hover:text-teal px-0.5">▲</button>
                      <button onClick={function() { moveItem(it.id, 1) }} className="text-dgray hover:text-teal px-0.5">▼</button>
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
            <div className="overflow-x-auto">
              <table className="w-full"><thead><tr className="border-b border-border">
                <th className={thCls}>SR</th><th className={thCls}>LEVEL</th><th className={thCls}>ZONE</th><th className={thCls}>PART</th><th className={thCls}>PANEL NAME</th><th className={thCls}>LOCATION</th><th className={thCls + ' text-center'}>CANOPY</th><th className={thCls + ' text-center'}>DDC INSTALLATION</th><th className={thCls + ' text-center'}>CABLE PULLING</th><th className={thCls + ' text-center'}>PANEL TERMINATION</th><th className={thCls + ' text-center'}>FUNCTIONAL TEST</th><th className={thCls}>INSPECTIONS</th><th className={thCls}>REMARKS</th>
              </tr></thead><tbody>
                {schedPanels.map(function(p, i) {
                  var prevP = schedPanels[i - 1]
                  var lvl = up(p.floor || '')
                  var showLvl = !prevP || up(prevP.floor || '') !== lvl
                  return (<tr key={p.id} className="border-b border-border/30">
                    <td className={tdCls + ' text-dgray'}>{i + 1}</td>
                    <td className={tdCls + ' font-bold text-orange'}>{showLvl ? (lvl || '-') : ''}</td>
                    <td className={tdCls}><input value={p.zone || ''} onChange={function(e) { updPanel(p.id, { zone: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-16 text-[11px] text-lgray'} /></td>
                    <td className={tdCls}><input value={p.part || ''} onChange={function(e) { updPanel(p.id, { part: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-14 text-[11px] text-lgray'} /></td>
                    <td className={tdCls + ' font-bold text-cyan'}>{p.name}</td>
                    <td className={tdCls}>{p.location || '-'}</td>
                    <td className={tdCls + ' text-center'}>
                      <select value={p.canopy || 'N/A'} onChange={function(e) { updPanel(p.id, { canopy: e.target.value }) }} className="bg-transparent text-[10px] uppercase outline-none cursor-pointer text-lgray">
                        {CANOPY_OPTS.map(function(c) { return <option key={c} value={c}>{c}</option> })}
                      </select>
                    </td>
                    <td className={tdCls + ' text-center'}>
                      <button onClick={function() { updPanel(p.id, { installed: !p.installed }) }} className={'w-5 h-5 rounded border text-[10px] font-bold transition ' + (p.installed ? 'bg-green border-green text-white' : 'border-border text-dgray hover:border-teal')}>{p.installed ? '✓' : ''}</button>
                    </td>
                    <td className={tdCls + ' text-center'}>{statCell(panelStat(p, 'cable_pulled'))}</td>
                    <td className={tdCls + ' text-center'}>{statCell(panelStat(p, 'term_ddc_side'))}</td>
                    <td className={tdCls + ' text-center'}>{statCell(panelStat(p, 'functional_test'))}</td>
                    <td className={tdCls}><input value={p.inspection || ''} onChange={function(e) { updPanel(p.id, { inspection: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-20 text-[10px] text-teal'} /></td>
                    <td className={tdCls}><input value={p.remarks || ''} onChange={function(e) { updPanel(p.id, { remarks: up(e.target.value) }) }} placeholder="" className={inCls + ' w-full text-[10px] text-orange italic'} /></td>
                  </tr>)
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
