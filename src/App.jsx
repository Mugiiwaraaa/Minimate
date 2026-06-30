import { useState, useCallback, useEffect, useRef } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import PanelsList from './pages/PanelsList'
import PanelDetail from './pages/PanelDetail'
import CommDevices from './pages/CommDevices'
import ProjectSelector from './pages/ProjectSelector'
import { isDemo } from './lib/supabase'
import { loadProject, saveProjectData, flushPendingSave } from './lib/supabaseDb'
import { smartParse, DOC_TYPES, DOC_LABELS } from './lib/smartParser'

function Placeholder(props) {
  return (
    <div className="text-center text-dgray mt-20">
      <h2 className="text-lg font-bold text-white mb-2">{props.title} - Coming in v0.2</h2>
      <p className="text-sm">{props.desc}</p>
    </div>
  )
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

  // Save indicator
  var saveState = useState('idle') // idle | saving | saved | error
  var saveStatus = saveState[0]
  var setSaveStatus = saveState[1]

  // Undo system
  var undoRef = useRef([])
  var skipUndoRef = useRef(false)
  var stateRef = useRef({loops:[], areas:[], eq:{}, panels:[], term:{}})
  stateRef.current = {loops: loops, areas: areaGroups, eq: equipmentMap, panels: panels, term: terminationMap}

  // ─── Auto-save to Supabase on state changes ────────────────
  var initialLoadDone = useRef(false)

  useEffect(function() {
    if (!activeProject || !activeProject.id || isDemo) return
    if (!initialLoadDone.current) return // don't save during initial load
    var data = {
      panels: panels,
      equipmentMap: equipmentMap,
      terminationMap: terminationMap,
      loops: loops,
      areaGroups: areaGroups
    }
    setSaveStatus('saving')
    saveProjectData(activeProject.id, data)
    // Show saved indicator after debounce delay
    var t = setTimeout(function() { setSaveStatus('saved') }, 2000)
    var t2 = setTimeout(function() { setSaveStatus('idle') }, 4000)
    return function() { clearTimeout(t); clearTimeout(t2) }
  }, [panels, equipmentMap, terminationMap, loops, areaGroups])

  // Flush save before page unload
  useEffect(function() {
    function onBeforeUnload() { flushPendingSave() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return function() { window.removeEventListener('beforeunload', onBeforeUnload) }
  }, [])

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
      setActiveProject(fullProject || project)
      // Allow auto-save after state is populated
      setTimeout(function() { initialLoadDone.current = true }, 500)
    })
  }

  function handleSwitchProject() {
    flushPendingSave()
    initialLoadDone.current = false
    setActiveProject(null)
    setPanels([])
    setEquipmentMap({})
    setTerminationMap({})
    setLoops([])
    setAreaGroups([])
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
      <Sidebar projectName={projectName} onImportFile={handleImportFile} onSwitchProject={handleSwitchProject} isDemo={isDemo} />
      {canUndo && (<button onClick={handleUndo} className="fixed top-14 md:top-3 right-4 z-40 bg-card2 border border-border text-dgray hover:text-white hover:border-teal w-8 h-8 rounded-lg text-sm flex items-center justify-center transition" title="UNDO (CTRL+Z)">↩</button>)}

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
      <div className="pt-14 md:pt-0 md:ml-[220px] p-4 md:p-6">
        <Routes>
          <Route path="/" element={<Dashboard panels={panels} equipmentMap={equipmentMap} loops={loops} projectName={projectName} projectSub={projectSub} />} />
          <Route path="/panels" element={<PanelsList panels={panels} equipmentMap={equipmentMap} onDeletePanel={handleDeletePanel} />} />
          <Route path="/panels/:panelId" element={<PanelDetail panels={panels} equipmentMap={equipmentMap} terminationMap={terminationMap} onUpdatePoint={handleUpdatePoint} onUpdateTermination={handleUpdateTermination} onDeletePanel={handleDeletePanel} onUndo={handleUndo} canUndo={canUndo} />} />
          <Route path="/field-devices" element={<CommDevices loops={loops} areas={areaGroups} onUpdateLoops={handleUpdateLoops} onUpdateAreas={handleUpdateAreas} onUndo={handleUndo} canUndo={canUndo} />} />
          <Route path="/tasks" element={<Placeholder title="Tasks" desc="Daily task management and team assignments" />} />
          <Route path="/blockers" element={<Placeholder title="Blockers Board" desc="Blocker tracking with escalation" />} />
          <Route path="/reports" element={<Placeholder title="Reports" desc="Auto-generated progress reports" />} />
        </Routes>
      </div>
    </div>
  )
}
