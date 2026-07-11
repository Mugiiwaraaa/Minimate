/* --- GridSpike.jsx --- S1 verdict page: OUR SheetGrid, 5,000 rows ---
   ponytail: spike page — after Fahad approves the feel, this becomes the
   SheetGrid test bed for S2/S3 wiring.
   History: react-datasheet-grid died on React 19 internals; Glide's stable
   caps at React 18 with heavy peers. SheetGrid is in-house on
   @tanstack/react-virtual (the one lib confirmed React-19-clean). */

import { useState } from 'react'
import SheetGrid from '../components/SheetGrid'

const COLUMNS = [
  { id: 'tag', title: 'EQUIP TAG', width: 130, type: 'text' },
  { id: 'room', title: 'ROOM', width: 180, type: 'text' },
  { id: 'floor', title: 'FLOOR', width: 90, type: 'select', options: ['GF', 'FF', 'SF', 'RF'] },
  { id: 'type', title: 'TYPE', width: 150, type: 'select', options: ['FCU THERMOSTAT', 'VAV', 'PMU', 'WATER METER', 'BTU METER'] },
  { id: 'addr', title: 'ADDR', width: 70, type: 'number' },
  { id: 'qty', title: 'QTY', width: 64, type: 'number' },
  { id: 'comm', title: 'COMM CABLE', width: 105, type: 'checkbox' },
  { id: 'term', title: 'TERMINATION', width: 105, type: 'checkbox' },
  { id: 'remarks', title: 'REMARKS', width: 260, type: 'text' },
]

const makeRows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    tag: `FCU-${Math.floor(i / 100)}-${String(i % 100).padStart(2, '0')}`,
    room: `ROOM ${100 + (i % 400)}`,
    floor: ['GF', 'FF', 'SF', 'RF'][i % 4],
    type: 'FCU THERMOSTAT',
    addr: (i % 32) + 1,
    qty: 1 + (i % 3),
    comm: i % 2 === 0,
    term: i % 5 === 0,
    remarks: i % 17 === 0 ? 'CHECK CABLE ROUTE' : '',
  }))

export default function GridSpike() {
  const [rows, setRows] = useState(() => makeRows(5000))
  const [columns, setColumns] = useState(COLUMNS)
  const [rowH, setRowH] = useState(30)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-lg font-bold uppercase">
            SHEETGRID <span className="text-dgray text-xs font-normal ml-2">IN-HOUSE · 5,000 ROWS · V0.2</span>
          </h1>
          <div className="text-[10px] text-dgray uppercase">
            FILL: DRAG=COPY · CTRL+DRAG=SERIES · CTRL+ENTER ROW BELOW · CTRL+SHIFT+ENTER ABOVE · CTRL+DEL DELETE ROWS · CTRL+SHIFT+K NEW COLUMN · DRAG HEADER EDGES TO RESIZE
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[['S', 24], ['M', 30], ['L', 38]].map(([label, h]) => (
            <button key={label} onClick={() => setRowH(h)} className={'px-2 py-1.5 text-[10px] font-bold rounded uppercase ' + (rowH === h ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>{label}</button>
          ))}
          <button
            onClick={() => { setRows(makeRows(5000)); setColumns(COLUMNS) }}
            className="px-3 py-1.5 bg-card2 text-dgray hover:text-white text-[10px] font-bold rounded uppercase"
          >
            RESET DATA
          </button>
        </div>
      </div>

      <SheetGrid columns={columns} rows={rows} onRowsChange={setRows} onColumnsChange={setColumns} height={580} rowHeight={rowH} />

      <div className="text-[10px] text-dgray uppercase mt-2">
        EDITS ARE THROWAWAY — NOTHING SAVES. ACCEPTANCE LIST: MINIMATE-V2-FOUNDATION.MD §4
      </div>
    </div>
  )
}
