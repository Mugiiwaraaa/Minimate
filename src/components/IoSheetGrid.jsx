/* --- IoSheetGrid.jsx --- Shared IO list grid for IoListPage + PanelDetail ---
   v2 (2026-07-16, Fable): rewritten from whole-array cell-DIFFING (which
   mangled deletes/inserts/fills into bogus single-cell writes) to SheetGrid's
   structured OPS stream. Group headers are PROTECTED rows — fill/paste/clear
   flow around them; deleting a header row deletes its whole equipment.

   Op mapping (deterministic, via rowMap):
     cells        → per-edit patch on eq.name / pt fields / stages / IO type
     insertRow    → new point in the owning equipment (under header = first)
     deleteRows   → headers → delete equipment · points → delete points
     Ctrl+Z       → bubbles to app-level undo via onUndo */

import { useState } from 'react'
import SheetGrid from './SheetGrid'

const IO_COLUMNS = [
  { id: '_name', title: 'EQUIPMENT / POINT', width: 220, type: 'text' },
  { id: '_qty', title: 'EQ-QTY', width: 54, type: 'number' },
  { id: '_di', title: 'DI', width: 48, type: 'text' },
  { id: '_do', title: 'DO', width: 48, type: 'text' },
  { id: '_ai', title: 'AI', width: 48, type: 'text' },
  { id: '_ao', title: 'AO', width: 48, type: 'text' },
  { id: '_si', title: 'SI', width: 48, type: 'text' },
  { id: '_cable', title: 'CABLE', width: 72, type: 'checkbox' },
  { id: '_cont', title: 'CONT', width: 72, type: 'checkbox' },
  { id: '_termddc', title: 'TERM DDC', width: 72, type: 'checkbox' },
  { id: '_termfld', title: 'TERM FLD', width: 72, type: 'checkbox' },
  { id: '_func', title: 'FUNC', width: 72, type: 'checkbox' },
]

const STAGES = ['cable_pulled', 'cable_continuity', 'term_ddc_side', 'term_field_side', 'functional_test']
const STAGE_COLS = ['_cable', '_cont', '_termddc', '_termfld', '_func']
const TYPE_MAP = { _di: 'DI', _do: 'DO', _ai: 'AI', _ao: 'AO', _si: 'INT' }

const up = (v) => ('' + (v == null ? '' : v)).toUpperCase()
let idc = 0
const nid = (p) => { idc++; return `${p}-${Date.now()}-${idc}` }

// equipment[] → { rows, groups, map } — map[i] tells what each grid row IS:
// { ei } for an equipment header · { ei, pi } for a point (pi = REAL index
// in eq.points, so excluded points don't shift the mapping)
function toRows(eqs, extraCols) {
  const rows = []
  const groups = []
  const map = []
  eqs.forEach((eq, ei) => {
    const start = rows.length
    const activePts = (eq.points || []).filter((p) => !p.excluded)
    const eqRow = {
      _name: eq.name || '',
      _qty: eq.group_qty || activePts.length || null,
      _di: null, _do: null, _ai: null, _ao: null, _si: null,
      _cable: false, _cont: false, _termddc: false, _termfld: false, _func: false,
    }
    // Merge custom column values for this equipment
    if (eq._custom) Object.assign(eqRow, eq._custom)
    rows.push(eqRow)
    map.push({ ei, isHeader: true })
    activePts.forEach((pt, pi) => {
      const realPi = (eq.points || []).indexOf(pt)
      const ptRow = {
        _name: pt.description || '',
        _qty: null,
        _di: pt.type === 'DI' ? pt.qty : null,
        _do: pt.type === 'DO' ? pt.qty : null,
        _ai: pt.type === 'AI' ? pt.qty : null,
        _ao: pt.type === 'AO' ? pt.qty : null,
        _si: pt.type === 'INT' ? pt.qty : null,
        _cable: !!pt.cable_pulled,
        _cont: !!pt.cable_continuity,
        _termddc: !!pt.term_ddc_side,
        _termfld: !!pt.term_field_side,
        _func: !!pt.functional_test,
      }
      // Merge custom column values for this point
      if (pt._custom) Object.assign(ptRow, pt._custom)
      rows.push(ptRow)
      map.push({ ei, pi: realPi })
    })
    groups.push({ start, end: rows.length - 1 })
  })
  return { rows, groups, map }
}

const newPoint = () => ({
  id: nid('pt'), description: '', type: '', qty: 0,
  cable_pulled: false, cable_continuity: false, term_ddc_side: false,
  term_field_side: false, functional_test: false,
})

export default function IoSheetGrid({ eqs, panelId, onUpdateEquipment, onUndo, height, compact, columns: customColumns }) {
  const [cols, setCols] = useState(customColumns || IO_COLUMNS)
  const conv = toRows(eqs || [], cols)

  const cloneEqs = () => (eqs || []).map((eq) => ({ ...eq, points: (eq.points || []).map((p) => ({ ...p })) }))

  const applyOps = (op) => {
    if (!onUpdateEquipment) return
    const map = conv.map
    const clone = cloneEqs()

    if (op.type === 'cells') {
      op.edits.forEach(({ r, colId, value }) => {
        const m = map[r]
        if (!m) return
        if (m.pi === undefined) {
          if (colId === '_name') clone[m.ei].name = up(String(value))
          else if (colId === '_qty') clone[m.ei].group_qty = Number(value) || 1
          else {
            // Custom column on header row
            if (!clone[m.ei]._custom) clone[m.ei]._custom = {}
            clone[m.ei]._custom[colId] = value
          }
          return // headers carry name and equipment qty only
        }
        const pt = clone[m.ei].points[m.pi]
        if (!pt) return
        const stageIdx = STAGE_COLS.indexOf(colId)
        if (stageIdx >= 0) pt[STAGES[stageIdx]] = !!value
        else if (colId === '_name') pt.description = up(String(value))
        else if (colId === '_qty') {
          const newQty = Number(value)
          // Skip null/zero — fill copies _qty from point rows where it's null,
          // and it would scale ALL points in the equipment, clobbering type
          // edits that already ran on earlier fill targets.
          if (!newQty || newQty <= 0) return
          // Scale all point quantities proportionally
          const oldTotal = clone[m.ei].points.reduce((s, p) => s + p.qty, 0)
          const factor = oldTotal > 0 ? newQty / oldTotal : 1
          clone[m.ei].points.forEach((p) => { p.qty = Math.max(1, Math.round(p.qty * factor)) })
        }
        else if (TYPE_MAP[colId]) {
          // Only apply if value is positive — fill/paste copies ALL type columns
          // but a point can only be ONE type. Null/empty/zero means "not this type".
          const n = Number(value)
          if (n > 0) {
            pt.type = TYPE_MAP[colId]
            pt.qty = n
          }
        }
        else {
          // Custom column — store in _custom map
          if (!pt._custom) pt._custom = {}
          pt._custom[colId] = value
        }
      })
      onUpdateEquipment(panelId, clone)
      return
    }

    if (op.type === 'insertRow') {
      // If at the end of the grid or past it, add new equipment + first point
      if (op.at >= map.length) {
        clone.push({ id: nid('eq'), name: 'NEW EQUIPMENT', points: [newPoint()] })
        onUpdateEquipment(panelId, clone)
        return
      }
      const anchor = map[Math.min(Math.max(0, op.at - 1), map.length - 1)]
      if (!anchor) {
        clone.push({ id: nid('eq'), name: 'NEW EQUIPMENT', points: [newPoint()] })
      } else if (anchor.pi === undefined) {
        // inserted right under a header → first point of that equipment
        const firstReal = clone[anchor.ei].points.findIndex((p) => !p.excluded)
        clone[anchor.ei].points.splice(firstReal < 0 ? clone[anchor.ei].points.length : firstReal, 0, newPoint())
      } else {
        clone[anchor.ei].points.splice(anchor.pi + 1, 0, newPoint())
      }
      onUpdateEquipment(panelId, clone)
      return
    }

    if (op.type === 'deleteRows') {
      const delEq = new Set()
      const ptByEq = {}
      for (let r = op.r1; r <= op.r2; r++) {
        const m = map[r]
        if (!m) continue
        if (m.pi === undefined) delEq.add(m.ei)
        else (ptByEq[m.ei] = ptByEq[m.ei] || []).push(m.pi)
      }
      Object.keys(ptByEq).forEach((ei) => {
        if (delEq.has(Number(ei))) return // whole equipment goes anyway
        ptByEq[ei].sort((a, b) => b - a).forEach((pi) => clone[ei].points.splice(pi, 1))
      })
      onUpdateEquipment(panelId, clone.filter((_, ei) => !delEq.has(ei)))
      return
    }
  }

  const rowClass = (origR) => {
    const m = conv.map[origR]
    if (m && m.pi === undefined) return 'bg-green/10' // equipment header
    return origR % 2 ? 'bg-card2/20' : ''
  }

  return (
    <div>
      <SheetGrid
        columns={cols}
        rows={conv.rows}
        onRowsChange={() => {}} /* rows are derived — ops are the write path */
        onOps={applyOps}
        onUndo={onUndo}
        onColumnsChange={setCols}
        protectedRows={conv.groups.map((g) => g.start)}
        height={height || 420}
        rowHeight={28}
        rowGroup={conv.groups.length > 0 ? conv.groups : null}
        rowClass={rowClass}
      />
      <div className="flex gap-3 mt-2 items-center">
        <button
          onClick={() => onUpdateEquipment && onUpdateEquipment(panelId, (eqs || []).concat([{ id: nid('eq'), name: 'NEW EQUIPMENT', points: [newPoint()] }]))}
          className="text-teal hover:text-white text-[10px] font-bold uppercase"
        >
          + ADD EQUIPMENT
        </button>
        {!compact && (
          <span className="text-[9px] text-dgray uppercase">CTRL+ENTER = NEW POINT · CTRL+DEL = DELETE ROWS (HEADER ROW = WHOLE EQUIPMENT) · FILL/PASTE FLOW AROUND HEADERS</span>
        )}
      </div>
    </div>
  )
}
