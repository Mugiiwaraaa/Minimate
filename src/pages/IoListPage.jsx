/* --- IoListPage.jsx --- structured, Excel-like editable IO list ---
   Mirrors the site IO-list sheet: pick a DDC → its equipment grouped, each
   with its points aligned under the IO-type columns (DI/DO/AI/AO/SI) and the
   commissioning check columns. Uses IoSheetGrid (shared with PanelDetail) which
   wraps SheetGrid with the full Excel-grade feature set. */

import { useState } from 'react'
import IoSheetGrid from '../components/IoSheetGrid'

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase() }

export default function IoListPage(props) {
  var panels = props.panels || []
  var equipmentMap = props.equipmentMap || {}
  var selState = useState(panels.length ? panels[0].id : null)
  var sel = selState[0]; var setSel = selState[1]
  var onUpdateEquipment = props.onUpdateEquipment

  var panel = null
  for (var i = 0; i < panels.length; i++) { if (panels[i].id === sel) { panel = panels[i]; break } }
  if (!panel) panel = panels[0]
  var eqs = panel ? (equipmentMap[panel.id] || []) : []

  function commit(newEqs) { if (onUpdateEquipment && panel) onUpdateEquipment(panel.id, newEqs) }

  return (
    <div>
      {panels.length === 0 ? (
        <div className="text-[11px] text-dgray uppercase">NO DDC PANELS YET — IMPORT AN IO LIST / DDC SCHEDULE FIRST.</div>
      ) : (
        <div>
          {/* DDC selector — chip bar */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {panels.map(function(p) {
              return <button key={p.id} onClick={function() { setSel(p.id) }} className={'px-2.5 py-1.5 rounded text-[10px] font-bold uppercase ' + (panel && p.id === panel.id ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>{p.name}{p.floor ? ' · ' + p.floor : ''}</button>
            })}
          </div>

          <IoSheetGrid
            eqs={eqs}
            panelId={panel && panel.id}
            onUpdateEquipment={commit}
            height={480}
          />
        </div>
      )}
    </div>
  )
}
