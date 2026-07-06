/* --- IoListPage.jsx --- R2 DDC-grouped editable IO list ---
   Pick a DDC panel → its IO list table shows: equipment → points with the 5
   commissioning stages as toggleable check marks. Reuses the live panels /
   equipmentMap data and the same onUpdatePoint handler as PanelDetail, so it's
   the SAME data the reports and termination read. */

import { useState } from 'react'

var STAGES = [
  { k: 'cable_pulled', label: 'CABLE' },
  { k: 'cable_continuity', label: 'CONT' },
  { k: 'term_ddc_side', label: 'TERM DDC' },
  { k: 'term_field_side', label: 'TERM FLD' },
  { k: 'functional_test', label: 'FUNC' }
]
function up(v) { return ('' + (v == null ? '' : v)).toUpperCase() }

export default function IoListPage(props) {
  var panels = props.panels || []
  var equipmentMap = props.equipmentMap || {}
  var onUpdatePoint = props.onUpdatePoint
  var selState = useState(panels.length ? panels[0].id : null)
  var sel = selState[0]; var setSel = selState[1]

  var panel = null
  for (var i = 0; i < panels.length; i++) { if (panels[i].id === sel) { panel = panels[i]; break } }
  if (!panel) panel = panels[0]

  function toggle(eqId, pt, k) {
    if (!onUpdatePoint || !panel) return
    var patch = {}; patch[k] = !pt[k]
    onUpdatePoint(panel.id, eqId, pt.id, patch)
  }

  var thc = 'text-[9px] text-dgray text-left px-2 py-1.5 uppercase'
  var tdc = 'text-[11px] px-2 py-1.5 uppercase'

  function stageBtn(eqId, pt, k) {
    var on = !!pt[k]
    return (
      <button onClick={function() { toggle(eqId, pt, k) }} className={'w-5 h-5 rounded border text-[10px] font-bold transition ' + (on ? 'bg-green border-green text-white' : 'border-border text-dgray hover:border-teal')}>{on ? '✓' : ''}</button>
    )
  }

  var eqs = panel ? (equipmentMap[panel.id] || []) : []
  var totalPts = 0
  eqs.forEach(function(eq) { (eq.points || []).forEach(function(pt) { if (!pt.excluded) totalPts++ }) })

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-3">
        <h1 className="text-lg md:text-xl font-bold uppercase">IO LIST <span className="text-dgray font-normal text-xs ml-2">DDC-GROUPED · LIVE</span></h1>
        {panel && <div className="text-[11px] text-dgray uppercase">{totalPts} IO POINTS · {eqs.length} EQUIPMENT</div>}
      </div>

      {panels.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-4 text-[11px] text-dgray uppercase">NO DDC PANELS YET. CREATE PANELS (OR IMPORT AN IO LIST / DDC SCHEDULE) FIRST — THEY SHOW UP HERE GROUPED BY DDC.</div>
      ) : (
        <div>
          {/* DDC selector */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {panels.map(function(p) {
              return <button key={p.id} onClick={function() { setSel(p.id) }} className={'px-2.5 py-1.5 rounded text-[10px] font-bold uppercase transition ' + (panel && p.id === panel.id ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>{p.name}{p.floor ? ' · ' + p.floor : ''}</button>
            })}
          </div>

          {/* IO table for the selected DDC */}
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-[10px] text-dgray uppercase font-semibold mb-2">{panel && panel.name} — IO LIST · TAP A STAGE TO TICK IT</div>
            {eqs.length === 0 ? (
              <div className="text-[11px] text-dgray uppercase">NO IO POINTS ON THIS DDC YET.</div>
            ) : (
              <div className="overflow-x-auto"><table className="w-full"><thead><tr className="border-b border-border">
                <th className={thc}>EQUIPMENT</th><th className={thc}>POINT</th><th className={thc}>TYPE</th><th className={thc + ' text-center'}>ADDR</th>
                {STAGES.map(function(s) { return <th key={s.k} className={thc + ' text-center'}>{s.label}</th> })}
              </tr></thead><tbody>
                {eqs.map(function(eq) {
                  var pts = (eq.points || []).filter(function(pt) { return !pt.excluded })
                  return pts.map(function(pt, pi) {
                    return (<tr key={pt.id} className={'border-b border-border/30' + (pi % 2 ? ' bg-card2/20' : '')}>
                      <td className={tdc + ' font-bold text-cyan'}>{pi === 0 ? eq.name : ''}</td>
                      <td className={tdc}>{pt.description}</td>
                      <td className={tdc + ' text-dgray text-[10px]'}>{pt.type || '-'}</td>
                      <td className={tdc + ' text-center text-cyan'}>{pt.address || '-'}</td>
                      {STAGES.map(function(s) { return <td key={s.k} className={tdc + ' text-center'}>{stageBtn(eq.id, pt, s.k)}</td> })}
                    </tr>)
                  })
                })}
              </tbody></table></div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
