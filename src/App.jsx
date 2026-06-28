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
      setImportPreview(result)
    })
    e.target.value = ''
  }

  function confirmImport() {
    if (!importPreview) return
    pushUndo()

    var dt = importPreview.docType

    if (dt === DOC_TYPES.FCU_SCHEDULE || dt === DOC_TYPES.VAV_SCHEDULE) {
      var ul = loops.find(function(l) { return l.id === 'loop-unassigned' })
      var newLoops = loops.slice()
      if (!ul) {
        ul = {id:'loop-unassigned', name:'UNASSIGNED', protocol:'MODBUS RTU', gateway:'', ddc_ref:'', floor:'', zone:'', devices:[]}
        newLoops.push(ul)
      }
      newLoops = newLoops.map(function(l) {
        if (l.id !== 'loop-unassigned') return l
        return Object.assign({}, l, {devices: l.devices.concat(importPreview.devices)})
      })
      setLoops(newLoops)
      setAreaGroups(areaGroups.concat(importPreview.areas))
    }

    if (dt === DOC_TYPES.IO_LIST) {
      if (importPreview.panels && importPreview.panels.length > 0) {
        setPanels(panels.concat(importPreview.panels))
      }
      if (importPreview.equipMap) {
        var newEq = Object.assign({}, equipmentMap)
        Object.keys(importPreview.equipMap).forEach(function(pid) {
          newEq[pid] = importPreview.equipMap[pid]
        })
        setEquipmentMap(newEq)
      }
    }

    if (dt === DOC_TYPES.DDC_TERMINATION) {
      if (importPreview.newPanels && importPreview.newPanels.length > 0) {
        setPanels(panels.concat(importPreview.newPanels.map(function(p) {
          return {id: p.id, name: p.name, location: p.location, floor: p.floor}
        })))
      }
      if (importPreview.panelUpdates && importPreview.panelUpdates.length > 0) {
        setPanels(function(prev) {
          return prev.map(function(p) {
            var upd = importPreview.panelUpdates.find(function(u) { return u.panelId === p.id })
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
      if (importPreview.terminationData) {
        setTerminationMap(function(prev) {
          var next = Object.assign({}, prev)
          Object.keys(importPreview.terminationData).forEach(function(pid) {
            next[pid] = importPreview.terminationData[pid]
          })
          return next
        })
      }
    }

    setImportPreview(null)
  }

  function cancelImport() {
    setImportPreview(null)
  }

  // ─── Import Preview Modal Renderer ──────────────────────
  function renderImportModal() {
    if (!importPreview) return null
    var r = importPreview
    var dt = r.docType

    return (
      <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-6" onClick={cancelImport}>
        <div className="bg-card rounded-2xl border-2 border-orange p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={function(e){e.stopPropagation()}}>
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
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TOTAL DEVICES</div><div className="text-2xl font-extrabold text-cyan">{r.devices.length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">AREA GROUPS</div><div className="text-2xl font-extrabold text-cyan">{r.areas.length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">COMM CABLE DONE</div><div className="text-2xl font-extrabold text-green">{r.devices.filter(function(d){return d.comm_cable}).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TERMINATION DONE</div><div className="text-2xl font-extrabold text-green">{r.devices.filter(function(d){return d.termination}).length}</div></div>
              </div>
              <div className="max-h-40 overflow-y-auto mb-4 bg-navy rounded-lg p-3">
                <table className="w-full text-[10px]"><thead><tr className="border-b border-border/50 text-dgray"><th className="text-left py-1 px-2">AREA</th><th className="text-center py-1 px-2">DEVICES</th></tr></thead><tbody>
                {r.areas.map(function(a){return <tr key={a.id} className="border-b border-border/20"><td className="py-1 px-2 text-white uppercase">{a.name}</td><td className="text-center py-1 px-2 text-cyan">{a.device_ids.length}</td></tr>})}
                </tbody></table>
              </div>
            </div>
          )}

          {dt === DOC_TYPES.IO_LIST && (
            <div>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">{r.updated.length > 0 ? 'NEW PANELS' : 'PANELS'}</div><div className="text-2xl font-extrabold text-cyan">{r.panels.length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">EQUIPMENT GROUPS</div><div className="text-2xl font-extrabold text-cyan">{r.totalEquipment}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TOTAL IO POINTS</div><div className="text-2xl font-extrabold text-cyan">{r.totalPoints}</div></div>
              </div>
              {r.updated.length > 0 && (
                <div className="bg-orange/10 border border-orange/30 rounded-lg p-3 mb-4">
                  <div className="text-[10px] text-orange font-bold uppercase mb-1">UPDATING EXISTING PANELS:</div>
                  <div className="text-[10px] text-dgray uppercase">{r.updated.join(', ')}</div>
                </div>
              )}
              <div className="max-h-40 overflow-y-auto mb-4 bg-navy rounded-lg p-3">
                <table className="w-full text-[10px]"><thead><tr className="border-b border-border/50 text-dgray"><th className="text-left py-1 px-2">PANEL</th><th className="text-center py-1 px-2">EQUIPMENT</th><th className="text-center py-1 px-2">POINTS</th></tr></thead><tbody>
                {Object.keys(r.equipMap).map(function(pid){
                  var eqs = r.equipMap[pid]
                  var pName = ''
                  r.panels.forEach(function(p){if(p.id===pid)pName=p.name})
                  if(!pName) panels.forEach(function(p){if(p.id===pid)pName=p.name})
                  var ptCount = 0; eqs.forEach(function(eq){eq.points.forEach(function(pt){ptCount+=pt.qty})})
                  return <tr key={pid} className="border-b border-border/20"><td className="py-1 px-2 text-white uppercase">{pName||pid}</td><td className="text-center py-1 px-2 text-cyan">{eqs.length}</td><td className="text-center py-1 px-2 text-cyan">{ptCount}</td></tr>
                })}
                </tbody></table>
              </div>
            </div>
          )}

          {dt === DOC_TYPES.DDC_TERMINATION && (
            <div>
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">PANELS UPDATED</div><div className="text-2xl font-extrabold text-green">{(r.panelUpdates||[]).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">NEW PANELS</div><div className="text-2xl font-extrabold text-cyan">{(r.newPanels||[]).length}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TERMINATION SHEETS</div><div className="text-2xl font-extrabold text-teal">{r.termPanelCount || 0}</div></div>
                <div className="bg-card2 rounded-lg p-3"><div className="text-[10px] text-dgray uppercase">TOTAL PINS</div><div className="text-2xl font-extrabold text-dgray">{r.terminationData ? Object.values(r.terminationData).reduce(function(s,t){return s + (t.pins||[]).length}, 0) : 0}</div></div>
              </div>
              {(r.panelUpdates||[]).length > 0 && (
                <div className="max-h-40 overflow-y-auto mb-4 bg-navy rounded-lg p-3">
                  <table className="w-full text-[10px]"><thead><tr className="border-b border-border/50 text-dgray"><th className="text-left py-1 px-2">PANEL</th><th className="text-center py-1 px-2">ENCL</th><th className="text-center py-1 px-2">ASSEMBLED</th><th className="text-center py-1 px-2">DDC</th><th className="text-center py-1 px-2">CABLE</th><th className="text-center py-1 px-2">TERM</th><th className="text-center py-1 px-2">INSP</th></tr></thead><tbody>
                  {r.panelUpdates.map(function(u){return <tr key={u.panelId} className="border-b border-border/20">
                    <td className="py-1 px-2 text-white uppercase">{u.panelName}</td>
                    <td className="text-center py-1 px-2">{u.progress.enclosure?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                    <td className="text-center py-1 px-2">{u.progress.assembled?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                    <td className="text-center py-1 px-2">{u.progress.ddcInstall?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                    <td className="text-center py-1 px-2">{u.progress.cablePull?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                    <td className="text-center py-1 px-2">{u.progress.termination?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                    <td className="text-center py-1 px-2">{u.progress.inspection?<span className="text-green">✓</span>:<span className="text-dgray">-</span>}</td>
                  </tr>})}
                  </tbody></table>
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
              <button onClick={confirmImport} className="px-6 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 uppercase">CONFIRM IMPORT</button>
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
      {canUndo && (<button onClick={handleUndo} className="fixed top-3 right-4 z-50 bg-card2 border border-border text-dgray hover:text-white hover:border-teal w-8 h-8 rounded-lg text-sm flex items-center justify-center transition" title="UNDO (CTRL+Z)">↩</button>)}

      {/* Save status indicator */}
      {!isDemo && saveStatus !== 'idle' && (
        <div className={'fixed top-3 z-50 text-[10px] uppercase tracking-wider transition-opacity ' + (canUndo ? 'right-14' : 'right-4') + (saveStatus === 'error' ? ' text-red' : saveStatus === 'saving' ? ' text-dgray' : ' text-green')}>
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
      <div className="ml-[220px] p-6">
        <Routes>
          <Route path="/" element={<Dashboard panels={panels} equipmentMap={equipmentMap} loops={loops} projectName={projectName} projectSub={projectSub} />} />
          <Route path="/panels" element={<PanelsList panels={panels} equipmentMap={equipmentMap} />} />
          <Route path="/panels/:panelId" element={<PanelDetail panels={panels} equipmentMap={equipmentMap} terminationMap={terminationMap} onUpdatePoint={handleUpdatePoint} onUpdateTermination={handleUpdateTermination} onUndo={handleUndo} canUndo={canUndo} />} />
          <Route path="/field-devices" element={<CommDevices loops={loops} areas={areaGroups} onUpdateLoops={handleUpdateLoops} onUpdateAreas={handleUpdateAreas} onUndo={handleUndo} canUndo={canUndo} />} />
          <Route path="/tasks" element={<Placeholder title="Tasks" desc="Daily task management and team assignments" />} />
          <Route path="/blockers" element={<Placeholder title="Blockers Board" desc="Blocker tracking with escalation" />} />
          <Route path="/reports" element={<Placeholder title="Reports" desc="Auto-generated progress reports" />} />
        </Routes>
      </div>
    </div>
  )
}
