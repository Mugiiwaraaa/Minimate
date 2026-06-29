import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import StatusBadge from '../components/StatusBadge'

function getPanelStatus(panel, equipmentMap) {
  var eqs = equipmentMap[panel.id] || []
  var allPoints = eqs.flatMap(function(e) { return e.points || [] })
  if (allPoints.length === 0) return { status: 'pending', label: 'NO IO LIST' }
  var allDone = allPoints.every(function(p) { return p.functional_test })
  if (allDone) return { status: 'done', label: 'COMPLETE' }
  var anyStarted = allPoints.some(function(p) { return p.cable_pulled })
  return anyStarted
    ? { status: 'progress', label: 'IN PROGRESS' }
    : { status: 'pending', label: 'PENDING' }
}

function getProgress(panel, equipmentMap) {
  var eqs = equipmentMap[panel.id] || []
  var pts = eqs.flatMap(function(e) { return e.points || [] })
  if (pts.length === 0) return { pulled: 0, cont: 0, termD: 0, termF: 0, test: 0, total: 0 }
  return {
    pulled: pts.filter(function(p) { return p.cable_pulled }).length,
    cont: pts.filter(function(p) { return p.cable_continuity }).length,
    termD: pts.filter(function(p) { return p.term_ddc_side }).length,
    termF: pts.filter(function(p) { return p.term_field_side }).length,
    test: pts.filter(function(p) { return p.functional_test }).length,
    total: pts.length,
  }
}

export default function PanelsList(props) {
  var panels = props.panels
  var equipmentMap = props.equipmentMap
  var filterState = useState('all')
  var filter = filterState[0]
  var setFilter = filterState[1]
  var searchState = useState('')
  var search = searchState[0]
  var setSearch = searchState[1]

  var filtered = useMemo(function() {
    return panels
      .filter(function(p) {
        if (filter === 'all') return true
        var st = getPanelStatus(p, equipmentMap).status
        return st === filter
      })
      .filter(function(p) {
        var s = search.toLowerCase()
        return p.name.toLowerCase().includes(s) ||
          p.location.toLowerCase().includes(s) ||
          (p.floor || '').toLowerCase().includes(s)
      })
  }, [panels, filter, search, equipmentMap])

  var counts = useMemo(function() {
    var c = { all: panels.length, done: 0, progress: 0, blocked: 0, pending: 0 }
    panels.forEach(function(p) { c[getPanelStatus(p, equipmentMap).status]++ })
    return c
  }, [panels, equipmentMap])

  var filterTabs = [
    ['all', 'ALL (' + counts.all + ')'],
    ['done', 'COMPLETE (' + counts.done + ')'],
    ['progress', 'IN PROGRESS (' + counts.progress + ')'],
    ['pending', 'PENDING (' + counts.pending + ')'],
  ]

  return (
    <div style={{textTransform:'uppercase'}}>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-5">
        <h1 className="text-xl font-bold">
          DDC PANELS
          <span className="text-dgray font-normal text-sm ml-2">{panels.length} PANELS</span>
        </h1>
        <input
          type="text"
          placeholder="SEARCH PANELS..."
          value={search}
          onChange={function(e) { setSearch(e.target.value) }}
          style={{textTransform:'uppercase'}}
          className="bg-card2 border border-border rounded-md px-3 py-1.5 text-xs text-white placeholder:text-dgray outline-none focus:border-teal w-full md:w-48"
        />
      </div>

      <div className="flex gap-1 bg-card2 rounded-lg p-1 w-fit mb-5 overflow-x-auto max-w-full">
        {filterTabs.map(function(tab) {
          var key = tab[0]
          var label = tab[1]
          return (
            <button
              key={key}
              onClick={function() { setFilter(key) }}
              className={'px-3 py-1.5 rounded-md text-xs font-medium transition ' + (
                filter === key ? 'bg-teal text-white' : 'text-slate-400 hover:text-white'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {filtered.map(function(panel) {
          var st = getPanelStatus(panel, equipmentMap)
          var prog = getProgress(panel, equipmentMap)
          var pct = prog.total > 0 ? Math.round(prog.termF / prog.total * 100) : 0
          return (
            <Link
              to={'/panels/' + panel.id}
              key={panel.id}
              className="bg-card rounded-xl p-3.5 border border-border hover:border-teal transition cursor-pointer group"
            >
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-sm font-bold group-hover:text-cyan transition">{panel.name}</span>
                <StatusBadge status={st.status} label={st.label} />
              </div>
              <div className="text-[11px] text-dgray mb-2">
                {panel.location}
              </div>

              {prog.total > 0 ? (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="flex-1 h-1.5 bg-card2 rounded overflow-hidden">
                      <div className={'h-full rounded ' + (pct >= 100 ? 'bg-green' : pct >= 50 ? 'bg-teal' : pct > 0 ? 'bg-orange' : 'bg-red')} style={{width: pct + '%'}} />
                    </div>
                    <span className="text-[10px] text-dgray">{pct}%</span>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    <StageChip done={prog.pulled === prog.total} label={'PULL ' + prog.pulled + '/' + prog.total} />
                    <StageChip done={prog.termD === prog.total} label={'DDC ' + prog.termD + '/' + prog.total} />
                    <StageChip done={prog.termF === prog.total} label={'FIELD ' + prog.termF + '/' + prog.total} />
                    <StageChip done={prog.test === prog.total} label={'TEST ' + prog.test + '/' + prog.total} />
                  </div>
                </div>
              ) : (
                <div className="text-[10px] text-dgray italic">NO IO LIST UPLOADED YET</div>
              )}
            </Link>
          )
        })}
      </div>
    </div>
  )
}

function StageChip(props) {
  return (
    <span className={'text-[9px] px-1.5 py-0.5 rounded ' + (
      props.done ? 'bg-green/10 text-green' : 'bg-card2 text-slate-400'
    )}>
      {props.label}
    </span>
  )
}
