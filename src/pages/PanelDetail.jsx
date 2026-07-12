import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { CONTROLLERS, MODULES, generatePinLayout } from '../lib/controllerModules'
import IoSheetGrid from '../components/IoSheetGrid'

var stages = ['cable_pulled','cable_continuity','term_ddc_side','term_field_side','functional_test']
var stageLabels = {
  cable_pulled: 'CABLE PULLED',
  cable_continuity: 'CONTINUITY',
  term_ddc_side: 'TERM DDC',
  term_field_side: 'TERM FIELD',
  functional_test: 'FUNC TEST',
}

function autoGrow(e){e.target.style.whiteSpace='normal';e.target.style.height='auto';e.target.style.height=e.target.scrollHeight+'px'}
function autoShrink(e){e.target.style.height='';e.target.style.whiteSpace='nowrap'}
function up(v){return (v||'').toUpperCase().trim()}

export default function PanelDetail(props) {
  var panels = props.panels
  var equipmentMap = props.equipmentMap
  var terminationMap = props.terminationMap || {}
  var onUpdatePoint = props.onUpdatePoint
  var onUpdateEquipment = props.onUpdateEquipment
  var onUpdateTermination = props.onUpdateTermination
  var onDeletePanel = props.onDeletePanel
  var navigate = useNavigate()
  var params = useParams()
  var panelId = params.panelId
  var panel = panels.find(function(p) { return p.id === panelId })
  var equipment = equipmentMap[panelId] || []
  var termData = terminationMap[panelId] || null

  var viewState = useState('io')
  var view = viewState[0]
  var setView = viewState[1]
  var updateLogState = useState([])
  var updateLog = updateLogState[0]
  var setUpdateLog = updateLogState[1]
  var editState = useState(null)
  var editing = editState[0]
  var setEditing = editState[1]
  var editValState = useState('')
  var editVal = editValState[0]
  var setEditVal = editValState[1]

  // Termination setup state
  var setupState = useState(false)
  var showSetup = setupState[0]
  var setShowSetup = setupState[1]
  var setupCtrl = useState('ME521')
  var selectedCtrl = setupCtrl[0]
  var setSelectedCtrl = setupCtrl[1]
  var setupMods = useState([])
  var selectedMods = setupMods[0]
  var setSelectedMods = setupMods[1]

  if (!panel) return <div className="text-center text-dgray mt-20 uppercase">PANEL NOT FOUND</div>

  var activePoints = equipment.flatMap(function(e) {
    return (e.points || []).filter(function(p) { return !p.excluded })
  })
  var allPoints = equipment.flatMap(function(e) { return e.points || [] })

  // ─── IO List Handlers ─────────────────────────────────────
  function handleToggle(eqId, pointId, stage) {
    var eq = equipment.find(function(e) { return e.id === eqId })
    if (!eq) return
    var pt = eq.points.find(function(p) { return p.id === pointId })
    if (!pt || pt.excluded) return
    var newVal = !pt[stage]
    var idx = stages.indexOf(stage)
    if (newVal && idx > 0 && !pt[stages[idx - 1]]) return
    var updates = {}
    updates[stage] = newVal
    if (!newVal) {
      for (var i = idx + 1; i < stages.length; i++) {
        updates[stages[i]] = false
      }
    }
    onUpdatePoint(panelId, eqId, pointId, updates)
    var now = new Date()
    var timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    setUpdateLog(function(prev) {
      return [{ time: timeStr, msg: pt.description + ' -- ' + stageLabels[stage] + ': ' + (newVal ? 'DONE' : 'UNDONE') }].concat(prev).slice(0, 50)
    })
  }

  function handleToggleExclude(eqId, pointId) {
    var eq = equipment.find(function(e) { return e.id === eqId })
    if (!eq) return
    var pt = eq.points.find(function(p) { return p.id === pointId })
    if (!pt) return
    if (pt.excluded) {
      onUpdatePoint(panelId, eqId, pointId, { excluded: false, exclude_remark: '' })
    } else {
      onUpdatePoint(panelId, eqId, pointId, {
        excluded: true,
        cable_pulled: false, cable_continuity: false,
        term_ddc_side: false, term_field_side: false, functional_test: false,
      })
    }
  }

  function handleRemarkChange(eqId, pointId, value) {
    onUpdatePoint(panelId, eqId, pointId, { exclude_remark: value })
  }

  function startEdit(type, id, currentValue) {
    setEditing(type + ':' + id)
    setEditVal(currentValue || '')
  }

  function saveEdit(eqId, pointId) {
    if (!editing) return
    var parts = editing.split(':')
    var editType = parts[0]
    if (editType === 'eq-name') {
      onUpdatePoint(panelId, eqId, null, { _updateEquipment: true, name: editVal.toUpperCase() })
    } else if (editType === 'eq-ids') {
      onUpdatePoint(panelId, eqId, null, { _updateEquipment: true, equipment_ids: editVal.toUpperCase() })
    } else if (editType === 'pt-desc') {
      onUpdatePoint(panelId, eqId, pointId, { description: editVal.toUpperCase() })
    }
    setEditing(null)
  }

  function handleEditKeyDown(e, eqId, pointId) {
    if (e.key === 'Enter') saveEdit(eqId, pointId)
    else if (e.key === 'Escape') setEditing(null)
  }

  // ─── Termination Handlers ─────────────────────────────────
  function initTermination() {
    var pins = generatePinLayout(selectedCtrl, selectedMods)
    if (!pins) return
    onUpdateTermination(panelId, {
      controller: selectedCtrl,
      modules: selectedMods.slice(),
      pins: pins,
      sheetName: null
    })
    setShowSetup(false)
  }

  function addModule() {
    if (selectedMods.length >= 4) return
    setSelectedMods(selectedMods.concat([{ type: 'FB8I8O' }]))
  }

  function removeModule(idx) {
    setSelectedMods(selectedMods.filter(function(m, i) { return i !== idx }))
  }

  function setModuleType(idx, type) {
    setSelectedMods(selectedMods.map(function(m, i) {
      if (i !== idx) return m
      return { type: type }
    }))
  }

  function updatePin(pinIdx, field, value) {
    if (!termData) return
    var newPins = termData.pins.map(function(p, i) {
      if (i !== pinIdx) return p
      var updated = Object.assign({}, p)
      updated[field] = up(value)
      return updated
    })
    onUpdateTermination(panelId, Object.assign({}, termData, { pins: newPins }))
  }

  function clearPin(pinIdx) {
    if (!termData) return
    var newPins = termData.pins.map(function(p, i) {
      if (i !== pinIdx) return p
      return Object.assign({}, p, {
        com: '', system: '', pointDescription: 'SPARE',
        objectInstance: '', cableNumber: '', cableDescription: '',
        sensorMCC: '', linkedPointId: null
      })
    })
    onUpdateTermination(panelId, Object.assign({}, termData, { pins: newPins }))
  }

  function renameSection(oldLabel, newLabel) {
    if (!termData || !newLabel.trim()) return
    var formatted = up(newLabel)
    if (formatted === oldLabel) return
    var newPins = termData.pins.map(function(p) {
      if (p.sectionLabel !== oldLabel) return p
      return Object.assign({}, p, { sectionLabel: formatted })
    })
    onUpdateTermination(panelId, Object.assign({}, termData, { pins: newPins }))
  }

  // ─── IO List View ─────────────────────────────────────────
  function renderIOView() {
    // IoSheetGrid handles an empty eqs array fine — its own + ADD EQUIPMENT
    // button isn't conditional on having rows already, so a brand-new panel
    // (Design Engine's manual-authoring path) can add its first equipment
    // right here instead of being told to import a file it doesn't have.
    return (
      <IoSheetGrid
        eqs={equipment}
        panelId={panelId}
        onUpdateEquipment={onUpdateEquipment}
        onUndo={props.onUndo}
        height={440}
        compact
      />
    )
  }

  // ─── Termination Sheet View ───────────────────────────────
  function renderTerminationView() {
    // No termination data - show setup or placeholder
    if (!termData) {
      return (
        <div>
          {!showSetup ? (
            <div className="bg-card rounded-xl border border-border p-8 text-center">
              <div className="text-dgray text-sm mb-3">NO TERMINATION SHEET CONFIGURED FOR THIS PANEL.</div>
              <div className="text-[11px] text-dgray mb-4">IMPORT A DDC TERMINATION SHEET VIA SIDEBAR, OR SET UP MANUALLY.</div>
              <button onClick={function(){setShowSetup(true)}}
                className="px-5 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 uppercase">
                SETUP CONTROLLER
              </button>
            </div>
          ) : (
            <div className="bg-card rounded-xl border-2 border-teal p-6">
              <h3 className="text-sm font-bold mb-4 uppercase">CONTROLLER SETUP - {panel.name}</h3>

              <div className="mb-4">
                <div className="text-[10px] text-dgray mb-1 uppercase">CONTROLLER MODEL</div>
                <select value={selectedCtrl} onChange={function(e){setSelectedCtrl(e.target.value)}}
                  className="bg-navy border border-border rounded px-3 py-1.5 text-xs text-white outline-none uppercase">
                  {Object.keys(CONTROLLERS).map(function(k){
                    return <option key={k} value={k}>{CONTROLLERS[k].name} - {CONTROLLERS[k].description}</option>
                  })}
                </select>
              </div>

              <div className="mb-4">
                <div className="text-[10px] text-dgray mb-2 uppercase">EXPANSION MODULES ({selectedMods.length}/4)</div>
                {selectedMods.map(function(mod, idx){
                  return (
                    <div key={idx} className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] text-dgray w-16">SLOT {idx+1}:</span>
                      <select value={mod.type} onChange={function(e){setModuleType(idx,e.target.value)}}
                        className="bg-navy border border-border rounded px-3 py-1 text-xs text-white outline-none uppercase flex-1">
                        {Object.keys(MODULES).map(function(k){
                          return <option key={k} value={k}>{MODULES[k].name} - {MODULES[k].description}</option>
                        })}
                      </select>
                      <button onClick={function(){removeModule(idx)}} className="text-red text-xs hover:text-white">REMOVE</button>
                    </div>
                  )
                })}
                {selectedMods.length < 4 && (
                  <button onClick={addModule} className="text-[10px] text-teal hover:text-cyan uppercase">+ ADD MODULE</button>
                )}
              </div>

              <div className="flex gap-3">
                <button onClick={initTermination} className="px-5 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 uppercase">CREATE TERMINATION SHEET</button>
                <button onClick={function(){setShowSetup(false)}} className="px-5 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white uppercase">CANCEL</button>
              </div>
            </div>
          )}
        </div>
      )
    }

    // ─── Render termination pin table ───────────────────────
    var pins = termData.pins || []
    var usedPins = pins.filter(function(p){return p.pointDescription !== 'SPARE'}).length
    var totalPins = pins.length

    // Group pins by sectionLabel for section headers
    var sections = []
    var currentSectionLabel = ''
    pins.forEach(function(pin, idx) {
      if (pin.sectionLabel !== currentSectionLabel) {
        currentSectionLabel = pin.sectionLabel
        sections.push({ label: currentSectionLabel, startIdx: idx })
      }
    })

    return (
      <div>
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="bg-card rounded-lg p-3 border border-border text-center">
            <div className="text-[10px] text-dgray">CONTROLLER</div>
            <div className="text-sm font-bold text-cyan">{termData.controller}</div>
          </div>
          <div className="bg-card rounded-lg p-3 border border-border text-center">
            <div className="text-[10px] text-dgray">MODULES</div>
            <div className="text-sm font-bold text-cyan">{(termData.modules||[]).length}</div>
          </div>
          <div className="bg-card rounded-lg p-3 border border-border text-center">
            <div className="text-[10px] text-dgray">PINS USED</div>
            <div className="text-sm font-bold text-cyan">{usedPins}/{totalPins}</div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" style={{borderCollapse:'collapse'}}>
              <thead>
                <tr style={{borderBottom:'1px solid rgba(148,163,184,0.25)',background:'rgba(30,41,59,0.7)'}}>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-center px-2 py-2.5 w-16">PIN</th>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-center px-2 py-2.5 w-16">COM</th>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-left px-2 py-2.5 w-24">SYSTEM</th>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-left px-2 py-2.5">POINT DESCRIPTION</th>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-center px-2 py-2.5 w-24">OBJ INSTANCE</th>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-center px-2 py-2.5 w-24">CABLE NO</th>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-left px-2 py-2.5 w-36">CABLE DESC</th>
                  <th style={{borderRight:'1px solid rgba(148,163,184,0.15)'}} className="text-[10px] font-semibold text-dgray text-left px-2 py-2.5 w-28">SENSOR/MCC</th>
                  <th className="text-[10px] font-semibold text-dgray text-center px-1 py-2.5 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {pins.map(function(pin, idx) {
                  var isSpare = pin.pointDescription === 'SPARE'
                  var isFirst = sections.some(function(s){return s.startIdx === idx})
                  var sectionHeader = null
                  if (isFirst) {
                    var secLabel = pin.sectionLabel
                    sectionHeader = (
                      <tr key={'sec-'+idx} style={{borderBottom:'1px solid rgba(148,163,184,0.2)',background:'rgba(15,23,42,0.6)'}}>
                        <td colSpan="9" className="px-3 py-1.5">
                          {editing === 'sec:' + idx ? (
                            <input autoFocus value={editVal}
                              onChange={function(e) { setEditVal(e.target.value) }}
                              onBlur={function() { renameSection(secLabel, editVal); setEditing(null) }}
                              onKeyDown={function(e) {
                                if (e.key === 'Enter') { renameSection(secLabel, editVal); setEditing(null) }
                                else if (e.key === 'Escape') { setEditing(null) }
                              }}
                              style={{textTransform:'uppercase'}}
                              className="bg-navy border border-teal rounded px-2 py-0.5 text-[10px] font-bold text-teal outline-none w-80 tracking-wider" />
                          ) : (
                            <span className="text-[10px] font-bold text-teal uppercase tracking-wider cursor-pointer hover:text-cyan transition"
                              onClick={function() { setEditing('sec:' + idx); setEditVal(secLabel) }}
                              title="CLICK TO RENAME SECTION">
                              {secLabel}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  }

                  // Check if this pin shares GND with neighbors (GND rows get a subtle grouped look)
                  var isGnd = (pin.pointDescription||'').toUpperCase().indexOf('GND') !== -1 || (pin.pointDescription||'').toUpperCase().indexOf('COMMON') !== -1
                  var rowBg = isGnd ? 'rgba(100,116,139,0.08)' : 'transparent'

                  var pinRow = (
                    <tr key={idx} style={{borderBottom:'1px solid rgba(148,163,184,0.12)',background:rowBg}} className={isSpare ? 'opacity-40' : 'hover:bg-teal/4'}>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="text-[10px] text-center px-2 py-1.5 font-bold text-cyan">{pin.pin}</td>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="px-2 py-1">
                        <input value={pin.com} onChange={function(e){updatePin(idx,'com',e.target.value)}}
                          style={{textTransform:'uppercase'}}
                          className="bg-transparent border border-transparent focus:border-teal text-[10px] text-white outline-none w-full rounded px-1 py-0.5" />
                      </td>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="px-2 py-1">
                        <input value={pin.system} onChange={function(e){updatePin(idx,'system',e.target.value)}}
                          style={{textTransform:'uppercase'}}
                          className="bg-transparent border border-transparent focus:border-teal text-[10px] text-white outline-none w-full rounded px-1 py-0.5" />
                      </td>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="px-2 py-1">
                        <input value={pin.pointDescription} onChange={function(e){updatePin(idx,'pointDescription',e.target.value)}}
                          style={{textTransform:'uppercase'}}
                          className={'bg-transparent border border-transparent focus:border-teal text-[10px] outline-none w-full rounded px-1 py-0.5 ' + (isSpare ? 'text-dgray italic' : 'text-white font-medium')} />
                      </td>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="px-2 py-1">
                        <input value={pin.objectInstance} onChange={function(e){updatePin(idx,'objectInstance',e.target.value)}}
                          style={{textTransform:'uppercase'}}
                          className="bg-transparent border border-transparent focus:border-teal text-[10px] text-dgray outline-none w-full rounded px-1 py-0.5 text-center" />
                      </td>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="px-2 py-1">
                        <input value={pin.cableNumber} onChange={function(e){updatePin(idx,'cableNumber',e.target.value)}}
                          style={{textTransform:'uppercase'}}
                          className="bg-transparent border border-transparent focus:border-teal text-[10px] text-cyan outline-none w-full rounded px-1 py-0.5 text-center" />
                      </td>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="px-2 py-1">
                        <input value={pin.cableDescription} onChange={function(e){updatePin(idx,'cableDescription',e.target.value)}}
                          style={{textTransform:'uppercase'}}
                          className="bg-transparent border border-transparent focus:border-teal text-[10px] text-white outline-none w-full rounded px-1 py-0.5" />
                      </td>
                      <td style={{borderRight:'1px solid rgba(148,163,184,0.1)'}} className="px-2 py-1">
                        <input value={pin.sensorMCC} onChange={function(e){updatePin(idx,'sensorMCC',e.target.value)}}
                          style={{textTransform:'uppercase'}}
                          className="bg-transparent border border-transparent focus:border-teal text-[10px] text-white outline-none w-full rounded px-1 py-0.5" />
                      </td>
                      <td className="text-center px-1 py-1">
                        {!isSpare && (
                          <button onClick={function(){clearPin(idx)}} className="text-red/50 hover:text-red text-[10px]" title="CLEAR PIN">x</button>
                        )}
                      </td>
                    </tr>
                  )

                  if (sectionHeader) return [sectionHeader, pinRow]
                  return pinRow
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  // ─── Main Render ──────────────────────────────────────────
  return (
    <div style={{textTransform:'uppercase'}}>
      <div className="flex items-center gap-3 mb-5">
        <Link to="/panels" className="text-dgray hover:text-white text-sm">BACK</Link>
        <span className="text-dgray">/</span>
        <h1 className="text-lg md:text-xl font-bold">{panel.name}</h1>
        {onDeletePanel && <button onClick={function(){if(confirm('DELETE PANEL '+panel.name+'? THIS WILL REMOVE ALL IO DATA AND TERMINATION DATA.')){onDeletePanel(panelId);navigate('/panels')}}} className="ml-auto text-[10px] text-red/50 hover:text-red border border-red/20 hover:border-red/50 px-2 py-1 rounded transition">DELETE PANEL</button>}
      </div>
      <div className="text-xs text-dgray mb-4 flex flex-wrap gap-x-3 gap-y-1">
        <span>{panel.location}</span>
        <span>ACTIVE IO: <strong className="text-cyan">{activePoints.length}</strong> POINTS / {equipment.length} GROUPS</span>
        {allPoints.length !== activePoints.length && (
          <span className="ml-2 text-orange">({allPoints.length - activePoints.length} EXCLUDED)</span>
        )}
      </div>

      <div className="flex gap-2 mb-5">
        <button onClick={function(){setView('io')}} className={'px-4 py-1.5 text-xs font-semibold rounded-md transition uppercase '+(view==='io'?'bg-teal text-white':'bg-card2 text-dgray hover:text-white')}>IO LIST</button>
        <button onClick={function(){setView('term')}} className={'px-4 py-1.5 text-xs font-semibold rounded-md transition uppercase '+(view==='term'?'bg-teal text-white':'bg-card2 text-dgray hover:text-white')}>
          TERMINATION SHEET
          {termData && <span className="ml-1 text-[9px] opacity-60">({(termData.pins||[]).filter(function(p){return p.pointDescription!=='SPARE'}).length} PINS)</span>}
        </button>
      </div>

      {view === 'io' ? renderIOView() : renderTerminationView()}

      {updateLog.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4 mt-4">
          <h3 className="text-sm font-semibold mb-3">UPDATE LOG</h3>
          {updateLog.map(function(log, i) {
            return (
              <div key={i} className="flex gap-3 py-1.5 border-b border-border/30 last:border-0 text-[11px]">
                <span className="text-dgray w-12">{log.time}</span>
                <span className="text-cyan font-semibold w-16">YOU</span>
                <span className="text-lgray">{log.msg}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
