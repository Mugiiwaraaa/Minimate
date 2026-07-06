/* --- IoListPage.jsx --- structured, Excel-like editable IO list ---
   Mirrors the site IO-list sheet: pick a DDC → its equipment grouped, each
   with its points aligned under the IO-type columns (DI/DO/AI/AO/SI) and the
   commissioning check columns. FULLY EDITABLE on live panel/point data: edit
   point text, set IO type + qty (type a number in a column), tick stages,
   add/delete points & equipment. Bordered cells for a clean tabular feel. */

import { useState } from 'react'

var IO_TYPES = [{ k: 'DI', label: 'DI' }, { k: 'DO', label: 'DO' }, { k: 'AI', label: 'AI' }, { k: 'AO', label: 'AO' }, { k: 'INT', label: 'SI' }]
var STAGES = [
  { k: 'cable_pulled', label: 'CABLE' },
  { k: 'cable_continuity', label: 'CONT' },
  { k: 'term_ddc_side', label: 'TERM DDC' },
  { k: 'term_field_side', label: 'TERM FLD' },
  { k: 'functional_test', label: 'FUNC' }
]
function up(v) { return ('' + (v == null ? '' : v)).toUpperCase() }
var idc = 0
function nid(p) { idc++; return p + '-' + Date.now() + '-' + idc }

export default function IoListPage(props) {
  var panels = props.panels || []
  var equipmentMap = props.equipmentMap || {}
  var onUpdateEquipment = props.onUpdateEquipment
  var selState = useState(panels.length ? panels[0].id : null)
  var sel = selState[0]; var setSel = selState[1]

  var panel = null
  for (var i = 0; i < panels.length; i++) { if (panels[i].id === sel) { panel = panels[i]; break } }
  if (!panel) panel = panels[0]
  var eqs = panel ? (equipmentMap[panel.id] || []) : []

  function commit(newEqs) { if (onUpdateEquipment && panel) onUpdateEquipment(panel.id, newEqs) }
  function updEq(eqId, patch) { commit(eqs.map(function(eq) { return eq.id === eqId ? Object.assign({}, eq, patch) : eq })) }
  function updPt(eqId, ptId, patch) {
    commit(eqs.map(function(eq) { if (eq.id !== eqId) return eq; return Object.assign({}, eq, { points: eq.points.map(function(p) { return p.id === ptId ? Object.assign({}, p, patch) : p }) }) }))
  }
  function addPt(eqId) { commit(eqs.map(function(eq) { if (eq.id !== eqId) return eq; return Object.assign({}, eq, { points: (eq.points || []).concat([{ id: nid('pt'), description: 'NEW POINT', type: 'AI', qty: 1 }]) }) })) }
  function delPt(eqId, ptId) { commit(eqs.map(function(eq) { if (eq.id !== eqId) return eq; return Object.assign({}, eq, { points: (eq.points || []).filter(function(p) { return p.id !== ptId }) }) })) }
  function addEq() { commit(eqs.concat([{ id: nid('eq'), name: 'NEW EQUIPMENT', equipment_ids: '', points: [] }])) }
  function delEq(eqId) { commit(eqs.filter(function(eq) { return eq.id !== eqId })) }

  var bc = 'border border-border/50 px-2 py-1'
  var inCls = 'bg-transparent outline-none focus:bg-navy uppercase'
  var totalCols = 2 + IO_TYPES.length + STAGES.length + 1

  function stageBtn(eqId, pt, k) {
    var on = !!pt[k]
    return <button onClick={function() { updPt(eqId, pt.id, mk(k, !on)) }} className={'w-5 h-5 rounded border text-[10px] font-bold ' + (on ? 'bg-green border-green text-white' : 'border-border text-dgray hover:border-teal')}>{on ? '✓' : ''}</button>
  }
  function mk(k, v) { var o = {}; o[k] = v; return o }

  return (
    <div>
      {panels.length === 0 ? (
        <div className="text-[11px] text-dgray uppercase">NO DDC PANELS YET — IMPORT AN IO LIST / DDC SCHEDULE FIRST.</div>
      ) : (
        <div>
          {/* DDC selector */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {panels.map(function(p) {
              return <button key={p.id} onClick={function() { setSel(p.id) }} className={'px-2.5 py-1.5 rounded text-[10px] font-bold uppercase ' + (panel && p.id === panel.id ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>{p.name}{p.floor ? ' · ' + p.floor : ''}</button>
            })}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                {/* DDC name banner */}
                <tr>
                  <th colSpan={totalCols} className={bc + ' bg-teal/15 text-left'}>
                    <span className="text-sm font-black text-cyan uppercase">{panel && panel.name}</span>
                    {panel && panel.location ? <span className="text-dgray text-[10px] ml-2">({up(panel.location)})</span> : null}
                  </th>
                </tr>
                {/* column headers */}
                <tr className="bg-card2/60">
                  <th className={bc + ' text-left text-[9px] text-dgray'}>EQUIPMENT / POINT</th>
                  <th className={bc + ' text-[9px] text-dgray'}>QTY</th>
                  {IO_TYPES.map(function(t) { return <th key={t.k} className={bc + ' text-[9px] text-dgray text-center'}>{t.label}</th> })}
                  {STAGES.map(function(s) { return <th key={s.k} className={bc + ' text-[9px] text-dgray text-center'}>{s.label}</th> })}
                  <th className={bc + ' no-print'}></th>
                </tr>
              </thead>
              <tbody>
                {eqs.map(function(eq) {
                  var rows = []
                  rows.push(
                    <tr key={eq.id} className="bg-green/10">
                      <td colSpan={totalCols} className={bc}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <input value={eq.name || ''} onChange={function(e) { updEq(eq.id, { name: up(e.target.value) }) }} className={inCls + ' font-bold text-green text-[12px] min-w-[160px]'} />
                          <input value={eq.equipment_ids || ''} onChange={function(e) { updEq(eq.id, { equipment_ids: up(e.target.value) }) }} placeholder="TAGS (E.G. CAHU-4,5,6)" className={inCls + ' text-dgray text-[10px] min-w-[140px]'} />
                          <button onClick={function() { addPt(eq.id) }} className="text-teal hover:text-white text-[9px] font-bold no-print">+ POINT</button>
                          <button onClick={function() { if (window.confirm('DELETE EQUIPMENT ' + eq.name + '?')) delEq(eq.id) }} className="text-dgray hover:text-red text-[9px] no-print ml-auto">✕ EQUIP</button>
                        </div>
                      </td>
                    </tr>
                  )
                  ;(eq.points || []).filter(function(p) { return !p.excluded }).forEach(function(pt) {
                    rows.push(
                      <tr key={pt.id}>
                        <td className={bc}><input value={pt.description || ''} onChange={function(e) { updPt(eq.id, pt.id, { description: up(e.target.value) }) }} className={inCls + ' w-full text-white'} /></td>
                        <td className={bc + ' text-center text-dgray'}>{pt.qty || ''}</td>
                        {IO_TYPES.map(function(t) {
                          var val = pt.type === t.k ? (pt.qty || '') : ''
                          return <td key={t.k} className={bc + ' text-center'}><input value={val} onChange={function(e) { var v = e.target.value.replace(/[^0-9]/g, ''); if (v === '') { updPt(eq.id, pt.id, { qty: 0 }) } else { updPt(eq.id, pt.id, { type: t.k, qty: parseInt(v, 10) }) } }} className={inCls + ' w-8 text-center text-teal'} /></td>
                        })}
                        {STAGES.map(function(s) { return <td key={s.k} className={bc + ' text-center'}>{stageBtn(eq.id, pt, s.k)}</td> })}
                        <td className={bc + ' text-center no-print'}><button onClick={function() { delPt(eq.id, pt.id) }} title="DELETE POINT" className="text-dgray hover:text-red text-[10px]">✕</button></td>
                      </tr>
                    )
                  })
                  return rows
                })}
                <tr>
                  <td colSpan={totalCols} className={bc + ' no-print'}><button onClick={addEq} className="text-teal hover:text-white text-[10px] font-bold">+ ADD EQUIPMENT</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
