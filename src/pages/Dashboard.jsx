import { useMemo } from 'react'
import ProgressBar from '../components/ProgressBar'
import StatusBadge from '../components/StatusBadge'

var fdWeights={comm_cable:25,control_cable:25,continuity:10,termination:25,device_installed:15,address_set:0}
function calcFDPct(devs){
  if(!devs||devs.length===0)return 0
  var total=0
  devs.forEach(function(d){
    if(d.comm_cable)total+=fdWeights.comm_cable
    if(d.control_cable)total+=fdWeights.control_cable
    if(d.continuity)total+=fdWeights.continuity
    if(d.termination)total+=fdWeights.termination
    if(d.device_installed)total+=fdWeights.device_installed
    if(d.address_set)total+=fdWeights.address_set
  })
  return Math.round(total/devs.length)
}

export default function Dashboard(props) {
  var panels = props.panels
  var equipmentMap = props.equipmentMap
  var loops = props.loops

  var stats = useMemo(function() {
    var totalPanels = panels.length
    var totalPoints = 0
    var pointsCablePulled = 0
    var pointsContinuity = 0
    var pointsTermDDC = 0
    var pointsTermField = 0
    var pointsFuncTest = 0

    var panelStats = panels.map(function(p) {
      var eqs = equipmentMap[p.id] || []
      var pts = eqs.flatMap(function(eq) { return (eq.points || []).filter(function(pt) { return !pt.excluded }) })
      var total = pts.length
      var done = pts.filter(function(pt) { return pt.functional_test }).length
      totalPoints += total
      pointsCablePulled += pts.filter(function(pt) { return pt.cable_pulled }).length
      pointsContinuity += pts.filter(function(pt) { return pt.cable_continuity }).length
      pointsTermDDC += pts.filter(function(pt) { return pt.term_ddc_side }).length
      pointsTermField += pts.filter(function(pt) { return pt.term_field_side }).length
      pointsFuncTest += pts.filter(function(pt) { return pt.functional_test }).length
      return Object.assign({}, p, { totalPts: total, donePts: done, pct: total > 0 ? Math.round(done/total*100) : 0 })
    })

    var completedPanels = panelStats.filter(function(p) { return p.pct >= 100 }).length
    var loopArr = loops || []
    var allDevices = loopArr.flatMap(function(l) { return l.devices || [] })
    var totalFD = allDevices.length
    var fdCommDone = allDevices.filter(function(d) { return d.comm_cable }).length
    var fdCtrlDone = allDevices.filter(function(d) { return d.control_cable }).length
    var fdContDone = allDevices.filter(function(d) { return d.continuity }).length
    var fdTermDone = allDevices.filter(function(d) { return d.termination }).length
    var fdInstalled = allDevices.filter(function(d) { return d.device_installed }).length
    var fdAddressed = allDevices.filter(function(d) { return d.address_set }).length
    var fdFullyDone = allDevices.filter(function(d) {
      return d.comm_cable && d.control_cable && d.continuity && d.termination && d.device_installed && d.address_set
    }).length

    return {
      totalPanels: totalPanels, completedPanels: completedPanels, totalPoints: totalPoints,
      pointsCablePulled: pointsCablePulled, pointsContinuity: pointsContinuity, pointsTermDDC: pointsTermDDC,
      pointsTermField: pointsTermField, pointsFuncTest: pointsFuncTest,
      totalFD: totalFD, fdCommDone: fdCommDone, fdCtrlDone: fdCtrlDone, fdContDone: fdContDone, fdTermDone: fdTermDone, fdInstalled: fdInstalled, fdAddressed: fdAddressed, fdFullyDone: fdFullyDone, panelStats: panelStats,
    }
  }, [panels, equipmentMap, loops])

  var ioPct = stats.totalPoints > 0 ? Math.round(stats.pointsFuncTest / stats.totalPoints * 100) : 0
  var loopArr = loops || []
  var allFDDevices = loopArr.flatMap(function(l) { return l.devices || [] })
  var fdPct = calcFDPct(allFDDevices)

  var pipelineStages = [
    { label: 'CABLE PULLED', val: stats.pointsCablePulled },
    { label: 'CONTINUITY', val: stats.pointsContinuity },
    { label: 'TERM DDC', val: stats.pointsTermDDC },
    { label: 'TERM FIELD', val: stats.pointsTermField },
    { label: 'FUNC TEST', val: stats.pointsFuncTest },
  ]

  return (
    <div style={{textTransform:'uppercase'}}>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-6">
        <h1 className="text-lg md:text-xl font-bold">
          {props.projectName || 'MINIMATE'}
          <span className="text-dgray font-normal text-xs md:text-sm ml-2">{props.projectSub || ''}</span>
        </h1>
        <button className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 transition w-fit">
          EXPORT REPORT
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard label="DDC PANELS" value={stats.totalPanels} color="text-cyan" sub={stats.completedPanels + ' COMPLETED'} />
        <StatCard label="IO POINTS" value={stats.totalPoints} color="text-cyan" sub={stats.pointsFuncTest + ' FUNC TESTED'} />
        <StatCard label="IO PROGRESS" value={ioPct + '%'} color={ioPct >= 80 ? 'text-green' : ioPct >= 40 ? 'text-orange' : 'text-red'} sub="FUNCTIONAL TEST" />
        <StatCard label="FIELD DEVICES" value={stats.totalFD} color="text-cyan" sub={stats.totalFD > 0 ? fdPct + '% COMPLETE' : 'NO LOOPS YET'} />
      </div>

      <div className="bg-card rounded-xl p-4 border border-border mb-4">
        <h3 className="text-sm font-semibold mb-3">IO COMMISSIONING PIPELINE</h3>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
          {pipelineStages.map(function(s, i) {
            var pct = stats.totalPoints > 0 ? Math.round(s.val / stats.totalPoints * 100) : 0
            return (
              <div key={i} className="text-center">
                <div className="text-[10px] text-dgray mb-1">{s.label}</div>
                <div className="text-lg font-bold text-white">{s.val}</div>
                <div className="text-[10px] text-dgray">{pct}%</div>
                <div className="w-full h-1.5 bg-card2 rounded mt-1">
                  <div className="h-full bg-teal rounded" style={{width: pct + '%'}} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-card rounded-xl p-4 border border-border">
          <h3 className="text-sm font-semibold mb-3">COMMUNICATION LOOPS</h3>
          {stats.totalFD === 0 ? (
            <p className="text-xs text-dgray">NO COMM LOOPS CREATED YET. GO TO FIELD DEVICES TO ADD LOOPS.</p>
          ) : (
            <div>
              <div className="flex justify-between text-xs mb-2">
                <span className="text-dgray">OVERALL PROGRESS (WEIGHTED)</span>
                <span className={'font-bold '+(fdPct>=80?'text-green':fdPct>=40?'text-orange':'text-red')}>{fdPct}%</span>
              </div>
              <ProgressBar value={fdPct} max={100} height="h-3" />
              <div className="grid grid-cols-3 gap-x-4 gap-y-2 mt-3 text-[10px]">
                <div className="flex justify-between"><span className="text-dgray">COMM CABLE</span><span className="text-cyan">{stats.fdCommDone}/{stats.totalFD}</span></div>
                <div className="flex justify-between"><span className="text-dgray">CTRL CABLE</span><span className="text-cyan">{stats.fdCtrlDone}/{stats.totalFD}</span></div>
                <div className="flex justify-between"><span className="text-dgray">CONTINUITY</span><span className="text-cyan">{stats.fdContDone}/{stats.totalFD}</span></div>
                <div className="flex justify-between"><span className="text-dgray">TERMINATION</span><span className="text-cyan">{stats.fdTermDone}/{stats.totalFD}</span></div>
                <div className="flex justify-between"><span className="text-dgray">INSTALLED</span><span className="text-cyan">{stats.fdInstalled}/{stats.totalFD}</span></div>
              </div>
            </div>
          )}
        </div>

        <div className="bg-card rounded-xl p-4 border border-border">
          <h3 className="text-sm font-semibold mb-3">QUICK ACTIONS</h3>
          <div className="space-y-2">
            <a href="#/panels" className="flex items-center gap-2 px-3 py-2 bg-card2 rounded-lg hover:bg-teal/10 transition text-xs">
              <span>🔲</span> VIEW DDC PANELS ({stats.totalPanels} PANELS, {stats.totalPoints} IO POINTS)
            </a>
            <a href="#/field-devices" className="flex items-center gap-2 px-3 py-2 bg-card2 rounded-lg hover:bg-teal/10 transition text-xs">
              <span>🔗</span> FIELD DEVICES ({stats.totalFD} DEVICES IN {(loops || []).length} LOOPS)
            </a>
          </div>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border mt-4 overflow-hidden">
        <div className="bg-card2 px-4 py-2.5">
          <span className="text-sm font-bold">DDC PANEL OVERVIEW</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/50">
                <th className="text-[10px] font-semibold text-dgray text-left px-4 py-2">PANEL</th>
                <th className="text-[10px] font-semibold text-dgray text-left px-2 py-2">LOCATION</th>
                <th className="text-[10px] font-semibold text-dgray text-center px-2 py-2 w-16">POINTS</th>
                <th className="text-[10px] font-semibold text-dgray text-center px-2 py-2 w-32">PROGRESS</th>
                <th className="text-[10px] font-semibold text-dgray text-center px-2 py-2 w-20">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {stats.panelStats.map(function(p) {
                var status = p.pct >= 100 ? 'done' : p.pct > 0 ? 'progress' : 'pending'
                return (
                  <tr key={p.id} className="border-b border-border/20 hover:bg-teal/4">
                    <td className="text-xs px-4 py-2 font-medium">{p.name}</td>
                    <td className="text-xs px-2 py-2 text-dgray">{p.location}</td>
                    <td className="text-xs px-2 py-2 text-center">{p.totalPts}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-1.5 bg-card2 rounded overflow-hidden">
                          <div className={'h-full rounded ' + (p.pct >= 100 ? 'bg-green' : p.pct >= 50 ? 'bg-teal' : p.pct > 0 ? 'bg-orange' : 'bg-red')} style={{width: p.pct + '%'}} />
                        </div>
                        <span className="text-[10px] text-dgray w-8 text-right">{p.pct}%</span>
                      </div>
                    </td>
                    <td className="text-center px-2 py-2">
                      <StatusBadge status={status} label={status === 'done' ? 'DONE' : status === 'progress' ? 'IN PROGRESS' : 'PENDING'} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function StatCard(props) {
  return (
    <div className="bg-card rounded-xl p-4 border border-border hover:border-teal transition">
      <div className="text-[11px] text-dgray font-medium tracking-wide">{props.label}</div>
      <div className={'text-2xl font-extrabold mt-1 ' + props.color}>{props.value}</div>
      <div className="text-[11px] text-dgray">{props.sub}</div>
    </div>
  )
}
