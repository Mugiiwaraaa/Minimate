import { useState, useCallback, useEffect, useRef } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import TraceStudio from './components/TraceStudio'
import Dashboard from './pages/Dashboard'
import PanelsList from './pages/PanelsList'
import PanelDetail from './pages/PanelDetail'
import CommDevices from './pages/CommDevices'
import DrawingsPage from './pages/DrawingsPage'
import BlockersPage from './pages/BlockersPage'
import ReportsPage from './pages/ReportsPage'
import DocumentsPage from './pages/DocumentsPage'
import GlobalImport from './components/GlobalImport'
import { listDocuments, archiveDocument, upsertDocument, deleteDocument } from './lib/docStore'
import { parseTermination, applyTermination } from './lib/terminationParser'
import ProjectSelector from './pages/ProjectSelector'
import { isDemo } from './lib/supabase'
import { loadProject, saveProjectData, flushPendingSave, onSaveConflict, setLoadedVersion, setLoadedData, onRemoteData, subscribeToProject, unsubscribeFromProject, autoBackup } from './lib/supabaseDb'
import { hashFile } from './lib/fileStore'
import { syncLoops, flushLoopOps, ensureBackfill, loadLoops, subscribeLoops, unsubscribeLoops, loopRowToLoop, deviceRowToDevice, isOwnEcho, fetchLoopDevices } from './lib/loopStore'
import { snapshotProgress } from './lib/reportStore'
import { smartParse, DOC_TYPES, DOC_LABELS } from './lib/smartParser'
import { FILE_KINDS, KIND_LABELS, PDF_KIND_CYCLE, IMAGE_KIND_CYCLE, isPdf, classifyFile, runImportSession } from './lib/importEngine'

function Placeholder(props) {
  return (
    <div className="text-center text-dgray mt-20">
      <h2 className="text-lg font-bold text-white mb-2">{props.title} - Coming in v0.2</h2>
      <p className="text-sm">{props.desc}</p>
    </div>
  )
}

// ─── Canonical loop device factory ─────────────────────────
// SINGLE source of truth for the device shape. Matches what
// CommDevices.jsx reads/writes: device_type, room_name, address,
// the 6 commissioning stages, remarks.
// Numeric address sort: "3" < "12" < "ADDR-20"; blanks go last
function addrNum(a) {
  var n = parseInt(String(a || '').replace(/[^0-9]/g, ''), 10)
  return isNaN(n) ? Infinity : n
}
function sortDevicesByAddress(devs) {
  var hasAddr = devs.some(function(d) { return addrNum(d.address) !== Infinity })
  if (!hasAddr) return devs
  return devs.slice().sort(function(a, b) { return addrNum(a.address) - addrNum(b.address) })
}

var deviceIdCounter = 0
function makeLoopDevice(tag, room, thermostat, address, serial) {
  var t = (tag || '').toUpperCase().trim()
  var device_type = 'DEVICE'
  if (t.indexOf('FCU') >= 0) device_type = 'FCU THERMOSTAT'
  else if (t.indexOf('VAV') >= 0) device_type = 'VAV'
  else if (t.indexOf('AHU') >= 0) device_type = 'AHU'
  else if (t.indexOf('PMU') >= 0 || t.indexOf('PM-') === 0) device_type = 'PMU'
  else if (t.indexOf('WM') === 0 || t.indexOf('WATER') >= 0) device_type = 'WATER METER'
  else if (t.indexOf('BTU') >= 0) device_type = 'BTU METER'
  deviceIdCounter++
  return {
    id: 'dev-' + Date.now() + '-' + deviceIdCounter,
    device_type: device_type,
    tag: t,
    room_name: (room || '').toUpperCase().trim(),
    thermostat: (thermostat || '').toUpperCase().trim(),
    serial: (serial || '').toUpperCase().trim(),
    address: (address || '').toUpperCase().trim(),
    comm_cable: false,
    control_cable: false,
    continuity: false,
    termination: false,
    device_installed: false,
    address_set: false,
    remarks: ''
  }
}

export default function App() {
  // ─── Project Selection ─────────────────────────────────────
  var projState = useState(null) // null = show selector, object = active project
  var activeProject = projState[0]
  var setActiveProject = projState[1]
  var projLoadingState = useState(false)
  var projectLoading = projLoadingState[0]
  var setProjectLoading = projLoadingState[1]

  // ─── App State ─────────────────────────────────────────────
  var panelsState = useState([])
  var panels = panelsState[0]
  var setPanels = panelsState[1]
  var eqState = useState({})
  var equipmentMap = eqState[0]
  var setEquipmentMap = eqState[1]
  var loopsState = useState([])
  var loops = loopsState[0]
  var setLoops = loopsState[1]
  var areasState = useState([])
  var areaGroups = areasState[0]
  var setAreaGroups = areasState[1]
  var termState = useState({})
  var terminationMap = termState[0]
  var setTerminationMap = termState[1]
  var drawingsState = useState([]) // drawing records: pins + traces (files cached in IndexedDB)
  var drawings = drawingsState[0]
  var setDrawings = drawingsState[1]
  var blockersState = useState([]) // cable issues + manual blockers
  var blockers = blockersState[0]
  var setBlockers = blockersState[1]
  var gatewaysState = useState([]) // gateways (Modbus) + RTRs (BACnet MSTP/IP routers)
  var gateways = gatewaysState[0]
  var setGateways = gatewaysState[1]
  var reportCfgState = useState({}) // report header + section toggles (per project)
  var reportConfig = reportCfgState[0]
  var setReportConfig = reportCfgState[1]
  var estScopeState = useState({}) // R2 estimate/design scope (as-designed layer)
  var estimateScope = estScopeState[0]
  var setEstimateScope = estScopeState[1]
  var gImpState = useState(null) // R2 global import: file awaiting route confirmation
  var gImpFile = gImpState[0]
  var setGImpFile = gImpState[1]
  var incomingEstState = useState(null) // estimate file handed to DocumentsPage
  var incomingEst = incomingEstState[0]
  var setIncomingEst = incomingEstState[1]
  var docsState = useState([]) // R2 document register (library)
  var documents = docsState[0]
  var setDocuments = docsState[1]
  var navigate = useNavigate()
  useEffect(function() {
    var pid = activeProject && activeProject.id
    if (!pid) { setDocuments([]); return }
    listDocuments(pid).then(function(d) { setDocuments(d || []) }).catch(function() { setDocuments([]) })
  }, [activeProject && activeProject.id])

  // Import preview modal state
  var ipState = useState(null)
  var importPreview = ipState[0]
  var setImportPreview = ipState[1]
  var exclState = useState({})
  var importExclusions = exclState[0]
  var setImportExclusions = exclState[1]
  var ipLoading = useState(false)
  var importLoading = ipLoading[0]
  var setImportLoading = ipLoading[1]

  // Drawing import state (unified: any mix of files)
  var drawState = useState(null) // null | {step, files:[{id,file,kind}], progress, result, error}
  var drawingImport = drawState[0]
  var setDrawingImport = drawState[1]

  // Save indicator
  var saveState = useState('idle') // idle | saving | saved | error
  var saveStatus = saveState[0]
  var setSaveStatus = saveState[1]

  // Multi-user save conflict (another user saved this project first)
  var conflictState = useState(false)
  var saveConflict = conflictState[0]
  var setSaveConflict = conflictState[1]

  // Trace Studio (in-app loop tracing on a drawing)
  var traceSessionState = useState(null) // null | { file: File, record: savedDrawing|null }
  var traceSession = traceSessionState[0]
  var setTraceSession = traceSessionState[1]

  // Undo system
  var undoRef = useRef([])
  var skipUndoRef = useRef(false)
  var stateRef = useRef({loops:[], areas:[], eq:{}, panels:[], term:{}})
  stateRef.current = {loops: loops, areas: areaGroups, eq: equipmentMap, panels: panels, term: terminationMap}

  // ─── Auto-save to Supabase on state changes ────────────────
  var initialLoadDone = useRef(false)
  var lastEditRef = useRef(0) // last REAL local edit — guards remote clobbering
  var prevLoopsRef = useRef([]) // last loops state synced to rows (M6).
  // Server-applied loop arrays are assigned to this ref BEFORE setState, so
  // the sync effect can tell them apart by REFERENCE — immune to React
  // batching a user tick together with a server patch.
  var activeProjectIdRef = useRef(null) // stable id for row-event handlers (closures)

  // M6 P2: LOOPS live in rows. A tick = one row upsert, not a blob save.
  useEffect(function() {
    if (!activeProject || !activeProject.id || isDemo) return
    if (!initialLoadDone.current) return
    if (loops === prevLoopsRef.current) return // server-originated array — already in rows
    lastEditRef.current = Date.now()
    syncLoops(activeProject.id, prevLoopsRef.current, loops)
    prevLoopsRef.current = loops
    setSaveStatus('saving')
    var t = setTimeout(function() { setSaveStatus('saved') }, 1200)
    var t2 = setTimeout(function() { setSaveStatus('idle') }, 3200)
    return function() { clearTimeout(t); clearTimeout(t2) }
  }, [loops])

  // Everything else stays in the versioned blob (3-way merged)
  useEffect(function() {
    if (!activeProject || !activeProject.id || isDemo) return
    if (!initialLoadDone.current) return // don't save during initial load
    lastEditRef.current = Date.now()
    var data = {
      panels: panels,
      equipmentMap: equipmentMap,
      terminationMap: terminationMap,
      areaGroups: areaGroups,
      drawings: drawings,
      blockers: blockers,
      gateways: gateways,
      reportConfig: reportConfig,
      estimateScope: estimateScope
    }
    setSaveStatus('saving')
    saveProjectData(activeProject.id, data)
    // Show saved indicator after debounce delay
    var t = setTimeout(function() { setSaveStatus('saved') }, 2000)
    var t2 = setTimeout(function() { setSaveStatus('idle') }, 4000)
    return function() { clearTimeout(t); clearTimeout(t2) }
  }, [panels, equipmentMap, terminationMap, areaGroups, drawings, blockers, gateways, reportConfig, estimateScope])

  // Flush save before page unload
  useEffect(function() {
    function onBeforeUnload() { flushPendingSave(); flushLoopOps() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return function() { window.removeEventListener('beforeunload', onBeforeUnload) }
  }, [])

  // ─── Stale-build guard ──────────────────────────────────────
  // One outdated client can overwrite fields newer builds manage.
  // Compare our loaded bundle hash against the currently deployed one
  // (poll + on window focus); mismatch = loud banner until refreshed.
  var updState = useState(false)
  var updateAvailable = updState[0]
  var setUpdateAvailable = updState[1]

  useEffect(function() {
    function checkBuild() {
      fetch('/?v=' + Date.now(), { cache: 'no-store' }).then(function(r) { return r.text() }).then(function(html) {
        var m = html.match(/index-([A-Za-z0-9_-]+)\.js/)
        if (!m) return // dev server — no hashed bundle
        var cur = ''
        var scripts = document.querySelectorAll('script[src*="index-"]')
        if (scripts.length > 0) cur = scripts[0].src || ''
        if (cur && cur.indexOf(m[1]) < 0) setUpdateAvailable(true)
      }).catch(function() { /* offline — ignore */ })
    }
    var iv = setInterval(checkBuild, 5 * 60 * 1000)
    window.addEventListener('focus', checkBuild)
    checkBuild()
    return function() { clearInterval(iv); window.removeEventListener('focus', checkBuild) }
  }, [])

  // ─── Save conflict handling (another user saved first) ─────
  useEffect(function() {
    onSaveConflict(function() {
      setSaveConflict(true)
      setSaveStatus('error')
    })
    // Remote/merged data: apply to state without triggering an echo save loop.
    // NEVER apply while the user is actively working (last edit < 4s ago) —
    // their own save will merge everything correctly anyway.
    onRemoteData(function(row) {
      if (!row || !row.data) return
      if (Date.now() - lastEditRef.current < 4000) return
      // M6 P2: loops live in rows now — blob updates never touch loop state
      initialLoadDone.current = false
      var d = row.data
      setPanels(d.panels || [])
      setEquipmentMap(d.equipmentMap || {})
      setTerminationMap(d.terminationMap || {})
      setAreaGroups(d.areaGroups || [])
      setDrawings(d.drawings || [])
      setBlockers(d.blockers || [])
      setGateways(d.gateways || [])
      setSaveConflict(false)
      setTimeout(function() { initialLoadDone.current = true }, 400)
    })
    return function() { onSaveConflict(null); onRemoteData(null) }
  }, [])

  function reloadFromServer() {
    if (!activeProject || !activeProject.id || isDemo) { setSaveConflict(false); return }
    initialLoadDone.current = false
    loadProject(activeProject.id, function(err, fullProject) {
      setSaveConflict(false)
      if (err || !fullProject) { console.error('[MINIMATE] Reload error:', err); initialLoadDone.current = true; return }
      var data = fullProject.data || {}
      setPanels(data.panels || [])
      setEquipmentMap(data.equipmentMap || {})
      setTerminationMap(data.terminationMap || {})
      // loops: rows are truth (M6 P2) — blob reload doesn't touch them
      setAreaGroups(data.areaGroups || [])
      setDrawings(data.drawings || [])
      setBlockers(data.blockers || [])
      setGateways(data.gateways || [])
      setReportConfig(data.reportConfig || {})
      setEstimateScope(data.estimateScope || {})
      setActiveProject(fullProject)
      setLoadedVersion(fullProject.version || 0)
      setLoadedData(data)
      undoRef.current = []
      setTimeout(function() { initialLoadDone.current = true }, 500)
    })
  }

  // Remote reorder: positions arrive one row at a time. Wait for the
  // burst to finish (500ms quiet), then apply the database's final order
  // for that loop in ONE settled update.
  var orderRefreshRef = useRef({})
  function scheduleLoopOrderRefresh(loopId) {
    var timers = orderRefreshRef.current
    if (timers[loopId]) clearTimeout(timers[loopId])
    timers[loopId] = setTimeout(function() {
      delete timers[loopId]
      var pid = activeProjectIdRef.current
      if (!pid) return
      fetchLoopDevices(pid, loopId, function(err, orderedDevs) {
        if (err || !orderedDevs) return
        setLoops(function(prev) {
          var next = prev.map(function(l) {
            if (l.id !== loopId) return l
            return Object.assign({}, l, { devices: orderedDevs })
          })
          prevLoopsRef.current = next // server-ordered: no echo ops
          return next
        })
      })
    }, 500)
  }

  // ─── M6 P3: apply one server row event to loop state ───────
  // A colleague's tick arrives as ONE device row — we patch just that.
  function handleLoopRowChange(table, payload) {
    var evt = payload.eventType
    var rowNew = payload.new
    var rowOld = payload.old
    // DELETE events aren't reliably filtered by project — check the PK.
    // (ref, not state: this closure outlives the render it was created in)
    var pid = (rowNew && rowNew.project_id) || (rowOld && rowOld.project_id)
    if (!activeProjectIdRef.current || pid !== activeProjectIdRef.current) return
    // Our own write bouncing back? Ignore it completely.
    if (evt !== 'DELETE' && isOwnEcho(table, rowNew)) return

    console.log('[M6] Applying remote ' + table + ' ' + evt + ' (' + ((rowNew && (rowNew.tag || rowNew.name || rowNew.id)) || (rowOld && rowOld.id)) + ')')
    setLoops(function(prev) {
      var next
      if (table === 'loops') {
        if (evt === 'DELETE') {
          var delId = rowOld && rowOld.id
          next = prev.filter(function(l) { return l.id !== delId })
        } else {
          var shell = loopRowToLoop(rowNew)
          var found = false
          next = prev.map(function(l) {
            if (l.id !== shell.id) return l
            found = true
            return Object.assign({}, l, shell, { devices: l.devices })
          })
          if (!found) next = next.concat([Object.assign({}, shell, { devices: [] })])
        }
      } else {
        if (evt === 'DELETE') {
          var dId = rowOld && rowOld.id
          next = prev.map(function(l) {
            return Object.assign({}, l, { devices: l.devices.filter(function(d) { return d.id !== dId }) })
          })
        } else {
          var dev = deviceRowToDevice(rowNew)
          var lid = rowNew.loop_id
          // Where does this device live on OUR screen right now?
          var currentLoopId = null
          prev.forEach(function(l) {
            if (l.devices.some(function(d) { return d.id === dev.id })) currentLoopId = l.id
          })
          if (currentLoopId === lid) {
            // Same loop: update fields IN PLACE (no jumping mid-work).
            // If the stored position disagrees with where it sits on our
            // screen, a colleague reordered — settle the order shortly.
            var curIdx = -1
            prev.forEach(function(l) {
              if (l.id !== lid) return
              l.devices.forEach(function(d, di) { if (d.id === dev.id) curIdx = di })
            })
            if (typeof rowNew.position === 'number' && rowNew.position !== curIdx) {
              scheduleLoopOrderRefresh(lid)
            }
            next = prev.map(function(l) {
              if (l.id !== lid) return l
              return Object.assign({}, l, {
                devices: l.devices.map(function(d) { return d.id === dev.id ? dev : d })
              })
            })
          } else {
            // Moved between loops, or brand new: remove everywhere,
            // insert into its loop at the stored position
            next = prev.map(function(l) {
              return Object.assign({}, l, { devices: l.devices.filter(function(d) { return d.id !== dev.id }) })
            })
            next = next.map(function(l) {
              if (l.id !== lid) return l
              var devs = l.devices.slice()
              var pos = Math.min(rowNew.position || devs.length, devs.length)
              devs.splice(pos, 0, dev)
              return Object.assign({}, l, { devices: devs })
            })
          }
        }
      }
      prevLoopsRef.current = next // server-originated: never echo row ops back
      return next
    })
  }

  // ─── Project Selection Handler ─────────────────────────────
  function handleSelectProject(project) {
    if (!project) {
      // Demo mode — just enter the app with empty state
      setActiveProject({ id: 'demo', name: 'DEMO PROJECT', client: '', location: '' })
      initialLoadDone.current = true
      return
    }

    setProjectLoading(true)
    loadProject(project.id, function(err, fullProject) {
      setProjectLoading(false)
      if (err) {
        console.error('[MINIMATE] Load error:', err)
        setActiveProject(project)
        initialLoadDone.current = true
        return
      }
      var data = (fullProject && fullProject.data) || {}
      setPanels(data.panels || [])
      setEquipmentMap(data.equipmentMap || {})
      setTerminationMap(data.terminationMap || {})
      setLoops(data.loops || [])
      setAreaGroups(data.areaGroups || [])
      setDrawings(data.drawings || [])
      setBlockers(data.blockers || [])
      setGateways(data.gateways || [])
      setReportConfig(data.reportConfig || {})
      setEstimateScope(data.estimateScope || {})
      setActiveProject(fullProject || project)
      activeProjectIdRef.current = (fullProject && fullProject.id) || null
      setLoadedVersion((fullProject && fullProject.version) || 0)
      setLoadedData(data)
      prevLoopsRef.current = data.loops || []
      if (fullProject && fullProject.id) {
        subscribeToProject(fullProject.id)
        // M6 P2: rows are the truth for loops; blob loops are the fallback
        loadLoops(fullProject.id, function(lerr, rowResult) {
          if (!lerr && rowResult && rowResult.hasRows) {
            prevLoopsRef.current = rowResult.loops
            setLoops(rowResult.loops)
            autoBackup(fullProject.id, fullProject.name, Object.assign({}, data, { loops: rowResult.loops }))
            snapshotProgress(fullProject.id, rowResult.loops) // R1: daily trend point
            // M6 P4: one-time scrub — old blobs still carry a stale loops
            // copy from before the cutover; save once without it
            if (data.loops && data.loops.length > 0) {
              console.log('[M6] P4: scrubbing legacy loops copy from project blob')
              saveProjectData(fullProject.id, {
                panels: data.panels || [],
                equipmentMap: data.equipmentMap || {},
                terminationMap: data.terminationMap || {},
                areaGroups: data.areaGroups || [],
                drawings: data.drawings || [],
                blockers: data.blockers || [],
                gateways: data.gateways || []
              })
            }
          } else {
            // No rows yet (or table missing): keep blob loops, backfill once
            ensureBackfill(fullProject.id, data.loops || [])
            autoBackup(fullProject.id, fullProject.name, data)
          }
          // M6 P3: live per-row events
          subscribeLoops(fullProject.id, handleLoopRowChange)
        })
      }
      // Allow auto-save after state is populated
      setTimeout(function() { initialLoadDone.current = true }, 500)
    })
  }

  function handleSwitchProject() {
    flushPendingSave()
    flushLoopOps()
    unsubscribeFromProject()
    unsubscribeLoops()
    initialLoadDone.current = false
    prevLoopsRef.current = []
    activeProjectIdRef.current = null
    setActiveProject(null)
    setPanels([])
    setEquipmentMap({})
    setTerminationMap({})
    setLoops([])
    setAreaGroups([])
    setDrawings([])
    setBlockers([])
    setGateways([])
    setReportConfig({})
    undoRef.current = []
  }

  // ─── Undo System ───────────────────────────────────────────
  function pushUndo() {
    var s = stateRef.current
    undoRef.current = undoRef.current.concat([{
      loops: JSON.parse(JSON.stringify(s.loops)),
      areas: JSON.parse(JSON.stringify(s.areas)),
      eq: JSON.parse(JSON.stringify(s.eq)),
      panels: JSON.parse(JSON.stringify(s.panels)),
      term: JSON.parse(JSON.stringify(s.term))
    }])
    if (undoRef.current.length > 30) undoRef.current = undoRef.current.slice(-30)
  }

  function handleUndo() {
    if (undoRef.current.length === 0) return
    var last = undoRef.current[undoRef.current.length - 1]
    undoRef.current = undoRef.current.slice(0, -1)
    skipUndoRef.current = true
    setLoops(last.loops)
    setAreaGroups(last.areas)
    setEquipmentMap(last.eq)
    setPanels(last.panels)
    setTerminationMap(last.term)
  }

  var canUndo = undoRef.current.length > 0

  useEffect(function() {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        handleUndo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return function() { window.removeEventListener('keydown', onKeyDown) }
  })

  // ─── Update Handlers ──────────────────────────────────────
  var handleUpdatePoint = useCallback(function(panelId, eqId, pointId, updates) {
    pushUndo()
    setEquipmentMap(function(prev) {
      var next = Object.assign({}, prev)
      var eqs = (next[panelId] || []).slice()
      var eqIdx = eqs.findIndex(function(e) { return e.id === eqId })
      if (eqIdx < 0) return prev
      var eq = Object.assign({}, eqs[eqIdx], { points: eqs[eqIdx].points.slice() })
      if (updates._updateEquipment) {
        delete updates._updateEquipment
        eq = Object.assign(eq, updates)
      } else if (pointId) {
        var ptIdx = eq.points.findIndex(function(p) { return p.id === pointId })
        if (ptIdx < 0) return prev
        eq.points[ptIdx] = Object.assign({}, eq.points[ptIdx], updates)
      }
      eqs[eqIdx] = eq
      next[panelId] = eqs
      return next
    })
  }, [])

  var handleUpdateLoops = useCallback(function(newLoops) {
    if (skipUndoRef.current) { skipUndoRef.current = false } else { pushUndo() }
    setLoops(newLoops)
  }, [])

  var handleUpdateAreas = useCallback(function(newAreas) {
    if (skipUndoRef.current) { skipUndoRef.current = false } else { pushUndo() }
    setAreaGroups(newAreas)
  }, [])

  var handleUpdateTermination = useCallback(function(panelId, newTermData) {
    pushUndo()
    setTerminationMap(function(prev) {
      var next = Object.assign({}, prev)
      next[panelId] = newTermData
      return next
    })
  }, [])

  function handleDeletePanel(panelId) {
    pushUndo()
    setPanels(function(prev) { return prev.filter(function(p) { return p.id !== panelId }) })
    setEquipmentMap(function(prev) {
      var next = Object.assign({}, prev)
      delete next[panelId]
      return next
    })
    setTerminationMap(function(prev) {
      var next = Object.assign({}, prev)
      delete next[panelId]
      return next
    })
  }

  // ─── Smart Parser Import Handler ────────────────────────
  function handleImportFile(e) {
    var file = e.target.files[0]
    if (!file) return
    setImportLoading(true)
    var context = {
      areas: areaGroups,
      panels: panels,
      equipmentMap: equipmentMap
    }
    smartParse(file, context, function(result) {
      setImportLoading(false)
      setImportExclusions({})
      setImportPreview(result)
    })
    e.target.value = ''
  }

  function confirmImport() {
    if (!importPreview) return
    pushUndo()

    var dt = importPreview.docType
    var excl = importExclusions

    // Filter helper: create filtered copy of import data based on exclusions
    function filterPanels(panelList) {
      if (!panelList) return []
      return panelList.filter(function(p) { return !excl['panel:' + p.id] })
    }
    function filterEquipMap(eqMap) {
      if (!eqMap) return {}
      var filtered = {}
      Object.keys(eqMap).forEach(function(pid) {
        if (!excl['panel:' + pid]) filtered[pid] = eqMap[pid]
      })
      return filtered
    }
    function filterDevices(devList) {
      if (!devList) return []
      return devList.filter(function(d) { return !excl['device:' + d.id] })
    }
    function filterAreas(areaList, filteredDevIds) {
      if (!areaList) return []
      return areaList.map(function(a) {
        return Object.assign({}, a, { device_ids: a.device_ids.filter(function(did) { return filteredDevIds.indexOf(did) >= 0 }) })
      }).filter(function(a) { return a.device_ids.length > 0 })
    }

    if (dt === DOC_TYPES.FCU_SCHEDULE || dt === DOC_TYPES.VAV_SCHEDULE) {
      var filtDevs = filterDevices(importPreview.devices)
      var filtDevIds = filtDevs.map(function(d) { return d.id })
      var filtAreas = filterAreas(importPreview.areas, filtDevIds)
      if (filtDevs.length > 0) {
        var ul = loops.find(function(l) { return l.id === 'loop-unassigned' })
        var newLoops = loops.slice()
        if (!ul) {
          ul = {id:'loop-unassigned', name:'UNASSIGNED', protocol:'MODBUS RTU', gateway:'', ddc_ref:'', floor:'', zone:'', devices:[]}
          newLoops.push(ul)
        }
        newLoops = newLoops.map(function(l) {
          if (l.id !== 'loop-unassigned') return l
          return Object.assign({}, l, {devices: l.devices.concat(filtDevs)})
        })
        setLoops(newLoops)
        setAreaGroups(areaGroups.concat(filtAreas))
      }
    }

    if (dt === DOC_TYPES.IO_LIST) {
      var filtPanels = filterPanels(importPreview.panels)
      if (filtPanels.length > 0) {
        setPanels(panels.concat(filtPanels))
      }
      var filtEq = filterEquipMap(importPreview.equipMap)
      if (Object.keys(filtEq).length > 0) {
        var newEq = Object.assign({}, equipmentMap)
        Object.keys(filtEq).forEach(function(pid) {
          newEq[pid] = filtEq[pid]
        })
        setEquipmentMap(newEq)
      }
    }

    if (dt === DOC_TYPES.DDC_TERMINATION) {
      // Filter panel updates and termination data
      var filtImport = Object.assign({}, importPreview)
      filtImport.newPanels = filterPanels(importPreview.newPanels)
      filtImport.panelUpdates = (importPreview.panelUpdates || []).filter(function(u) { return !excl['panel:' + u.panelId] })
      if (importPreview.terminationData) {
        filtImport.terminationData = {}
        Object.keys(importPreview.terminationData).forEach(function(pid) {
          if (!excl['panel:' + pid]) filtImport.terminationData[pid] = importPreview.terminationData[pid]
        })
      }
      applyPanelData(filtImport)
    }

    if (dt === DOC_TYPES.COMBINED) {
      // Apply filtered panel data
      var filtCombined = Object.assign({}, importPreview)
      filtCombined.newPanels = filterPanels(importPreview.newPanels)
      filtCombined.panelUpdates = (importPreview.panelUpdates || []).filter(function(u) { return !excl['panel:' + u.panelId] })
      if (importPreview.terminationData) {
        filtCombined.terminationData = {}
        Object.keys(importPreview.terminationData).forEach(function(pid) {
          if (!excl['panel:' + pid]) filtCombined.terminationData[pid] = importPreview.terminationData[pid]
        })
      }
      applyPanelData(filtCombined)

      // Apply filtered IO list data
      var filtEq2 = filterEquipMap(importPreview.equipMap)
      if (Object.keys(filtEq2).length > 0) {
        var newEq2 = Object.assign({}, equipmentMap)
        Object.keys(filtEq2).forEach(function(pid) {
          newEq2[pid] = filtEq2[pid]
        })
        setEquipmentMap(newEq2)
      }

      // Apply filtered field device data
      var filtDevs2 = filterDevices(importPreview.devices)
      if (filtDevs2.length > 0) {
        var filtDevIds2 = filtDevs2.map(function(d) { return d.id })
        var filtAreas2 = filterAreas(importPreview.areas, filtDevIds2)
        var ul2 = loops.find(function(l) { return l.id === 'loop-unassigned' })
        var newLoops2 = loops.slice()
        if (!ul2) {
          ul2 = {id:'loop-unassigned', name:'UNASSIGNED', protocol:'MODBUS RTU', gateway:'', ddc_ref:'', floor:'', zone:'', devices:[]}
          newLoops2.push(ul2)
        }
        newLoops2 = newLoops2.map(function(l) {
          if (l.id !== 'loop-unassigned') return l
          return Object.assign({}, l, {devices: l.devices.concat(filtDevs2)})
        })
        setLoops(newLoops2)
        if (filtAreas2.length > 0) {
          setAreaGroups(areaGroups.concat(filtAreas2))
        }
      }
    }

    setImportPreview(null)
    setImportExclusions({})
  }

  // Helper: apply panel schedule / termination data from import result
  function applyPanelData(importData) {
    if (importData.newPanels && importData.newPanels.length > 0) {
      setPanels(function(prev) {
        return prev.concat(importData.newPanels.map(function(p) {
          return {id: p.id, name: p.name, location: p.location, floor: p.floor}
        }))
      })
    }
    if (importData.panelUpdates && importData.panelUpdates.length > 0) {
      setPanels(function(prev) {
        return prev.map(function(p) {
          var upd = importData.panelUpdates.find(function(u) { return u.panelId === p.id })
          if (!upd) return p
          return Object.assign({}, p, {
            location: upd.location || p.location,
            floor: upd.floor || p.floor,
            zone: upd.zone,
            part: upd.part,
            progress: upd.progress,
            remarks: upd.remarks,
            size: upd.size,
            mounting: upd.mounting,
            canopy: upd.canopy
          })
        })
      })
    }
    if (importData.terminationData && Object.keys(importData.terminationData).length > 0) {
      setTerminationMap(function(prev) {
        var next = Object.assign({}, prev)
        Object.keys(importData.terminationData).forEach(function(pid) {
          next[pid] = importData.terminationData[pid]
        })
        return next
      })
    }
  }

  function cancelImport() {
    setImportPreview(null)
    setImportExclusions({})
  }

  function toggleExclude(key) {
    setImportExclusions(function(prev) {
      var next = Object.assign({}, prev)
      if (next[key]) { delete next[key] } else { next[key] = true }
      return next
    })
  }

  // ─── Unified Drawing Import Handlers ────────────────────
  var importFileIdRef = useRef(0)

  function handleDrawingImport() {
    setDrawingImport({ step: 'select', files: [], progress: [], result: null, error: null })
  }

  // ── R2 global import: one button, classify -> confirm -> route ──
  function handleGlobalImport(e) {
    var f = e && e.target && e.target.files && e.target.files[0]
    if (e && e.target) e.target.value = ''
    if (f) setGImpFile(f)
  }
  function fileToTable(file, cb) {
    if (!window.XLSX) { cb(null); return }
    var fr = new FileReader()
    fr.onload = function() {
      try {
        var wb = window.XLSX.read(new Uint8Array(fr.result), { type: 'array' })
        var aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
        var hi = 0
        for (var i = 0; i < aoa.length; i++) { if (aoa[i].some(function(c) { return ('' + c).trim() !== '' })) { hi = i; break } }
        var columns = (aoa[hi] || []).map(function(c) { return ('' + (c == null ? '' : c)).toUpperCase() })
        var rows = aoa.slice(hi + 1).filter(function(row) { return row.some(function(c) { return ('' + c).trim() !== '' }) }).map(function(row) { return columns.map(function(v, ci) { return row[ci] == null ? '' : ('' + row[ci]) }) })
        cb({ columns: columns, rows: rows })
      } catch (e) { cb(null) }
    }
    fr.onerror = function() { cb(null) }
    fr.readAsArrayBuffer(file)
  }
  function routeImport(file, dest) {
    setGImpFile(null)
    if (!file) return
    // archive EVERY import into the library register (best-effort)
    if (activeProject) {
      var docType = dest === 'drawing' ? 'DRAWING' : 'OTHER'
      var doArchive = function(table) {
        archiveDocument(activeProject, file, documents, { docType: docType, title: file.name, source: 'IMPORT', extracted: table ? { table: table } : {} })
          .then(function(doc) { if (doc) setDocuments(function(prev) { return prev.concat([doc]) }) }).catch(function() {})
      }
      if (/\.(xlsx|xls|csv)$/i.test(file.name || '')) { fileToTable(file, doArchive) } else { doArchive(null) }
    }
    if (dest === 'drawing') {
      importFileIdRef.current++
      var item = { id: 'if-' + importFileIdRef.current, file: file, kind: isPdf(file) ? null : FILE_KINDS.MARKED_PHOTO }
      setDrawingImport({ step: 'select', files: [item], progress: [], result: null, error: null })
      if (isPdf(file)) {
        classifyFile(file).then(function(kind) {
          setDrawingImport(function(prev) {
            if (!prev) return prev
            return Object.assign({}, prev, { files: prev.files.map(function(it) { return (it.id === item.id && it.kind === null) ? Object.assign({}, it, { kind: kind }) : it }) })
          })
        })
      }
      return
    }
    if (dest === 'termination') {
      if (!window.XLSX) { alert('SPREADSHEET LIBRARY NOT LOADED — RELOAD'); return }
      var trd = new FileReader()
      trd.onload = function() {
        try {
          var wbk = window.XLSX.read(new Uint8Array(trd.result), { type: 'array' })
          var parsed = parseTermination(wbk)
          var res = applyTermination(terminationMap, panels, parsed)
          setTerminationMap(res.terminationMap)
          alert('TERMINATION IMPORTED — ' + res.matched.length + ' DDC MATCHED' + (res.unmatched.length ? '; UNMATCHED: ' + res.unmatched.join(', ') : ''))
        } catch (err) { alert('TERMINATION IMPORT FAILED: ' + err) }
      }
      trd.readAsArrayBuffer(file)
      return
    }
    if (dest === 'data') { handleImportFile({ target: { files: [file], value: '' } }); return }
    if (dest === 'estimate') { setIncomingEst(file); navigate('/documents'); return }
    // 'library' — the archive above is the whole action
  }
  function updateDoc(doc) {
    setDocuments(function(prev) { return prev.map(function(d) { return d.id === doc.id ? doc : d }) })
    if (activeProject) upsertDocument(activeProject.id, doc).catch(function() {})
  }
  function deleteDoc(id) {
    setDocuments(function(prev) { return prev.filter(function(d) { return d.id !== id }) })
    if (activeProject) deleteDocument(activeProject.id, id).catch(function() {})
  }

  function handleDrawingFiles(e) {
    var picked = Array.prototype.slice.call(e.target.files || [])
    e.target.value = ''
    if (picked.length === 0) return

    var newItems = picked.map(function(file) {
      importFileIdRef.current++
      return { id: 'if-' + importFileIdRef.current, file: file, kind: isPdf(file) ? null : FILE_KINDS.MARKED_PHOTO }
    })

    setDrawingImport(function(prev) {
      if (!prev) return prev
      var files = prev.files.concat(newItems)
      // 2+ images in the session -> treat images as ONE ordered loop sequence.
      // User can cycle any image back to MARKED PHOTO (standalone sheet).
      var imgs = files.filter(function(it) { return !isPdf(it.file) })
      if (imgs.length >= 2) {
        files = files.map(function(it) {
          if (!isPdf(it.file) && it.kind === FILE_KINDS.MARKED_PHOTO) {
            return Object.assign({}, it, { kind: FILE_KINDS.PHOTO_SEQUENCE })
          }
          return it
        })
      }
      return Object.assign({}, prev, { files: files })
    })

    // Classify PDFs async (text layer check), then fill in kind
    newItems.forEach(function(item) {
      if (!isPdf(item.file)) return
      classifyFile(item.file).then(function(kind) {
        setDrawingImport(function(prev) {
          if (!prev) return prev
          return Object.assign({}, prev, {
            files: prev.files.map(function(it) {
              return (it.id === item.id && it.kind === null) ? Object.assign({}, it, { kind: kind }) : it
            })
          })
        })
      })
    })
  }

  function cycleFileKind(itemId) {
    setDrawingImport(function(prev) {
      if (!prev) return prev
      return Object.assign({}, prev, {
        files: prev.files.map(function(it) {
          if (it.id !== itemId || it.kind === null) return it
          var cycle = isPdf(it.file) ? PDF_KIND_CYCLE : IMAGE_KIND_CYCLE
          var next = cycle[(cycle.indexOf(it.kind) + 1) % cycle.length]
          return Object.assign({}, it, { kind: next })
        })
      })
    })
  }

  function removeImportFile(itemId) {
    setDrawingImport(function(prev) {
      if (!prev) return prev
      return Object.assign({}, prev, { files: prev.files.filter(function(it) { return it.id !== itemId }) })
    })
  }

  function moveImportFile(itemId, dir) {
    setDrawingImport(function(prev) {
      if (!prev) return prev
      var files = prev.files.slice()
      var idx = files.findIndex(function(it) { return it.id === itemId })
      var to = idx + dir
      if (idx < 0 || to < 0 || to >= files.length) return prev
      var tmp = files[idx]; files[idx] = files[to]; files[to] = tmp
      return Object.assign({}, prev, { files: files })
    })
  }

  function startDrawingAnalysis() {
    if (!drawingImport || drawingImport.files.length === 0) return
    if (drawingImport.files.some(function(it) { return it.kind === null })) return // still classifying
    var apiKey = localStorage.getItem('minimate_gemini_key') || ''
    if (!apiKey) {
      setDrawingImport(function(prev) { return Object.assign({}, prev, { step: 'apikey' }) })
      return
    }
    setDrawingImport(function(prev) { return Object.assign({}, prev, { step: 'processing', progress: ['Starting...'] }) })

    var items = drawingImport.files.map(function(it) { return { file: it.file, kind: it.kind } })
    runImportSession(items, apiKey, function(msg) {
      setDrawingImport(function(prev) {
        return Object.assign({}, prev, { progress: prev.progress.concat([msg]) })
      })
    }).then(function(result) {
      setDrawingImport(function(prev) { return Object.assign({}, prev, { step: 'preview', result: result }) })
    }).catch(function(err) {
      setDrawingImport(function(prev) { return Object.assign({}, prev, { step: 'error', error: err.message }) })
    })
  }

  function saveGeminiKey(key) {
    localStorage.setItem('minimate_gemini_key', key)
    setDrawingImport(function(prev) { return Object.assign({}, prev, { step: 'select' }) })
  }

  // ─── Trace Studio Handlers ──────────────────────────────
  function openTraceStudio(file) {
    setDrawingImport(null)
    setImportExclusions({})
    // If this exact file was traced before, reopen ITS record —
    // prevents duplicate drawings/loops from tracing the same PDF twice
    hashFile(file).then(function(hash) {
      var existing = drawings.find(function(d) { return d.fileHash === hash })
      setTraceSession({ file: file, record: existing || null })
    }).catch(function() {
      setTraceSession({ file: file, record: null })
    })
  }

  function handleOpenDrawing(record, file) {
    setTraceSession({ file: file, record: record })
  }

  function handleTraceCancel() {
    setTraceSession(null)
  }

  function handleTraceComplete(result, drawingRecord) {
    setTraceSession(null)
    // Upsert the drawing record (pins + traces + zones; file cached in IndexedDB)
    setDrawings(function(prev) {
      var found = false
      var next = prev.map(function(d) {
        if (d.id === drawingRecord.id) { found = true; return drawingRecord }
        return d
      })
      return found ? next : next.concat([drawingRecord])
    })
    // Apply directly — no preview, no re-import. Loops, blockers and zones
    // sync quietly into every view; re-trace replaces this drawing's own data.
    pushUndo()
    applyDrawingResult(result, {})
  }

  function handleUpdateDrawingMeta(id, fields) {
    setDrawings(function(prev) {
      return prev.map(function(d) {
        return d.id === id ? Object.assign({}, d, fields, { updatedAt: new Date().toISOString() }) : d
      })
    })
  }

  function handleDeleteDrawing(id) {
    setDrawings(function(prev) { return prev.filter(function(d) { return d.id !== id }) })
  }

  // ─── Backup: export / restore project as JSON ─────────────
  function handleExportProject() {
    var payload = {
      minimate: true,
      name: (activeProject && activeProject.name) || 'PROJECT',
      exportedAt: new Date().toISOString(),
      data: {
        panels: panels, equipmentMap: equipmentMap, terminationMap: terminationMap,
        loops: loops, areaGroups: areaGroups, drawings: drawings, blockers: blockers, gateways: gateways
      }
    }
    var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = payload.name.replace(/[^A-Z0-9]+/gi, '-') + '-BACKUP-' + new Date().toISOString().substring(0, 10) + '.json'
    a.click()
    setTimeout(function() { URL.revokeObjectURL(a.href) }, 5000)
  }

  function handleRestoreProject(e) {
    var file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    var reader = new FileReader()
    reader.onload = function() {
      try {
        var payload = JSON.parse(reader.result)
        var d = payload.data || payload // accept raw data objects too
        if (!d || (!d.loops && !d.panels)) { alert('NOT A MINIMATE BACKUP FILE'); return }
        if (!window.confirm('RESTORE BACKUP? THIS REPLACES THE CURRENT PROJECT DATA (CTRL+Z CAN UNDO ONCE).')) return
        pushUndo()
        setPanels(d.panels || [])
        setEquipmentMap(d.equipmentMap || {})
        setTerminationMap(d.terminationMap || {})
        setLoops(d.loops || [])
        setAreaGroups(d.areaGroups || [])
        setDrawings(d.drawings || [])
        setBlockers(d.blockers || [])
        setGateways(d.gateways || [])
      } catch (err) {
        alert('COULD NOT READ BACKUP: ' + err.message)
      }
    }
    reader.readAsText(file)
  }

  function confirmDrawingImport() {
    if (!drawingImport || !drawingImport.result) return
    pushUndo()
    applyDrawingResult(drawingImport.result, importExclusions)
    setDrawingImport(null)
    setImportExclusions({})
  }

  // Applies loops/blockers/zones from an AI import OR a trace session.
  // Trace DONE calls this directly — no preview, no re-import, subtle sync.
  function applyDrawingResult(result, drawExcl) {
    var did = result.drawingId || ''

    // Remember existing devices (by tag) so a RE-TRACE never wipes
    // commissioning progress, remarks or field-entered details
    var prevByTag = {}
    var prevLoopByName = {}
    loops.forEach(function(l) {
      if (l.source !== 'drawing') return
      if (l.name && !prevLoopByName[l.name]) prevLoopByName[l.name] = l
      l.devices.forEach(function(d) {
        if (d.tag && !prevByTag[d.tag]) prevByTag[d.tag] = d
      })
    })

    // Device-level replacement: re-trace of a drawing replaces ONLY devices
    // and remarks that came from that drawing. A loop can span floors
    // (traced across multiple drawings) — other floors' devices survive.
    var newLoops = loops.map(function(l) {
      if (!did || l.source !== 'drawing') return l
      var devs = l.devices.filter(function(d) { return d.drawingId !== did })
      if (devs.length === l.devices.length) return l
      return Object.assign({}, l, {
        devices: devs,
        cable_remarks: (l.cable_remarks || []).filter(function(r) { return r.drawingId !== did })
      })
    }).filter(function(l) {
      if (l.source !== 'drawing') return true
      // Legacy (pre-v3) loops from this drawing: whole-loop replace
      if (did && l.drawingId === did && l.devices.length > 0 && l.devices.every(function(d) { return !d.drawingId })) return false
      return l.devices.length > 0
    })

    // Create / merge loops from the drawing analysis or trace
    result.loops.forEach(function(loop) {
      if (drawExcl['dloop:' + loop.loopId]) return // excluded

      var loopDevices = loop.devices.filter(function(d) {
        return !drawExcl['ddev:' + d.tag]
      }).map(function(d) {
        // Canonical device shape — single source of truth (makeLoopDevice)
        var dev = makeLoopDevice(d.tag, d.room, d.thermostat, d.address, d.serial)
        dev.floor = result.floorLabel || ''
        dev.drawingId = did
        // Re-trace: carry over everything already earned on this device.
        // Same id keeps area/zone groups pointing at it.
        var old = prevByTag[dev.tag]
        if (old) {
          dev.id = old.id
          dev.comm_cable = !!old.comm_cable
          dev.control_cable = !!old.control_cable
          dev.continuity = !!old.continuity
          dev.termination = !!old.termination
          dev.device_installed = !!old.device_installed
          dev.address_set = !!old.address_set
          dev.remarks = old.remarks || ''
          if (!dev.address && old.address) dev.address = old.address
          if (!dev.serial && old.serial) dev.serial = old.serial
          if (!dev.room_name && old.room_name) dev.room_name = old.room_name
          if (!dev.thermostat && old.thermostat) dev.thermostat = old.thermostat
        }
        return dev
      })

      if (loopDevices.length === 0) return
      // Auto-sort by address (smallest → largest); traced order kept when no addresses
      loopDevices = sortDevicesByAddress(loopDevices)

      var remarks = (loop.cableRemarks || []).map(function(r) {
        return { from: r.from, to: r.to, text: r.text, drawingId: did }
      })

      // MULTI-FLOOR LOOPS: a traced loop with the same name already exists
      // (from another drawing/floor) — merge devices into it instead of duplicating
      var existing = newLoops.find(function(l) { return l.source === 'drawing' && l.name === loop.loopId })
      if (existing) {
        var have = {}
        existing.devices.forEach(function(d) { have[d.tag] = true })
        var added = loopDevices.filter(function(d) { return !have[d.tag] })
        newLoops = newLoops.map(function(l) {
          if (l.id !== existing.id) return l
          return Object.assign({}, l, {
            devices: l.devices.concat(added),
            cable_remarks: (l.cable_remarks || []).concat(remarks)
          })
        })
        return
      }

      // RE-TRACE: this loop existed before (its devices were all replaced
      // above, so it fell out of newLoops) — keep its id and every field
      // entered in loop view: gateway, zone, DDC ref, protocol. This is
      // what stops gateway assignments and zone names vanishing.
      var prevLoop = prevLoopByName[loop.loopId]
      var loopId = prevLoop ? prevLoop.id : ('loop-dwg-' + (did ? did + '-' : '') + loop.loopId.toLowerCase().replace(/[^a-z0-9]/g, '-'))
      newLoops.push({
        id: loopId,
        name: loop.loopId,
        protocol: (prevLoop && prevLoop.protocol) || 'MODBUS RTU',
        gateway: (prevLoop && prevLoop.gateway) || '',
        ddc_ref: loop.ddcPanel || (prevLoop && prevLoop.ddc_ref) || '',
        floor: result.floorLabel || (prevLoop && prevLoop.floor) || '',
        zone: (prevLoop && prevLoop.zone) || '',
        color: loop.color || (prevLoop && prevLoop.color) || '',
        source: 'drawing',
        drawingId: did,
        cable_remarks: remarks,
        devices: loopDevices
      })
    })

    // Cable-issue remarks -> Blockers board (replaced per drawing on re-trace)
    var newBlockers = blockers.filter(function(b) { return !(did && b.drawingId === did) })
    result.loops.forEach(function(loop) {
      if (drawExcl['dloop:' + loop.loopId]) return
      ;(loop.cableRemarks || []).forEach(function(r) {
        if (!r.text) return
        newBlockers.push({
          id: 'blk-' + Date.now() + '-' + Math.floor(Math.random() * 100000),
          text: r.text,
          loop: loop.loopId,
          from: r.from,
          to: r.to,
          floor: result.floorLabel || '',
          drawingId: did,
          source: 'TRACE',
          status: 'open',
          createdAt: new Date().toISOString()
        })
      })
    })
    setBlockers(newBlockers)

    // Zones drawn in Trace Studio -> location view groups (synced on every re-trace)
    if (result.zoneGroups && result.zoneGroups.length > 0) {
      var tagToId = {}
      newLoops.forEach(function(l) {
        l.devices.forEach(function(d) { if (d.tag && !tagToId[d.tag]) tagToId[d.tag] = d.id })
      })
      var newAreas = areaGroups.filter(function(a) {
        return !(result.drawingId && a.drawingId === result.drawingId)
      })
      result.zoneGroups.forEach(function(g) {
        var ids = g.deviceTags.map(function(t) { return tagToId[(t || '').toUpperCase()] }).filter(function(x) { return x })
        if (ids.length === 0) return
        newAreas.push({
          id: 'area-dwg-' + Date.now() + '-' + g.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
          name: (g.name || 'ZONE').toUpperCase(),
          notes: 'FROM DRAWING' + (result.floorLabel ? ' — ' + result.floorLabel : ''),
          drawingId: result.drawingId || '',
          device_ids: ids
        })
      })
      setAreaGroups(newAreas)
    }

    // Add unmatched devices to UNASSIGNED loop
    var unmatchedDevs = (result.unmatchedDevices || []).filter(function(d) {
      return !drawExcl['ddev:' + d.tag]
    })
    if (unmatchedDevs.length > 0) {
      var ul = newLoops.find(function(l) { return l.id === 'loop-unassigned' })
      if (!ul) {
        ul = { id: 'loop-unassigned', name: 'UNASSIGNED', protocol: 'MODBUS RTU', gateway: '', ddc_ref: '', floor: '', zone: '', devices: [] }
        newLoops.push(ul)
      }
      newLoops = newLoops.map(function(l) {
        if (l.id !== 'loop-unassigned') return l
        return Object.assign({}, l, {
          devices: l.devices.concat(unmatchedDevs.map(function(d) {
            return makeLoopDevice(d.tag, d.room, d.thermostat)
          }))
        })
      })
    }

    setLoops(newLoops)
    setDrawingImport(null)
    setImportExclusions({})
  }

  function cancelDrawingImport() {
    setDrawingImport(null)
    setImportExclusions({})
  }

  // ─── Drawing Import Modal Renderer ─────────────────────
  function renderDrawingModal() {
    if (!drawingImport) return null
    var di = drawingImport

    return (
      <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-3 md:p-6" onClick={cancelDrawingImport}>
        <div className="bg-card rounded-2xl border-2 border-teal p-4 md:p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={function(e){e.stopPropagation()}}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold uppercase text-teal">DRAWING IMPORT</h3>
            <span className="text-[10px] text-dgray uppercase">SHOP DRAWING ANALYSIS</span>
          </div>

          {di.step === 'apikey' && (
            <div>
              <div className="bg-orange/10 border border-orange/30 rounded-lg p-4 mb-4">
                <div className="text-xs text-orange font-bold uppercase mb-2">GEMINI API KEY REQUIRED</div>
                <div className="text-[10px] text-dgray mb-3">GET YOUR FREE KEY FROM AISTUDIO.GOOGLE.COM/APIKEY</div>
                <input id="gemini-key-input" type="text" placeholder="PASTE YOUR GEMINI API KEY HERE" className="w-full bg-navy border border-border rounded px-3 py-2 text-xs text-white uppercase placeholder:text-dgray/50" />
              </div>
              <div className="flex gap-3">
                <button onClick={function(){var inp=document.getElementById('gemini-key-input');if(inp&&inp.value.trim()){saveGeminiKey(inp.value.trim())}}} className="px-6 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 uppercase">SAVE KEY</button>
                <button onClick={cancelDrawingImport} className="px-6 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white uppercase">CANCEL</button>
              </div>
            </div>
          )}

          {di.step === 'select' && (
            <div>
              <div className="text-[10px] text-dgray uppercase mb-3">ADD ANY MIX: CAD PDF, SCANNED MARKED DRAWING, MARKED PHOTOS, OR ZOOMED LOOP PHOTOS (IN ORDER)</div>

              <label className="block rounded-xl border-2 border-dashed border-border hover:border-teal/50 p-5 text-center transition cursor-pointer mb-3">
                <div className="text-2xl mb-1">📥</div>
                <div className="text-[11px] font-bold uppercase text-white mb-1">ADD FILES</div>
                <div className="text-[9px] text-dgray uppercase">PDF OR IMAGES — SELECT MULTIPLE AT ONCE</div>
                <input type="file" accept=".pdf,image/*" multiple onChange={handleDrawingFiles} className="hidden"/>
              </label>

              {di.files.length > 0 && (
                <div className="bg-navy rounded-lg p-2 mb-3 max-h-56 overflow-y-auto">
                  {di.files.map(function(it, idx) {
                    var kindColor = it.kind === 'CAD_PDF' ? 'bg-teal/20 text-teal' : it.kind === 'MARKED_SCAN' ? 'bg-orange/20 text-orange' : it.kind === 'PHOTO_SEQUENCE' ? 'bg-purple/20 text-purple' : 'bg-cyan/20 text-cyan'
                    var isSeq = it.kind === 'PHOTO_SEQUENCE'
                    return (
                      <div key={it.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-card/50">
                        <span className="text-sm">{isPdf(it.file) ? '📐' : '📸'}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] text-white uppercase truncate">{isSeq ? (idx + 1) + '. ' : ''}{it.file.name}</div>
                          <div className="text-[8px] text-dgray uppercase">{(it.file.size/1024/1024).toFixed(1)} MB</div>
                        </div>
                        {it.kind === null ? (
                          <span className="text-[8px] px-2 py-0.5 rounded bg-card2 text-dgray uppercase animate-pulse">DETECTING...</span>
                        ) : (
                          <button onClick={function(){cycleFileKind(it.id)}} title="CLICK TO CHANGE TYPE" className={'text-[8px] px-2 py-0.5 rounded uppercase font-bold transition hover:opacity-70 ' + kindColor}>
                            {KIND_LABELS[it.kind]}
                          </button>
                        )}
                        <button onClick={function(){openTraceStudio(it.file)}} title="OPEN THE DRAWING AND TRACE LOOPS YOURSELF" className="text-[8px] px-2 py-0.5 rounded uppercase font-bold bg-green/20 text-green hover:bg-green/30 transition">
                          ✏️ TRACE
                        </button>
                        {isSeq && (
                          <span className="flex gap-0.5">
                            <button onClick={function(){moveImportFile(it.id, -1)}} className="text-[10px] text-dgray hover:text-white px-1">↑</button>
                            <button onClick={function(){moveImportFile(it.id, 1)}} className="text-[10px] text-dgray hover:text-white px-1">↓</button>
                          </span>
                        )}
                        <button onClick={function(){removeImportFile(it.id)}} className="text-[10px] text-dgray hover:text-red px-1">✕</button>
                      </div>
                    )
                  })}
                </div>
              )}

              {di.files.some(function(it){return it.kind === 'PHOTO_SEQUENCE'}) && (
                <div className="text-[9px] text-purple uppercase mb-3">LOOP PHOTO SEQ: ALL SEQUENCE PHOTOS FORM ONE LOOP — ORDER THEM ALONG THE PATH WITH ↑↓</div>
              )}

              <div className="flex gap-3">
                <button onClick={startDrawingAnalysis} disabled={di.files.length === 0 || di.files.some(function(it){return it.kind === null})} className={'px-6 py-2 text-xs font-bold rounded-md uppercase transition ' + (di.files.length > 0 && !di.files.some(function(it){return it.kind === null}) ? 'bg-teal text-white hover:bg-teal/80' : 'bg-card2 text-dgray cursor-not-allowed')}>
                  ANALYZE {di.files.length > 0 ? di.files.length + ' FILE' + (di.files.length > 1 ? 'S' : '') : 'DRAWINGS'}
                </button>
                <button onClick={cancelDrawingImport} className="px-6 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white uppercase">CANCEL</button>
              </div>
              {localStorage.getItem('minimate_gemini_key') && (
                <div className="mt-3 text-[9px] text-dgray uppercase">GEMINI KEY: ...{localStorage.getItem('minimate_gemini_key').slice(-6)} <button onClick={function(){setDrawingImport(function(p){return Object.assign({},p,{step:'apikey'})})}} className="text-orange hover:text-white ml-2">CHANGE KEY</button></div>
              )}
            </div>
          )}

          {di.step === 'processing' && (
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-6 h-6 border-2 border-teal border-t-transparent rounded-full animate-spin"></div>
                <div className="text-xs text-white uppercase font-bold">ANALYZING DRAWINGS...</div>
              </div>
              <div className="bg-navy rounded-lg p-3 max-h-48 overflow-y-auto">
                {di.progress.map(function(msg, i) {
                  return <div key={i} className="text-[10px] text-dgray uppercase py-0.5">{i === di.progress.length - 1 ? <span className="text-teal">{msg}</span> : msg}</div>
                })}
              </div>
            </div>
          )}

          {di.step === 'error' && (
            <div>
              <div className="bg-red/10 border border-red/30 rounded-lg p-4 mb-4">
                <div className="text-xs text-red font-bold uppercase mb-1">ANALYSIS FAILED</div>
                <div className="text-[10px] text-dgray">{di.error}</div>
              </div>
              <div className="flex gap-3">
                <button onClick={function(){setDrawingImport(function(p){return Object.assign({},p,{step:'select',error:null})})}} className="px-6 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 uppercase">TRY AGAIN</button>
                <button onClick={cancelDrawingImport} className="px-6 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white uppercase">CANCEL</button>
              </div>
            </div>
          )}

          {di.step === 'preview' && di.result && (
            <div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">LOOPS</div><div className="text-2xl font-extrabold text-teal">{di.result.loops.length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">MATCHED DEVICES</div><div className="text-2xl font-extrabold text-cyan">{di.result.loops.reduce(function(s,l){return s+l.deviceCount},0)}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">UNMATCHED</div><div className="text-2xl font-extrabold text-orange">{(di.result.unmatchedDevices||[]).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">PDF DEVICES</div><div className="text-2xl font-extrabold text-dgray">{di.result.pdfStats.totalDevices}</div></div>
              </div>

              {di.result.floorLabel && (
                <div className="text-[10px] text-teal uppercase font-bold mb-3">FLOOR: {di.result.floorLabel}</div>
              )}

              <div className="text-[10px] text-dgray uppercase mb-2">LOOPS — CLICK TO INCLUDE/EXCLUDE</div>
              <div className="max-h-60 overflow-y-auto bg-navy rounded-lg p-3 mb-4">
                {di.result.loops.map(function(loop) {
                  var loopExcl = importExclusions['dloop:' + loop.loopId]
                  return (
                    <div key={loop.loopId} className={'mb-3 rounded-lg p-3 border transition ' + (loopExcl ? 'border-dgray/20 opacity-40' : 'border-teal/30 bg-teal/5')}>
                      <div className="flex items-center justify-between mb-2 cursor-pointer" onClick={function(){toggleExclude('dloop:'+loop.loopId)}}>
                        <div className="flex items-center gap-2">
                          <span className={'inline-block w-3 h-3 rounded border ' + (loopExcl ? 'border-dgray bg-transparent' : 'border-teal bg-teal')} style={{lineHeight:'12px',fontSize:'8px',color:'white'}}>{loopExcl ? '' : '✓'}</span>
                          <span className={'text-xs font-bold uppercase ' + (loopExcl ? 'text-dgray line-through' : 'text-white')}>{loop.loopId}</span>
                          {loop.color && <span className="text-[9px] text-dgray uppercase">({loop.color})</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          {loop.ddcPanel && <span className="text-[9px] text-cyan uppercase">{loop.ddcPanel}</span>}
                          <span className="text-[10px] text-dgray">{loop.deviceCount} DEVICES</span>
                        </div>
                      </div>
                      {!loopExcl && (
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                          {loop.devices.map(function(d) {
                            var devExcl = importExclusions['ddev:' + d.tag]
                            return (
                              <button key={d.tag} onClick={function(){toggleExclude('ddev:'+d.tag)}} className={'text-left px-2 py-1 rounded text-[10px] transition ' + (devExcl ? 'bg-red/10 text-dgray line-through opacity-50' : 'bg-card/50 text-white')}>
                                <div>{d.tag}</div>
                                {d.room && <div className="text-[8px] text-dgray truncate">{d.room}</div>}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {(di.result.unmatchedDevices||[]).length > 0 && (
                <div className="mb-4">
                  <div className="text-[10px] text-orange uppercase font-bold mb-2">UNMATCHED PDF DEVICES (WILL GO TO UNASSIGNED)</div>
                  <div className="grid grid-cols-3 md:grid-cols-4 gap-1">
                    {di.result.unmatchedDevices.map(function(d) {
                      var devExcl = importExclusions['ddev:' + d.tag]
                      return (
                        <button key={d.tag} onClick={function(){toggleExclude('ddev:'+d.tag)}} className={'text-left px-2 py-1 rounded text-[9px] transition ' + (devExcl ? 'bg-red/10 text-dgray line-through opacity-50' : 'bg-orange/10 text-orange')}>
                          {d.tag}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="flex gap-3 mt-4">
                <button onClick={confirmDrawingImport} className="px-6 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 uppercase">
                  {Object.keys(importExclusions).length > 0 ? 'CONFIRM IMPORT (' + Object.keys(importExclusions).length + ' EXCLUDED)' : 'CONFIRM IMPORT'}
                </button>
                <button onClick={function(){setDrawingImport(function(p){return Object.assign({},p,{step:'select',result:null})})}} className="px-6 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white uppercase">BACK</button>
                <button onClick={cancelDrawingImport} className="px-6 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white uppercase">CANCEL</button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ─── Import Preview Modal Renderer ──────────────────────
  function renderImportModal() {
    if (!importPreview) return null
    var r = importPreview
    var dt = r.docType

    return (
      <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-3 md:p-6" onClick={cancelImport}>
        <div className="bg-card rounded-2xl border-2 border-orange p-4 md:p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={function(e){e.stopPropagation()}}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold uppercase text-orange">IMPORT PREVIEW</h3>
            <div className="flex items-center gap-2">
              <span className="text-[10px] bg-teal/20 text-teal px-2 py-0.5 rounded uppercase font-semibold">{r.docLabel || 'UNKNOWN'}</span>
              <span className="text-[10px] text-dgray uppercase">{r.fileName}</span>
            </div>
          </div>

          {dt === DOC_TYPES.UNKNOWN && (
            <div className="bg-red/10 border border-red/30 rounded-lg p-4 mb-4">
              <div className="text-xs text-red font-bold uppercase mb-1">COULD NOT DETECT DOCUMENT TYPE</div>
              <div className="text-[10px] text-dgray">SUPPORTED: FCU SCHEDULE, VAV SCHEDULE, IO LIST, DDC TERMINATION SHEET</div>
              {r.sheetNames && <div className="text-[10px] text-dgray mt-1">SHEETS FOUND: {r.sheetNames.join(', ')}</div>}
            </div>
          )}

          {(dt === DOC_TYPES.FCU_SCHEDULE || dt === DOC_TYPES.VAV_SCHEDULE) && (
            <div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TOTAL DEVICES</div><div className="text-2xl font-extrabold text-cyan">{r.devices.filter(function(d){return !importExclusions['device:'+d.id]}).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">AREA GROUPS</div><div className="text-2xl font-extrabold text-cyan">{r.areas.length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">COMM CABLE DONE</div><div className="text-2xl font-extrabold text-green">{r.devices.filter(function(d){return d.comm_cable && !importExclusions['device:'+d.id]}).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">EXCLUDED</div><div className="text-2xl font-extrabold text-orange">{r.devices.filter(function(d){return importExclusions['device:'+d.id]}).length}</div></div>
              </div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] text-dgray uppercase">CLICK DEVICES TO INCLUDE/EXCLUDE</div>
                <div className="flex gap-2">
                  <button onClick={function(){var ex={};r.devices.forEach(function(d){ex['device:'+d.id]=true});setImportExclusions(Object.assign({},importExclusions,ex))}} className="text-[9px] text-orange hover:text-white transition">DESELECT ALL</button>
                  <button onClick={function(){var ex=Object.assign({},importExclusions);r.devices.forEach(function(d){delete ex['device:'+d.id]});setImportExclusions(ex)}} className="text-[9px] text-teal hover:text-white transition">SELECT ALL</button>
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto mb-4 bg-navy rounded-lg p-3">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                {r.devices.map(function(d){
                  var excluded = importExclusions['device:'+d.id]
                  return <button key={d.id} onClick={function(){toggleExclude('device:'+d.id)}} className={'text-left px-2 py-1 rounded text-[10px] transition ' + (excluded ? 'bg-red/10 text-dgray line-through opacity-50' : 'bg-teal/10 text-white')}>
                    {d.tag || d.id}
                  </button>
                })}
                </div>
              </div>
            </div>
          )}

          {dt === DOC_TYPES.IO_LIST && (
            <div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">{r.updated.length > 0 ? 'NEW PANELS' : 'PANELS'}</div><div className="text-2xl font-extrabold text-cyan">{Object.keys(r.equipMap).filter(function(pid){return !importExclusions['panel:'+pid]}).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">EQUIPMENT</div><div className="text-2xl font-extrabold text-cyan">{Object.keys(r.equipMap).filter(function(pid){return !importExclusions['panel:'+pid]}).reduce(function(s,pid){return s+r.equipMap[pid].length},0)}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">IO POINTS</div><div className="text-2xl font-extrabold text-cyan">{Object.keys(r.equipMap).filter(function(pid){return !importExclusions['panel:'+pid]}).reduce(function(s,pid){var c=0;r.equipMap[pid].forEach(function(eq){eq.points.forEach(function(pt){c+=pt.qty})});return s+c},0)}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">EXCLUDED</div><div className="text-2xl font-extrabold text-orange">{Object.keys(r.equipMap).filter(function(pid){return importExclusions['panel:'+pid]}).length}</div></div>
              </div>
              {r.updated.length > 0 && (
                <div className="bg-orange/10 border border-orange/30 rounded-lg p-3 mb-4">
                  <div className="text-[10px] text-orange font-bold uppercase mb-1">UPDATING EXISTING PANELS:</div>
                  <div className="text-[10px] text-dgray uppercase">{r.updated.join(', ')}</div>
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] text-dgray uppercase">CLICK PANELS TO INCLUDE/EXCLUDE</div>
                <div className="flex gap-2">
                  <button onClick={function(){var ex={};Object.keys(r.equipMap).forEach(function(pid){ex['panel:'+pid]=true});setImportExclusions(Object.assign({},importExclusions,ex))}} className="text-[9px] text-orange hover:text-white transition">DESELECT ALL</button>
                  <button onClick={function(){var ex=Object.assign({},importExclusions);Object.keys(r.equipMap).forEach(function(pid){delete ex['panel:'+pid]});setImportExclusions(ex)}} className="text-[9px] text-teal hover:text-white transition">SELECT ALL</button>
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto mb-4 bg-navy rounded-lg p-3">
                <table className="w-full text-[10px]"><thead><tr className="border-b border-border/50 text-dgray"><th className="w-6"></th><th className="text-left py-1 px-2">PANEL</th><th className="text-center py-1 px-2">EQUIPMENT</th><th className="text-center py-1 px-2">POINTS</th></tr></thead><tbody>
                {Object.keys(r.equipMap).map(function(pid){
                  var eqs = r.equipMap[pid]
                  var pName = ''
                  r.panels.forEach(function(p){if(p.id===pid)pName=p.name})
                  if(!pName) panels.forEach(function(p){if(p.id===pid)pName=p.name})
                  var ptCount = 0; eqs.forEach(function(eq){eq.points.forEach(function(pt){ptCount+=pt.qty})})
                  var excluded = importExclusions['panel:'+pid]
                  return <tr key={pid} onClick={function(){toggleExclude('panel:'+pid)}} className={'border-b border-border/20 cursor-pointer transition ' + (excluded ? 'opacity-40' : 'hover:bg-teal/5')}>
                    <td className="py-1 px-1 text-center"><span className={'inline-block w-3 h-3 rounded border ' + (excluded ? 'border-dgray bg-transparent' : 'border-teal bg-teal')} style={{lineHeight:'12px',fontSize:'8px',color:'white'}}>{excluded ? '' : '✓'}</span></td>
                    <td className={'py-1 px-2 uppercase ' + (excluded ? 'text-dgray line-through' : 'text-white')}>{pName||pid}</td>
                    <td className="text-center py-1 px-2 text-cyan">{eqs.length}</td>
                    <td className="text-center py-1 px-2 text-cyan">{ptCount}</td>
                  </tr>
                })}
                </tbody></table>
              </div>
            </div>
          )}

          {dt === DOC_TYPES.DDC_TERMINATION && (
            <div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">PANELS UPDATED</div><div className="text-2xl font-extrabold text-green">{(r.panelUpdates||[]).filter(function(u){return !importExclusions['panel:'+u.panelId]}).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">NEW PANELS</div><div className="text-2xl font-extrabold text-cyan">{(r.newPanels||[]).filter(function(p){return !importExclusions['panel:'+p.id]}).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TERM SHEETS</div><div className="text-2xl font-extrabold text-teal">{r.termPanelCount || 0}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">EXCLUDED</div><div className="text-2xl font-extrabold text-orange">{(r.panelUpdates||[]).filter(function(u){return importExclusions['panel:'+u.panelId]}).length + (r.newPanels||[]).filter(function(p){return importExclusions['panel:'+p.id]}).length}</div></div>
              </div>
              {(r.panelUpdates||[]).length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] text-dgray uppercase">CLICK PANELS TO INCLUDE/EXCLUDE</div>
                    <div className="flex gap-2">
                      <button onClick={function(){var ex={};(r.panelUpdates||[]).forEach(function(u){ex['panel:'+u.panelId]=true});(r.newPanels||[]).forEach(function(p){ex['panel:'+p.id]=true});setImportExclusions(Object.assign({},importExclusions,ex))}} className="text-[9px] text-orange hover:text-white transition">DESELECT ALL</button>
                      <button onClick={function(){var ex=Object.assign({},importExclusions);(r.panelUpdates||[]).forEach(function(u){delete ex['panel:'+u.panelId]});(r.newPanels||[]).forEach(function(p){delete ex['panel:'+p.id]});setImportExclusions(ex)}} className="text-[9px] text-teal hover:text-white transition">SELECT ALL</button>
                    </div>
                  </div>
                  <div className="max-h-40 overflow-y-auto mb-4 bg-navy rounded-lg p-3">
                    <table className="w-full text-[10px]"><thead><tr className="border-b border-border/50 text-dgray"><th className="w-6"></th><th className="text-left py-1 px-2">PANEL</th><th className="text-center py-1 px-2">ENCL</th><th className="text-center py-1 px-2">ASSEMBLED</th><th className="text-center py-1 px-2">DDC</th><th className="text-center py-1 px-2">CABLE</th><th className="text-center py-1 px-2">TERM</th><th className="text-center py-1 px-2">INSP</th></tr></thead><tbody>
                    {r.panelUpdates.map(function(u){
                      var excluded = importExclusions['panel:'+u.panelId]
                      return <tr key={u.panelId} onClick={function(){toggleExclude('panel:'+u.panelId)}} className={'border-b border-border/20 cursor-pointer transition ' + (excluded ? 'opacity-40' : 'hover:bg-teal/5')}>
                      <td className="py-1 px-1 text-center"><span className={'inline-block w-3 h-3 rounded border ' + (excluded ? 'border-dgray bg-transparent' : 'border-teal bg-teal')} style={{lineHeight:'12px',fontSize:'8px',color:'white'}}>{excluded ? '' : '✓'}</span></td>
                      <td className={'py-1 px-2 uppercase ' + (excluded ? 'text-dgray line-through' : 'text-white')}>{u.panelName}</td>
                      <td className="text-center py-1 px-2">{u.progress.enclosure?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                      <td className="text-center py-1 px-2">{u.progress.assembled?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                      <td className="text-center py-1 px-2">{u.progress.ddcInstall?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                      <td className="text-center py-1 px-2">{u.progress.cablePull?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                      <td className="text-center py-1 px-2">{u.progress.termination?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                      <td className="text-center py-1 px-2">{u.progress.inspection?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                    </tr>})}
                    </tbody></table>
                  </div>
                </div>
              )}
            </div>
          )}

          {dt === DOC_TYPES.COMBINED && (
            <div>
              <div className="text-[10px] text-teal font-bold uppercase mb-3">FOUND MULTIPLE DATA TYPES IN THIS FILE</div>

              {/* Panel section */}
              {((r.newPanels && r.newPanels.length > 0) || (r.panelUpdates && r.panelUpdates.length > 0)) && (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] text-cyan font-bold uppercase">DDC PANELS — CLICK TO INCLUDE/EXCLUDE</div>
                    <div className="flex gap-2">
                      <button onClick={function(){var ex={};(r.newPanels||[]).forEach(function(p){ex['panel:'+p.id]=true});(r.panelUpdates||[]).forEach(function(u){ex['panel:'+u.panelId]=true});setImportExclusions(Object.assign({},importExclusions,ex))}} className="text-[9px] text-orange hover:text-white transition">DESELECT ALL</button>
                      <button onClick={function(){var ex=Object.assign({},importExclusions);(r.newPanels||[]).forEach(function(p){delete ex['panel:'+p.id]});(r.panelUpdates||[]).forEach(function(u){delete ex['panel:'+u.panelId]});setImportExclusions(ex)}} className="text-[9px] text-teal hover:text-white transition">SELECT ALL</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">NEW PANELS</div><div className="text-xl font-extrabold text-cyan">{(r.newPanels||[]).filter(function(p){return !importExclusions['panel:'+p.id]}).length}</div></div>
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">UPDATED</div><div className="text-xl font-extrabold text-green">{(r.panelUpdates||[]).filter(function(u){return !importExclusions['panel:'+u.panelId]}).length}</div></div>
                    {r.termPanelCount > 0 && <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TERM SHEETS</div><div className="text-xl font-extrabold text-teal">{r.termPanelCount}</div></div>}
                    {r.totalPoints > 0 && <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">IO POINTS</div><div className="text-xl font-extrabold text-cyan">{r.totalPoints}</div></div>}
                  </div>
                  {(r.newPanels||[]).length > 0 && (
                    <div className="max-h-28 overflow-y-auto bg-navy rounded-lg p-2">
                      <table className="w-full text-[10px]"><tbody>
                      {r.newPanels.map(function(p){
                        var excluded = importExclusions['panel:'+p.id]
                        return <tr key={p.id} onClick={function(){toggleExclude('panel:'+p.id)}} className={'border-b border-border/20 cursor-pointer transition ' + (excluded ? 'opacity-40' : 'hover:bg-teal/5')}>
                          <td className="py-0.5 px-1 w-6"><span className={'inline-block w-3 h-3 rounded border ' + (excluded ? 'border-dgray bg-transparent' : 'border-teal bg-teal')} style={{lineHeight:'12px',fontSize:'8px',color:'white'}}>{excluded ? '' : '✓'}</span></td>
                          <td className={'py-0.5 px-2 uppercase ' + (excluded ? 'text-dgray line-through' : 'text-white')}>{p.name}</td>
                          <td className="py-0.5 px-2 text-dgray uppercase">{p.location}</td>
                          <td className="py-0.5 px-2 text-dgray uppercase">{p.floor}</td>
                        </tr>
                      })}
                      </tbody></table>
                    </div>
                  )}
                </div>
              )}

              {/* IO List section */}
              {r.totalEquipment > 0 && (
                <div className="mb-4">
                  <div className="text-[10px] text-cyan font-bold uppercase mb-2">IO LIST</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">EQUIPMENT GROUPS</div><div className="text-xl font-extrabold text-cyan">{r.totalEquipment}</div></div>
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">IO POINTS</div><div className="text-xl font-extrabold text-cyan">{r.totalPoints}</div></div>
                  </div>
                </div>
              )}

              {/* Field devices section */}
              {(r.devices||[]).length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] text-cyan font-bold uppercase">FIELD DEVICES — CLICK TO INCLUDE/EXCLUDE</div>
                    <div className="flex gap-2">
                      <button onClick={function(){var ex={};r.devices.forEach(function(d){ex['device:'+d.id]=true});setImportExclusions(Object.assign({},importExclusions,ex))}} className="text-[9px] text-orange hover:text-white transition">DESELECT ALL</button>
                      <button onClick={function(){var ex=Object.assign({},importExclusions);r.devices.forEach(function(d){delete ex['device:'+d.id]});setImportExclusions(ex)}} className="text-[9px] text-teal hover:text-white transition">SELECT ALL</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">DEVICES</div><div className="text-xl font-extrabold text-cyan">{r.devices.filter(function(d){return !importExclusions['device:'+d.id]}).length}</div></div>
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">AREA GROUPS</div><div className="text-xl font-extrabold text-cyan">{(r.areas||[]).length}</div></div>
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">COMM DONE</div><div className="text-xl font-extrabold text-green">{r.devices.filter(function(d){return d.comm_cable && !importExclusions['device:'+d.id]}).length}</div></div>
                    <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">EXCLUDED</div><div className="text-xl font-extrabold text-orange">{r.devices.filter(function(d){return importExclusions['device:'+d.id]}).length}</div></div>
                  </div>
                  <div className="max-h-32 overflow-y-auto bg-navy rounded-lg p-2">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                    {r.devices.map(function(d){
                      var excluded = importExclusions['device:'+d.id]
                      return <button key={d.id} onClick={function(){toggleExclude('device:'+d.id)}} className={'text-left px-2 py-1 rounded text-[10px] transition ' + (excluded ? 'bg-red/10 text-dgray line-through opacity-50' : 'bg-teal/10 text-white')}>
                        {d.tag || d.id}
                      </button>
                    })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {r.skipped && r.skipped.length > 0 && (
            <div className="bg-orange/10 border border-orange/30 rounded-lg p-3 mb-4">
              <div className="text-[10px] text-orange font-bold uppercase mb-1">SKIPPED (ALREADY EXIST):</div>
              <div className="text-[10px] text-dgray uppercase">{r.skipped.join(', ')}</div>
            </div>
          )}
          {r.warnings && r.warnings.length > 0 && (
            <div className="bg-red/10 border border-red/30 rounded-lg p-3 mb-4">
              <div className="text-[10px] text-red font-bold uppercase mb-1">WARNINGS:</div>
              <div className="text-[10px] text-dgray uppercase">{r.warnings.join(', ')}</div>
            </div>
          )}

          <div className="flex gap-3 mt-4">
            {dt !== DOC_TYPES.UNKNOWN && (
              <button onClick={confirmImport} className="px-6 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 uppercase">
                {Object.keys(importExclusions).length > 0 ? 'CONFIRM IMPORT (' + Object.keys(importExclusions).length + ' EXCLUDED)' : 'CONFIRM IMPORT'}
              </button>
            )}
            <button onClick={cancelImport} className="px-6 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white uppercase">CANCEL</button>
          </div>
        </div>
      </div>
    )
  }

  // ─── Show Project Selector if no active project ────────────
  if (!activeProject) {
    if (projectLoading) {
      return (
        <div className="min-h-screen bg-navy flex items-center justify-center">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
            <div className="text-xs text-dgray uppercase">LOADING PROJECT...</div>
          </div>
        </div>
      )
    }
    return <ProjectSelector onSelectProject={handleSelectProject} />
  }

  // ─── Main App ──────────────────────────────────────────────
  var projectName = activeProject.name || 'MINIMATE'
  var projectSub = activeProject.client || ''

  return (
    <div className="min-h-screen bg-navy text-white">
      <Sidebar projectName={projectName} onGlobalImport={handleGlobalImport} onSwitchProject={handleSwitchProject} onExportProject={handleExportProject} onRestoreProject={handleRestoreProject} isDemo={isDemo} />
      {canUndo && (<button onClick={handleUndo} className="fixed top-14 md:top-3 right-4 z-40 bg-card2 border border-border text-dgray hover:text-white hover:border-teal w-8 h-8 rounded-lg text-sm flex items-center justify-center transition" title="UNDO (CTRL+Z)">↩</button>)}

      {/* Stale build: block-until-refresh banner */}
      {updateAvailable && (
        <div className="no-print fixed top-12 md:top-0 left-0 right-0 md:left-[220px] z-[95] bg-orange border-b border-orange px-4 py-2 flex items-center justify-between gap-3">
          <div className="text-[11px] text-navy font-bold uppercase">A NEW VERSION OF MINIMATE IS LIVE — REFRESH NOW. WORKING ON AN OLD VERSION CAN OVERWRITE YOUR TEAM'S DATA.</div>
          <button onClick={function() { window.location.reload() }} className="px-3 py-1 bg-navy text-orange text-[10px] font-bold rounded uppercase hover:bg-navy/80 transition shrink-0">REFRESH NOW</button>
        </div>
      )}

      {/* Multi-user save conflict banner */}
      {saveConflict && (
        <div className="fixed top-12 md:top-0 left-0 right-0 md:left-[220px] z-[90] bg-red/90 border-b border-red px-4 py-2 flex items-center justify-between gap-3">
          <div className="text-[11px] text-white font-bold uppercase">PROJECT WAS UPDATED BY ANOTHER USER — YOUR LAST CHANGE WAS NOT SAVED</div>
          <div className="flex gap-2 shrink-0">
            <button onClick={reloadFromServer} className="px-3 py-1 bg-white text-red text-[10px] font-bold rounded uppercase hover:bg-white/80 transition">RELOAD LATEST</button>
            <button onClick={function(){setSaveConflict(false)}} className="px-2 py-1 text-white/70 text-[10px] uppercase hover:text-white">DISMISS</button>
          </div>
        </div>
      )}

      {/* Save status indicator */}
      {!isDemo && saveStatus !== 'idle' && (
        <div className={'fixed top-14 md:top-3 z-40 text-[10px] uppercase tracking-wider transition-opacity ' + (canUndo ? 'right-14' : 'right-4') + (saveStatus === 'error' ? ' text-red' : saveStatus === 'saving' ? ' text-dgray' : ' text-green')}>
          {saveStatus === 'saving' ? 'SAVING...' : saveStatus === 'saved' ? 'SAVED ✓' : 'SAVE ERROR'}
        </div>
      )}

      {importLoading && (
        <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center">
          <div className="bg-card rounded-xl p-6 text-center">
            <div className="text-sm text-dgray uppercase mb-2">PARSING DOCUMENT...</div>
            <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin mx-auto"></div>
          </div>
        </div>
      )}
      {renderImportModal()}
      {renderDrawingModal()}
      {gImpFile && (
        <GlobalImport file={gImpFile} onRoute={routeImport} onClose={function() { setGImpFile(null) }} />
      )}

      {traceSession && (
        <TraceStudio file={traceSession.file} record={traceSession.record} onCancel={handleTraceCancel} onComplete={handleTraceComplete} />
      )}
      <div className="pt-14 md:pt-0 md:ml-[220px] p-4 md:p-6 print-reset">
        <Routes>
          <Route path="/" element={<Dashboard panels={panels} equipmentMap={equipmentMap} loops={loops} projectName={projectName} projectSub={projectSub} />} />
          <Route path="/panels" element={<PanelsList panels={panels} equipmentMap={equipmentMap} onDeletePanel={handleDeletePanel} />} />
          <Route path="/panels/:panelId" element={<PanelDetail panels={panels} equipmentMap={equipmentMap} terminationMap={terminationMap} onUpdatePoint={handleUpdatePoint} onUpdateTermination={handleUpdateTermination} onDeletePanel={handleDeletePanel} onUndo={handleUndo} canUndo={canUndo} />} />
          <Route path="/field-devices" element={<CommDevices loops={loops} areas={areaGroups} gateways={gateways} onUpdateLoops={handleUpdateLoops} onUpdateAreas={handleUpdateAreas} onUpdateGateways={setGateways} onUndo={handleUndo} canUndo={canUndo} />} />
          <Route path="/drawings" element={<DrawingsPage drawings={drawings} onOpen={handleOpenDrawing} onUpdateMeta={handleUpdateDrawingMeta} onDelete={handleDeleteDrawing} />} />
          <Route path="/documents" element={<DocumentsPage project={activeProject} projectName={projectName} panels={panels} equipmentMap={equipmentMap} onUpdatePoint={handleUpdatePoint} scope={estimateScope} onUpdateScope={setEstimateScope} incomingFile={incomingEst} onConsumedIncoming={function() { setIncomingEst(null) }} documents={documents} onUpdateDoc={updateDoc} onDeleteDoc={deleteDoc} drawingsElement={<DrawingsPage drawings={drawings} onOpen={handleOpenDrawing} onUpdateMeta={handleUpdateDrawingMeta} onDelete={handleDeleteDrawing} />} />} />
          <Route path="/tasks" element={<Placeholder title="Tasks" desc="Daily task management and team assignments" />} />
          <Route path="/blockers" element={<BlockersPage blockers={blockers} onUpdate={setBlockers} />} />
          <Route path="/reports" element={<ReportsPage projectId={activeProject.id} projectName={projectName} projectClient={activeProject.client || ''} loops={loops} areas={areaGroups} blockers={blockers} gateways={gateways} panels={panels} equipmentMap={equipmentMap} onUpdatePanels={setPanels} config={reportConfig} onConfig={setReportConfig} />} />
        </Routes>
      </div>
    </div>
  )
}
