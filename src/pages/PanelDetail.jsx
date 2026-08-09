import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'
import { CONTROLLERS, MODULES, generatePinLayout } from '../lib/controllerModules'
import IoSheetGrid from '../components/IoSheetGrid'
import { estimateEquipmentToPanelEquipment } from '../lib/estimateDiff'
import * as ca from '../lib/commissioningAgent'

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

  // Design Engine: equipment types from the saved design estimate (I-O Summary
  // sheet), offered as a picker so the engineer can pick a known type instead
  // of typing "NEW EQUIPMENT" from scratch every time.
  var estimateScope = props.estimateScope || {}
  var ioSummarySheet = (estimateScope.sheets || []).filter(function(s) { return s.kind === 'io_summary' })[0]
  var estimateEquipment = (ioSummarySheet && ioSummarySheet.data && ioSummarySheet.data.equipment) || []
  var showPickerState = useState(false)
  var showPicker = showPickerState[0]
  var setShowPicker = showPickerState[1]
  var pickerSearchState = useState('')
  var pickerSearch = pickerSearchState[0]
  var setPickerSearch = pickerSearchState[1]
  var qtyOverridesState = useState({}) // { estimateType: current input value } — lets partial qty (e.g. 2 of 6) be added
  var qtyOverrides = qtyOverridesState[0]
  var setQtyOverrides = qtyOverridesState[1]

  // Count of INSTANCES already added for each estimate type, across ALL
  // panels (not a qty sum — each physical unit is its own row now, keyed by
  // estimateType so units like "HRAHU-1"/"HRAHU-2" both count toward "HRAHU").
  // Used both to default the picker's qty input to what's left to allocate,
  // and to number newly-added units so they don't collide with existing ones.
  var allocatedByType = {}
  Object.keys(equipmentMap).forEach(function(pid) {
    ;(equipmentMap[pid] || []).forEach(function(eq) {
      var k = up(eq.estimateType || eq.name)
      allocatedByType[k] = (allocatedByType[k] || 0) + 1
    })
  })

  function addFromEstimate(estEq, qty) {
    var startIndex = (allocatedByType[up(estEq.type)] || 0) + 1
    onUpdateEquipment(panelId, equipment.concat(estimateEquipmentToPanelEquipment(estEq, qty, startIndex)))
    // Picker stays open — adding several equipment types in one sitting is the common case.
  }

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

  // Commissioning (BACnet, via local commissioning_agent) — one compact state slot per
  // controller index. Kept deliberately terse: a status line + optional details toggle,
  // not a raw dump — this sits next to the pin table, it shouldn't compete with it.
  var projectId = props.projectId
  var ifaceState = useState(ca.getLocalAddress())
  var iface = ifaceState[0]
  var setIface = ifaceState[1]
  var commState = useState({})
  var comm = commState[0]
  var setComm = commState[1]
  // Verify depth. Off by default: each extra property is another BACnet read per point, so a
  // 72-point panel goes from 144 reads to ~500 — worth it deliberately, not on every glance.
  var depthState = useState({ io: false, health: false })
  var depth = depthState[0]
  var setDepth = depthState[1]
  // The IFACE must be an address that exists on THIS laptop — a wrong one used to hang the read
  // forever (bacpypes3 retries a failed bind indefinitely). Offer the real ones instead of asking
  // the tech to hand-type a "/24:47809" string correctly on a machine they may have just picked up.
  var ifListState = useState([])
  var ifList = ifListState[0]
  var setIfList = ifListState[1]
  useEffect(function() {
    if (!props.projectId) return
    ca.interfaces()
      .then(function(res) {
        var list = res.interfaces || []
        setIfList(list)
        // Preselect the first usable one only if nothing is saved yet — never override a choice.
        if (!ca.getLocalAddress() && list.length) {
          var best = list.filter(function(i) { return i.usable })[0] || list[0]
          setIface(best.suggested); ca.setLocalAddress(best.suggested)
        }
      })
      .catch(function() { /* agent down — the buttons already surface that */ })
  }, [props.projectId])

  function setCommFor(idx, patch) {
    setComm(function(prev) {
      var next = Object.assign({}, prev)
      next[idx] = Object.assign({}, next[idx], patch)
      return next
    })
  }

  function summarize(checks) {
    var s = { checked: checks.length, ok: 0, mismatch: 0, missing: 0, error: 0 }
    checks.forEach(function(c) {
      if (c.status === 'ok') s.ok++
      else if (c.status === 'mismatch') s.mismatch++
      else if (c.status === 'missing') s.missing++
      else s.error++
    })
    return s
  }

  // A sensor reporting open-loop/shorted-loop/no-sensor is a field fault, not a config mismatch —
  // it's the one result worth acting on immediately, so it's pulled out of the details list.
  function faultsIn(checks) {
    return checks.filter(function(c) {
      if ((c.property_name || '').indexOf('reliability') < 0) return false
      var a = String(c.actual == null ? '' : c.actual)
      return a.indexOf('no-fault-detected') < 0 && a !== '' && a !== '0'
    })
  }

  function runVerify(ctrl) {
    if (!projectId || !ctrl.ip) return
    setCommFor(ctrl.index, { busy: 'verify', err: '', regenNotice: '' })
    ca.bacnetVerify({
      project_id: projectId, panel_id: panelId, target: ctrl.ip,
      local_address: iface || undefined,
      include_io_config: depth.io, check_health: depth.health,
    })
      .then(function(res) {
        var checks = (res.report && res.report.checks) || []
        setCommFor(ctrl.index, {
          busy: null, summary: summarize(checks),
          faults: faultsIn(checks),
          details: checks.filter(function(c) { return c.status !== 'ok' }),
          showDetails: false,
        })
      })
      .catch(function(e) { setCommFor(ctrl.index, { busy: null, err: e.message, summary: null }) })
  }

  function runWrite(ctrl) {
    if (!projectId || !ctrl.ip) return
    if (!confirm('WRITE THE TERMINATION SHEET TO ' + ctrl.ip + '? THIS CHANGES REAL CONTROLLER OBJECTS.')) return
    setCommFor(ctrl.index, { busy: 'write', err: '', regenNotice: '' })
    ca.bacnetWrite({ project_id: projectId, panel_id: panelId, target: ctrl.ip, local_address: iface || undefined, commit: true })
      .then(function(res) {
        var results = res.results || []
        var committed = results.filter(function(r) { return r.status === 'committed' }).length
        var errors = results.filter(function(r) { return r.status === 'error' }).length
        setCommFor(ctrl.index, {
          busy: null,
          summary: { checked: results.length, ok: committed, mismatch: 0, missing: 0, error: errors },
          details: results.filter(function(r) { return r.status === 'error' }),
          showDetails: false,
          regenNotice: res.regen_notice || '',
        })
      })
      .catch(function(e) { setCommFor(ctrl.index, { busy: null, err: e.message, summary: null } ) })
  }

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

  // Digital field-entry for what used to only come from the Excel termination sheet: the BACnet
  // device instance and static IP are decided on-site when the engineer connects to the
  // controller, not known ahead of time — so they need somewhere to type it in directly, per
  // controller (a panel can have more than one physical controller, e.g. DDC-RF-01: each has its
  // own IP and BACnet ID; module numbering 1-4 restarts independently per controller too).
  function updateControllerField(ctrlIndex, field, value) {
    if (!termData) return
    var controllers = termData.controllers || [{ index: 1, model: termData.controller || '', bacnetId: '', ip: '' }]
    var newControllers = controllers.map(function(c) {
      if (c.index !== ctrlIndex) return c
      var updated = Object.assign({}, c)
      updated[field] = value
      return updated
    })
    onUpdateTermination(panelId, Object.assign({}, termData, { controllers: newControllers }))
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
    var filteredEstimate = estimateEquipment.filter(function(estEq) {
      return !pickerSearch || up(estEq.type).indexOf(up(pickerSearch)) >= 0
    })
    return (
      <div>
        {estimateEquipment.length > 0 && (
          <div className="relative mb-2">
            <button onClick={function() { setShowPicker(!showPicker) }} className="text-[11px] text-cyan hover:text-white font-medium uppercase">+ ADD FROM ESTIMATE ▾</button>
            {showPicker && (
              <>
                <div className="fixed inset-0 z-10" onClick={function() { setShowPicker(false) }} />
                <div className="absolute z-20 mt-1 bg-card2 border border-border rounded-lg shadow-lg w-80">
                  <div className="p-2 border-b border-border">
                    <input autoFocus value={pickerSearch} onChange={function(e) { setPickerSearch(e.target.value) }} placeholder="SEARCH EQUIPMENT..." style={{textTransform:'uppercase'}} className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white outline-none focus:border-teal placeholder:text-dgray" onClick={function(e) { e.stopPropagation() }} />
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {filteredEstimate.length === 0 && <div className="px-3 py-2 text-[10px] text-dgray uppercase">NO MATCHES</div>}
                    {filteredEstimate.map(function(estEq, i) {
                      var allocated = allocatedByType[up(estEq.type)] || 0
                      var remaining = Math.max(0, estEq.qty - allocated)
                      var defaultQty = remaining > 0 ? remaining : estEq.qty
                      var qtyVal = qtyOverrides[estEq.type] != null ? qtyOverrides[estEq.type] : defaultQty
                      return (
                        <div key={i} className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-teal/10">
                          <div className="flex-1 min-w-0 text-[11px] uppercase text-lgray truncate">
                            {estEq.type} <span className="text-[9px] opacity-60">({allocated}/{estEq.qty} ALLOCATED)</span>
                          </div>
                          <input type="number" min="1" value={qtyVal} onClick={function(e) { e.stopPropagation() }} onChange={function(e) { setQtyOverrides(Object.assign({}, qtyOverrides, { [estEq.type]: e.target.value })) }} className="w-12 bg-navy border border-border rounded px-1 py-0.5 text-[10px] text-cyan text-center outline-none focus:border-teal" />
                          <button onClick={function() { addFromEstimate(estEq, Number(qtyVal) || 1) }} title="ADD TO THIS PANEL" className="px-2 py-0.5 bg-teal/20 text-teal text-[10px] font-bold rounded hover:bg-teal/30 shrink-0">+</button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        <IoSheetGrid
          eqs={equipment}
          panelId={panelId}
          onUpdateEquipment={onUpdateEquipment}
          onUndo={props.onUndo}
          height={estimateEquipment.length > 0 ? 400 : 440}
          compact
        />
      </div>
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

        <div className="bg-card rounded-xl border border-border p-3 mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] text-dgray">
              CONTROLLER NETWORK — set on-site when connecting, per controller
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 text-[10px] text-dgray hover:text-white cursor-pointer"
                title="Also check the terminal's own configuration — KMC termination/bias (647) and scaling (531/532). Catches a correctly-named point wired as the wrong input type (10K thermistor vs 0-10V vs dry contact).">
                <input type="checkbox" checked={depth.io}
                  onChange={function(e) { setDepth(Object.assign({}, depth, { io: e.target.checked })) }} />
                IO CONFIG
              </label>
              <label className="flex items-center gap-1 text-[10px] text-dgray hover:text-white cursor-pointer"
                title="Also read RELIABILITY, OUT-OF-SERVICE and PRESENT-VALUE. Reports open-loop / shorted-loop / no-sensor from the panel, without walking to the field device.">
                <input type="checkbox" checked={depth.health}
                  onChange={function(e) { setDepth(Object.assign({}, depth, { health: e.target.checked })) }} />
                HEALTH
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-dgray">IFACE</span>
                {ifList.length > 0 ? (
                  <select value={iface}
                    onChange={function(e) { setIface(e.target.value); ca.setLocalAddress(e.target.value) }}
                    title="This laptop's BACnet/IP interface. Must be an address that exists on this machine, on a port KMC Connect isn't holding."
                    className={'px-1.5 py-0.5 text-[10px] bg-bg border rounded outline-none cursor-pointer ' +
                      (iface ? 'border-border text-white' : 'border-red/60 text-red')}>
                    <option value="">SELECT INTERFACE…</option>
                    {ifList.map(function(i) {
                      return <option key={i.suggested} value={i.suggested}>
                        {i.suggested}{i.usable ? '' : ' (in use)'}
                      </option>
                    })}
                  </select>
                ) : (
                  <input type="text" value={iface}
                    onChange={function(e) { setIface(e.target.value); ca.setLocalAddress(e.target.value) }}
                    placeholder="192.168.1.100/24:47809" title="Agent not reachable — type the interface manually"
                    className="w-44 px-1.5 py-0.5 text-[10px] bg-bg border border-border rounded text-dgray focus:text-white outline-none focus:border-teal" />
                )}
              </div>
            </div>
          </div>
          {(termData.controllers || [{ index: 1, model: termData.controller || '', bacnetId: '', ip: '' }]).map(function(c) {
            var cs = comm[c.index] || {}
            var sum = cs.summary
            return (
              <div key={c.index} className="py-1.5 border-t border-border first:border-t-0">
                <div className="flex items-center gap-3">
                  <div className="w-24 text-xs font-bold text-cyan shrink-0">
                    CTRL {c.index} <span className="text-dgray font-normal">({c.model})</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-dgray">BACNET ID</span>
                    <input type="text" value={c.bacnetId || ''}
                      onChange={function(e) { updateControllerField(c.index, 'bacnetId', e.target.value) }}
                      placeholder="e.g. 900" className="w-20 px-2 py-1 text-xs bg-bg border border-border rounded" />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-dgray">STATIC IP</span>
                    <input type="text" value={c.ip || ''}
                      onChange={function(e) { updateControllerField(c.index, 'ip', e.target.value) }}
                      placeholder="e.g. 192.168.1.12" className="w-32 px-2 py-1 text-xs bg-bg border border-border rounded" />
                  </div>
                  {projectId && c.ip && (
                    <div className="flex items-center gap-1.5 ml-auto">
                      <button onClick={function() { runVerify(c) }} disabled={!!cs.busy || !iface}
                        title={!iface ? 'Pick an IFACE first — without it the read cannot bind a socket' : ''}
                        className="px-2.5 py-1 text-[10px] font-semibold uppercase rounded border border-teal/50 text-teal hover:bg-teal/10 disabled:opacity-40 disabled:cursor-not-allowed">
                        {cs.busy === 'verify' ? 'VERIFYING…' : 'VERIFY'}
                      </button>
                      <button onClick={function() { runWrite(c) }} disabled={!!cs.busy || !iface}
                        title={!iface ? 'Pick an IFACE first' : ''}
                        className="px-2.5 py-1 text-[10px] font-semibold uppercase rounded border border-orange/50 text-orange hover:bg-orange/10 disabled:opacity-40 disabled:cursor-not-allowed">
                        {cs.busy === 'write' ? 'WRITING…' : 'WRITE'}
                      </button>
                    </div>
                  )}
                </div>

                {cs.err && <div className="mt-1 text-[10px] text-red">{cs.err}</div>}

                {sum && (
                  <div className="mt-1 flex items-center gap-2 text-[10px]">
                    <span className="text-dgray">{sum.checked} PTS</span>
                    <span className="text-green">{sum.ok} OK</span>
                    {sum.mismatch > 0 && <span className="text-orange">{sum.mismatch} MISMATCH</span>}
                    {sum.missing > 0 && <span className="text-red">{sum.missing} MISSING</span>}
                    {sum.error > 0 && <span className="text-red">{sum.error} ERROR</span>}
                    {cs.details && cs.details.length > 0 && (
                      <button onClick={function() { setCommFor(c.index, { showDetails: !cs.showDetails }) }}
                        className="text-dgray hover:text-cyan underline decoration-dotted">
                        {cs.showDetails ? 'HIDE' : 'DETAILS'}
                      </button>
                    )}
                  </div>
                )}

                {cs.faults && cs.faults.length > 0 && (
                  <div className="mt-1.5 px-2 py-1.5 bg-red/10 border border-red/40 rounded">
                    <div className="text-[10px] font-bold text-red uppercase mb-1">
                      {cs.faults.length} FIELD FAULT{cs.faults.length === 1 ? '' : 'S'} — SENSOR/WIRING, NOT CONFIG
                    </div>
                    {cs.faults.map(function(f, i) {
                      return (
                        <div key={i} className="flex gap-2 text-[10px]">
                          <span className="text-cyan w-14 shrink-0">{f.obj_token}</span>
                          <span className="text-red">{String(f.actual)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {cs.showDetails && cs.details && (
                  <div className="mt-1 max-h-40 overflow-y-auto border border-border/50 rounded">
                    {cs.details.map(function(d, i) {
                      return (
                        <div key={i} className="flex gap-2 px-2 py-1 text-[10px] border-b border-border/20 last:border-0">
                          <span className="text-cyan w-14 shrink-0">{d.obj_token}</span>
                          <span className="text-dgray flex-1 truncate">{d.property_name || d.op}</span>
                          {d.expected !== undefined && <span className="text-dgray truncate max-w-[30%]" title={String(d.expected)}>{String(d.expected)}</span>}
                          <span className={'font-semibold ' + (d.status === 'error' ? 'text-red' : 'text-orange')}>{d.status}</span>
                        </div>
                      )
                    })}
                  </div>
                )}

                {cs.regenNotice && (
                  <div className="mt-1.5 px-2 py-1.5 text-[10px] bg-cyan/10 border border-cyan/30 text-cyan rounded">
                    {cs.regenNotice}
                  </div>
                )}
              </div>
            )
          })}
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
