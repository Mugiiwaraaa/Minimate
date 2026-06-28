import { useState } from 'react'
import StatusBadge from '../components/StatusBadge'

var loopStages = ['comm_cable','control_cable','continuity','termination','device_installed','address_set']
var loopStageLabels = {
  comm_cable: 'Comm Cable',
  control_cable: 'Ctrl Cable',
  continuity: 'Continuity',
  termination: 'Termination',
  device_installed: 'Installed',
  address_set: 'Address',
}

var protocols = ['Modbus RTU', 'BACnet MSTP', 'BACnet IP']
var deviceTypes = ['FCU Thermostat', 'FCU Controller', 'VAV Thermostat', 'VAV Controller', 'Sensor', 'Other']

var nextLoopId = 100
var nextDeviceId = 1000

function generateId(prefix) {
  if (prefix === 'loop') return 'loop-' + (nextLoopId++)
  return 'ldev-' + (nextDeviceId++)
}

export default function CommLoops({ loops, onUpdateLoops }) {
  var expandedState = useState(null)
  var expanded = expandedState[0]
  var setExpanded = expandedState[1]

  var showAddState = useState(false)
  var showAdd = showAddState[0]
  var setShowAdd = showAddState[1]

  var addDevToState = useState(null)
  var addDevTo = addDevToState[0]
  var setAddDevTo = addDevToState[1]

  var editState = useState(null)
  var editing = editState[0]
  var setEditing = editState[1]
  var editValState = useState('')
  var editVal = editValState[0]
  var setEditVal = editValState[1]

  var updateLogState = useState([])
  var updateLog = updateLogState[0]
  var setUpdateLog = updateLogState[1]

  // New loop form state
  var newLoopState = useState({ name: '', protocol: 'Modbus RTU', gateway: '', ddc_ref: '' })
  var newLoop = newLoopState[0]
  var setNewLoop = newLoopState[1]

  // New device form state
  var newDevState = useState({ device_type: 'FCU Thermostat', device_id: '', room_name: '', address: '' })
  var newDev = newDevState[0]
  var setNewDev = newDevState[1]

  function addLoop() {
    if (!newLoop.name.trim()) return
    var loop = {
      id: generateId('loop'),
      name: newLoop.name.trim(),
      protocol: newLoop.protocol,
      gateway: newLoop.gateway.trim(),
      ddc_ref: newLoop.ddc_ref.trim(),
      devices: [],
    }
    onUpdateLoops(loops.concat([loop]))
    setNewLoop({ name: '', protocol: 'Modbus RTU', gateway: '', ddc_ref: '' })
    setShowAdd(false)
    setExpanded(loop.id)
  }

  function deleteLoop(loopId) {
    if (!confirm('Remove this loop? Devices inside will be lost.')) return
    onUpdateLoops(loops.filter(function(l) { return l.id !== loopId }))
  }

  function addDevice(loopId) {
    if (!newDev.device_id.trim()) return
    var dev = {
      id: generateId('dev'),
      device_type: newDev.device_type,
      device_id: newDev.device_id.trim(),
      room_name: newDev.room_name.trim(),
      address: newDev.address.trim(),
      comm_cable: false, control_cable: false, continuity: false,
      termination: false, device_installed: false, address_set: false,
      remarks: '',
    }
    onUpdateLoops(loops.map(function(l) {
      if (l.id === loopId) return Object.assign({}, l, { devices: l.devices.concat([dev]) })
      return l
    }))
    setNewDev({ device_type: 'FCU Thermostat', device_id: '', room_name: '', address: '' })
    setAddDevTo(null)
  }

  function removeDevice(loopId, devId) {
    onUpdateLoops(loops.map(function(l) {
      if (l.id === loopId) return Object.assign({}, l, { devices: l.devices.filter(function(d) { return d.id !== devId }) })
      return l
    }))
  }

  function handleToggle(loopId, devId, stage) {
    onUpdateLoops(loops.map(function(l) {
      if (l.id !== loopId) return l
      return Object.assign({}, l, {
        devices: l.devices.map(function(d) {
          if (d.id !== devId) return d
          var newVal = !d[stage]
          var idx = loopStages.indexOf(stage)
          if (newVal && idx > 0 && !d[loopStages[idx - 1]]) return d
          var updates = {}
          updates[stage] = newVal
          if (!newVal) {
            for (var i = idx + 1; i < loopStages.length; i++) updates[loopStages[i]] = false
          }
          return Object.assign({}, d, updates)
        })
      })
    }))
    var now = new Date()
    var timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    setUpdateLog(function(prev) {
      return [{ time: timeStr, msg: devId + ' -- ' + loopStageLabels[stage] }].concat(prev).slice(0, 50)
    })
  }

  function handleDeviceFieldChange(loopId, devId, field, value) {
    onUpdateLoops(loops.map(function(l) {
      if (l.id !== loopId) return l
      return Object.assign({}, l, {
        devices: l.devices.map(function(d) {
          if (d.id !== devId) return d
          var u = {}
          u[field] = value
          return Object.assign({}, d, u)
        })
      })
    }))
  }

  function startEditLoop(field, loopId, currentValue) {
    setEditing('loop-' + field + ':' + loopId)
    setEditVal(currentValue || '')
  }

  function saveEditLoop(loopId, field) {
    onUpdateLoops(loops.map(function(l) {
      if (l.id !== loopId) return l
      var u = {}
      u[field] = editVal
      return Object.assign({}, l, u)
    }))
    setEditing(null)
  }

  // Stats
  var totalDevices = loops.reduce(function(s, l) { return s + l.devices.length }, 0)
  var totalInstalled = loops.reduce(function(s, l) {
    return s + l.devices.filter(function(d) { return d.device_installed }).length
  }, 0)
  var totalAddressed = loops.reduce(function(s, l) {
    return s + l.devices.filter(function(d) { return d.address_set }).length
  }, 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">
          Communication Loops
          <span className="text-dgray font-normal text-sm ml-2">{loops.length} loops, {totalDevices} devices</span>
        </h1>
        <button onClick={function() { setShowAdd(!showAdd) }}
          className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 transition">
          + Add Loop
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[11px] text-dgray uppercase">Loops</div>
          <div className="text-2xl font-extrabold text-cyan">{loops.length}</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[11px] text-dgray uppercase">Devices</div>
          <div className="text-2xl font-extrabold text-cyan">{totalDevices}</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[11px] text-dgray uppercase">Installed</div>
          <div className="text-2xl font-extrabold text-green">{totalInstalled}/{totalDevices}</div>
        </div>
        <div className="bg-card rounded-xl p-4 border border-border">
          <div className="text-[11px] text-dgray uppercase">Addressed</div>
          <div className="text-2xl font-extrabold text-green">{totalAddressed}/{totalDevices}</div>
        </div>
      </div>

      {/* Add loop form */}
      {showAdd && (
        <div className="bg-card rounded-xl border border-teal p-4 mb-4">
          <h3 className="text-sm font-semibold mb-3">New Communication Loop</h3>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div>
              <label className="text-[10px] text-dgray uppercase block mb-1">Loop Name</label>
              <input value={newLoop.name} onChange={function(e) { setNewLoop(Object.assign({}, newLoop, { name: e.target.value })) }}
                placeholder="e.g. Loop 1 - GF Z1"
                className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal" />
            </div>
            <div>
              <label className="text-[10px] text-dgray uppercase block mb-1">Protocol</label>
              <select value={newLoop.protocol} onChange={function(e) { setNewLoop(Object.assign({}, newLoop, { protocol: e.target.value })) }}
                className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal">
                {protocols.map(function(p) { return <option key={p} value={p}>{p}</option> })}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-dgray uppercase block mb-1">Gateway #</label>
              <input value={newLoop.gateway} onChange={function(e) { setNewLoop(Object.assign({}, newLoop, { gateway: e.target.value })) }}
                placeholder="e.g. GW-01"
                className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal" />
            </div>
            <div>
              <label className="text-[10px] text-dgray uppercase block mb-1">DDC Reference</label>
              <input value={newLoop.ddc_ref} onChange={function(e) { setNewLoop(Object.assign({}, newLoop, { ddc_ref: e.target.value })) }}
                placeholder="e.g. DDC-GF-01"
                className="w-full bg-navy border border-border rounded px-2 py-1.5 text-xs text-white outline-none focus:border-teal" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={addLoop} className="px-4 py-1.5 bg-teal text-white text-xs font-semibold rounded hover:bg-teal/80">Create Loop</button>
            <button onClick={function() { setShowAdd(false) }} className="px-4 py-1.5 bg-card2 text-dgray text-xs rounded hover:text-white">Cancel</button>
          </div>
        </div>
      )}

      {/* Loop cards */}
      {loops.map(function(loop) {
        var isExpanded = expanded === loop.id
        var devCount = loop.devices.length
        var installed = loop.devices.filter(function(d) { return d.device_installed }).length
        var addressed = loop.devices.filter(function(d) { return d.address_set }).length
        var pct = devCount > 0 ? Math.round(installed / devCount * 100) : 0
        var status = pct >= 100 ? 'done' : pct > 0 ? 'progress' : 'pending'

        return (
          <div key={loop.id} className="bg-card rounded-xl border border-border mb-3 overflow-hidden">
            <div className="bg-card2 px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-card2/80"
              onClick={function() { setExpanded(isExpanded ? null : loop.id) }}>
              <div className="flex items-center gap-3">
                <span className="text-sm font-bold">{loop.name}</span>
                <span className="text-[10px] bg-purple/20 text-purple px-2 py-0.5 rounded">{loop.protocol}</span>
                {loop.gateway && <span className="text-[10px] text-dgray">GW: {loop.gateway}</span>}
                {loop.ddc_ref && <span className="text-[10px] text-dgray">DDC: {loop.ddc_ref}</span>}
                <span className="text-[10px] text-dgray">{devCount} devices</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <div className="w-20 h-1.5 bg-navy rounded overflow-hidden">
                    <div className={'h-full rounded ' + (pct >= 100 ? 'bg-green' : pct >= 50 ? 'bg-teal' : pct > 0 ? 'bg-orange' : 'bg-red')}
                      style={{width: pct + '%'}} />
                  </div>
                  <span className="text-[10px] text-dgray">{pct}%</span>
                </div>
                <StatusBadge status={status} label={status === 'done' ? 'Done' : status === 'progress' ? 'In Progress' : 'Pending'} />
                <button onClick={function(e) { e.stopPropagation(); deleteLoop(loop.id) }}
                  className="text-[10px] text-red/50 hover:text-red ml-2">Remove</button>
                <span className="text-dgray text-xs">{isExpanded ? 'v' : '>'}</span>
              </div>
            </div>

            {isExpanded && (
              <div className="px-4 py-3">
                {/* Add device button */}
                {addDevTo === loop.id ? (
                  <div className="bg-card2 rounded-lg p-3 mb-3 border border-border">
                    <div className="grid grid-cols-5 gap-2 mb-2">
                      <div>
                        <label className="text-[9px] text-dgray uppercase block mb-0.5">Device Type</label>
                        <select value={newDev.device_type} onChange={function(e) { setNewDev(Object.assign({}, newDev, { device_type: e.target.value })) }}
                          className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none">
                          {deviceTypes.map(function(dt) { return <option key={dt} value={dt}>{dt}</option> })}
                        </select>
                      </div>
                      <div>
                        <label className="text-[9px] text-dgray uppercase block mb-0.5">Device ID</label>
                        <input value={newDev.device_id} onChange={function(e) { setNewDev(Object.assign({}, newDev, { device_id: e.target.value })) }}
                          placeholder="e.g. FCU-GF-Z1-001"
                          className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none" />
                      </div>
                      <div>
                        <label className="text-[9px] text-dgray uppercase block mb-0.5">Room</label>
                        <input value={newDev.room_name} onChange={function(e) { setNewDev(Object.assign({}, newDev, { room_name: e.target.value })) }}
                          placeholder="e.g. Classroom 101"
                          className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none" />
                      </div>
                      <div>
                        <label className="text-[9px] text-dgray uppercase block mb-0.5">Address</label>
                        <input value={newDev.address} onChange={function(e) { setNewDev(Object.assign({}, newDev, { address: e.target.value })) }}
                          placeholder="e.g. 1"
                          className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none" />
                      </div>
                      <div className="flex items-end gap-1">
                        <button onClick={function() { addDevice(loop.id) }}
                          className="px-3 py-1 bg-teal text-white text-[11px] font-semibold rounded hover:bg-teal/80">Add</button>
                        <button onClick={function() { setAddDevTo(null) }}
                          className="px-3 py-1 bg-card text-dgray text-[11px] rounded hover:text-white">Cancel</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <button onClick={function() { setAddDevTo(loop.id) }}
                    className="text-[11px] text-teal hover:text-cyan font-medium mb-3 block">+ Add Device</button>
                )}

                {/* Devices table */}
                {loop.devices.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border/50">
                          <th className="text-[9px] text-dgray uppercase text-left px-2 py-1.5">Type</th>
                          <th className="text-[9px] text-dgray uppercase text-left px-2 py-1.5">Device ID</th>
                          <th className="text-[9px] text-dgray uppercase text-left px-2 py-1.5">Room</th>
                          <th className="text-[9px] text-dgray uppercase text-center px-2 py-1.5">Address</th>
                          {loopStages.map(function(s) {
                            return <th key={s} className="text-[9px] text-dgray uppercase text-center px-1 py-1.5">{loopStageLabels[s]}</th>
                          })}
                          <th className="text-[9px] text-dgray uppercase text-left px-2 py-1.5">Remarks</th>
                          <th className="text-[9px] text-dgray uppercase text-center px-1 py-1.5 w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {loop.devices.map(function(dev) {
                          return (
                            <tr key={dev.id} className="border-b border-border/20 hover:bg-teal/4">
                              <td className="text-[10px] px-2 py-1.5 text-purple">{dev.device_type}</td>
                              <td className="text-[11px] px-2 py-1.5 font-medium">{dev.device_id}</td>
                              <td className="text-[11px] px-2 py-1.5">
                                <input type="text" value={dev.room_name}
                                  onChange={function(e) { handleDeviceFieldChange(loop.id, dev.id, 'room_name', e.target.value) }}
                                  className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-white outline-none w-full px-0.5"
                                  placeholder="-" />
                              </td>
                              <td className="text-center px-2 py-1.5">
                                <input type="text" value={dev.address}
                                  onChange={function(e) { handleDeviceFieldChange(loop.id, dev.id, 'address', e.target.value) }}
                                  className="bg-transparent border-b border-transparent focus:border-teal text-[11px] text-cyan text-center outline-none w-12 mx-auto"
                                  placeholder="-" />
                              </td>
                              {loopStages.map(function(s) {
                                var checked = dev[s]
                                var idx = loopStages.indexOf(s)
                                var prevDone = idx === 0 || dev[loopStages[idx - 1]]
                                return (
                                  <td key={s} className="text-center px-1 py-1.5">
                                    <button
                                      onClick={function() { handleToggle(loop.id, dev.id, s) }}
                                      disabled={!prevDone && !checked}
                                      className={'w-5 h-5 rounded border text-[9px] font-bold transition ' + (
                                        checked ? 'bg-green border-green text-white'
                                          : prevDone ? 'border-border hover:border-teal cursor-pointer'
                                          : 'border-border/20 opacity-20 cursor-not-allowed'
                                      )}>{checked ? '!' : ''}</button>
                                  </td>
                                )
                              })}
                              <td className="px-2 py-1.5">
                                <input type="text" value={dev.remarks || ''}
                                  onChange={function(e) { handleDeviceFieldChange(loop.id, dev.id, 'remarks', e.target.value) }}
                                  className="bg-transparent border-b border-transparent focus:border-teal text-[10px] text-orange italic outline-none w-full px-0.5"
                                  placeholder="" />
                              </td>
                              <td className="text-center px-1 py-1.5">
                                <button onClick={function() { removeDevice(loop.id, dev.id) }}
                                  className="text-[9px] text-red/40 hover:text-red">x</button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-[11px] text-dgray italic py-2">No devices in this loop yet. Click + Add Device above.</div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {loops.length === 0 && !showAdd && (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <div className="text-dgray text-sm">No communication loops created yet.</div>
          <div className="text-[11px] text-dgray mt-1">Click + Add Loop to create your first loop.</div>
        </div>
      )}

      {updateLog.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4 mt-4">
          <h3 className="text-sm font-semibold mb-3">Update Log</h3>
          {updateLog.slice(0, 15).map(function(log, i) {
            return (
              <div key={i} className="flex gap-3 py-1 border-b border-border/30 last:border-0 text-[11px]">
                <span className="text-dgray w-12">{log.time}</span>
                <span className="text-cyan font-semibold w-16">You</span>
                <span className="text-lgray">{log.msg}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
