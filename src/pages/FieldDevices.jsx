import { useState, useMemo } from 'react'
import ProgressBar from '../components/ProgressBar'
import StatusBadge from '../components/StatusBadge'

const fdStages = ['comm_loop','control_cable','termination','functional_test']
const fdLabels = { comm_loop:'Comm Loop', control_cable:'Control Cable', termination:'Termination', functional_test:'Func Test' }

export default function FieldDevices({ schedules, devices, onUpdateDevice }) {
  const [levelFilter, setLevelFilter] = useState('all')
  const [expandedSchedule, setExpandedSchedule] = useState(null)
  const [updateLog, setUpdateLog] = useState([])

  const levels = useMemo(() => {
    const lvls = [...new Set(schedules.map(s => s.level))]
    return lvls.sort()
  }, [schedules])

  const filteredSchedules = useMemo(() => {
    if (levelFilter === 'all') return schedules
    return schedules.filter(s => s.level === levelFilter)
  }, [schedules, levelFilter])

  // Group by level, then zone
  const grouped = useMemo(() => {
    const g = {}
    filteredSchedules.forEach(s => {
      const key = s.level
      if (!g[key]) g[key] = []
      const devs = devices.filter(d => d.schedule_id === s.id)
      const commDone = devs.filter(d => d.comm_loop).length
      const cableDone = devs.filter(d => d.control_cable).length
      const termDone = devs.filter(d => d.termination).length
      const testDone = devs.filter(d => d.functional_test).length
      g[key].push({ ...s, devices: devs, commDone, cableDone, termDone, testDone })
    })
    return g
  }, [filteredSchedules, devices])

  function handleToggle(deviceId, stage) {
    const dev = devices.find(d => d.id === deviceId)
    if (!dev) return
    const newVal = !dev[stage]
    const idx = fdStages.indexOf(stage)
    if (newVal && idx > 0 && !dev[fdStages[idx - 1]]) return
    const updates = { [stage]: newVal }
    if (!newVal) {
      for (let i = idx + 1; i < fdStages.length; i++) updates[fdStages[i]] = false
    }
    onUpdateDevice(deviceId, updates)

    const now = new Date()
    setUpdateLog(prev => [{
      time: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      msg: `${dev.device_id} (${dev.room_name || 'N/A'}) — ${fdLabels[stage]}: ${newVal ? '✓' : '✗'}`,
    }, ...prev].slice(0, 50))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">
          FCU / VAV Tracker
          <span className="text-dgray font-normal text-sm ml-2">{devices.length} units</span>
        </h1>
      </div>

      {/* Level tabs */}
      <div className="flex gap-1 bg-card2 rounded-lg p-1 w-fit mb-5">
        <button
          onClick={() => setLevelFilter('all')}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
            levelFilter === 'all' ? 'bg-teal text-white' : 'text-slate-400 hover:text-white'
          }`}
        >
          All Floors ({devices.length})
        </button>
        {levels.map(lvl => {
          const count = devices.filter(d => {
            const s = schedules.find(s => s.id === d.schedule_id)
            return s && s.level === lvl
          }).length
          return (
            <button
              key={lvl}
              onClick={() => setLevelFilter(lvl)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                levelFilter === lvl ? 'bg-teal text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {lvl} ({count})
            </button>
          )
        })}
      </div>

      {/* Summary table */}
      {Object.entries(grouped).map(([level, scheds]) => (
        <div key={level} className="bg-card rounded-xl border border-border mb-4 overflow-hidden">
          <div className="bg-card2 px-4 py-2.5">
            <span className="text-sm font-bold">{level}</span>
            <span className="text-xs text-dgray ml-2">
              {scheds.reduce((s, sc) => s + sc.devices.length, 0)} units
            </span>
          </div>

          <table className="w-full">
            <thead>
              <tr className="border-b border-border/50">
                <th className="text-[10px] font-semibold text-dgray uppercase text-left px-4 py-2">Zone</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-left px-2 py-2">Part</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-center px-2 py-2 w-12">Qty</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-center px-2 py-2 w-24">Comm Loop</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-center px-2 py-2 w-24">Ctrl Cable</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-center px-2 py-2 w-28">Termination</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-center px-2 py-2 w-20">Status</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-left px-2 py-2">Remarks</th>
                <th className="text-[10px] font-semibold text-dgray uppercase text-center px-2 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {scheds.map(sc => {
                const total = sc.devices.length
                const termPct = total > 0 ? Math.round(sc.termDone / total * 100) : 0
                const status = termPct >= 100 ? 'done' : sc.remarks ? 'blocked' : termPct > 0 ? 'progress' : 'pending'
                const barColor = termPct >= 100 ? 'bg-green' : termPct >= 50 ? 'bg-teal' : termPct > 0 ? 'bg-orange' : 'bg-red'
                return (
                  <tr key={sc.id} className="border-b border-border/20 hover:bg-teal/4">
                    <td className="text-xs px-4 py-2 font-medium">{sc.zone || '-'}</td>
                    <td className="text-xs px-2 py-2">{sc.part || '-'}</td>
                    <td className="text-xs px-2 py-2 text-center">{total}</td>
                    <td className="text-xs px-2 py-2 text-center">{sc.commDone}/{total}</td>
                    <td className="text-xs px-2 py-2 text-center">{sc.cableDone}/{total}</td>
                    <td className="text-xs px-2 py-2 text-center">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-1.5 bg-card2 rounded overflow-hidden">
                          <div className={`h-full ${barColor} rounded`} style={{width:`${termPct}%`}} />
                        </div>
                        <span className="text-[10px]">{sc.termDone}/{total}</span>
                        <span className="text-[10px] text-dgray">{termPct}%</span>
                      </div>
                    </td>
                    <td className="text-center px-2 py-2">
                      <StatusBadge status={status} label={status === 'done' ? 'Done' : status === 'blocked' ? 'Blocked' : status === 'progress' ? 'In Progress' : 'Pending'} />
                    </td>
                    <td className="text-[10px] px-2 py-2 text-orange italic">{sc.remarks || ''}</td>
                    <td className="text-center px-2 py-2">
                      <button
                        onClick={() => setExpandedSchedule(expandedSchedule === sc.id ? null : sc.id)}
                        className="text-[10px] text-teal hover:text-cyan font-medium"
                      >
                        {expandedSchedule === sc.id ? 'Hide' : 'Expand'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Expanded individual devices */}
          {scheds.filter(sc => expandedSchedule === sc.id).map(sc => (
            <div key={sc.id+'exp'} className="border-t border-teal/30 bg-card2/50 px-4 py-3">
              <div className="text-[11px] text-dgray mb-2 font-medium">Individual units — {sc.device_type} {sc.level} Zone {sc.zone} {sc.part}</div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="text-[9px] text-dgray uppercase text-left px-2 py-1">ID</th>
                    <th className="text-[9px] text-dgray uppercase text-left px-2 py-1">Room</th>
                    <th className="text-[9px] text-dgray uppercase text-left px-2 py-1">Loop</th>
                    {fdStages.map(s => (
                      <th key={s} className="text-[9px] text-dgray uppercase text-center px-2 py-1">{fdLabels[s]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sc.devices.map(dev => (
                    <tr key={dev.id} className="border-b border-border/10 hover:bg-teal/4">
                      <td className="text-[11px] px-2 py-1 font-medium">{dev.device_id}</td>
                      <td className="text-[11px] px-2 py-1 text-dgray">{dev.room_name || '-'}</td>
                      <td className="text-[11px] px-2 py-1 text-dgray">{dev.loop || '-'}</td>
                      {fdStages.map(s => {
                        const checked = dev[s]
                        const idx = fdStages.indexOf(s)
                        const prevDone = idx === 0 || dev[fdStages[idx - 1]]
                        return (
                          <td key={s} className="text-center px-2 py-1">
                            <button
                              onClick={() => handleToggle(dev.id, s)}
                              disabled={!prevDone && !checked}
                              className={`w-5 h-5 rounded border text-[10px] font-bold transition ${
                                checked
                                  ? 'bg-green border-green text-white'
                                  : prevDone
                                    ? 'border-border hover:border-teal cursor-pointer'
                                    : 'border-border/20 opacity-20 cursor-not-allowed'
                              }`}
                            >
                              {checked ? '✓' : ''}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}

      {/* Update log */}
      {updateLog.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4 mt-4">
          <h3 className="text-sm font-semibold mb-3">Update Log</h3>
          {updateLog.slice(0, 15).map((log, i) => (
            <div key={i} className="flex gap-3 py-1 border-b border-border/30 last:border-0 text-[11px]">
              <span className="text-dgray w-12">{log.time}</span>
              <span className="text-cyan font-semibold w-20">Supervisor</span>
              <span className="text-lgray">{log.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
