/* --- GlobalImport.jsx --- R2 universal import router ---
   ONE import button for everything. Classifies the dropped file and lets the
   engineer confirm/override the destination (core inversion: engine suggests,
   human decides), then App routes it to the right existing flow:
     DRAWING   -> Trace Studio drawing import
     DATA      -> smartParser (panels / IO / termination / schedule)
     ESTIMATE  -> Documents estimate engine (scope)
     LIBRARY   -> archive only (docStore). */

import { useState, useEffect } from 'react'
import { sheetList } from '../lib/estimateParser'

function isImg(f) { return /^image\//.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || '') }
function isPdfF(f) { return f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '') }
function isXls(f) { return /\.(xlsx|xls|csv)$/i.test(f.name || '') || /sheet|excel|csv/.test(f.type || '') }

var DESTS = [
  { key: 'drawing', label: 'DRAWING → TRACE STUDIO', hint: 'SHOP DRAWING TO PIN & TRACE' },
  { key: 'data', label: 'IO / SCHEDULE → PANELS', hint: 'IO LIST, TERMINATION, FCU/VAV SCHEDULE' },
  { key: 'estimate', label: 'DESIGN ESTIMATE → SCOPE', hint: 'MULTI-SHEET BUDGET / ESTIMATE WORKBOOK' },
  { key: 'library', label: 'LIBRARY (ARCHIVE ONLY)', hint: 'KEEP THE FILE, EXTRACT NOTHING' }
]

export default function GlobalImport(props) {
  var file = props.file
  var destState = useState(''); var dest = destState[0]; var setDest = destState[1]
  var noteState = useState('CLASSIFYING…'); var note = noteState[0]; var setNote = noteState[1]

  useEffect(function() {
    if (!file) return
    setDest(''); setNote('CLASSIFYING…')
    if (isImg(file)) { setDest('drawing'); setNote('IMAGE — LOOKS LIKE A DRAWING / SITE PHOTO'); return }
    if (isPdfF(file)) { setDest('drawing'); setNote('PDF — DEFAULTING TO DRAWING (SWITCH IF IT IS A DATA SHEET)'); return }
    if (isXls(file)) {
      setNote('READING WORKBOOK…')
      var reader = new FileReader()
      reader.onload = function() {
        try {
          if (!window.XLSX) { setDest('data'); setNote('SPREADSHEET — ROUTE TO PANELS'); return }
          var wb = window.XLSX.read(new Uint8Array(reader.result), { type: 'array' })
          var list = sheetList(wb)
          var est = list.filter(function(s) { return s.kind === 'io_summary' || s.kind === 'ddc' || s.kind === 'analysis' || s.kind === 'boq' }).length
          if (est >= 2) { setDest('estimate'); setNote('DESIGN ESTIMATE DETECTED — ' + list.length + ' SHEETS, ' + est + ' ESTIMATE SHEETS') }
          else { setDest('data'); setNote('SCHEDULE / IO SHEET — ROUTE TO PANELS') }
        } catch (e) { setDest('data'); setNote('SPREADSHEET — ROUTE TO PANELS') }
      }
      reader.onerror = function() { setDest('data'); setNote('SPREADSHEET — ROUTE TO PANELS') }
      reader.readAsArrayBuffer(file)
      return
    }
    setDest('library'); setNote('UNRECOGNISED TYPE — ARCHIVE TO LIBRARY')
  }, [file])

  if (!file) return null
  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4 no-print" onClick={props.onClose}>
      <div className="bg-card border border-border rounded-xl p-5 w-full max-w-md" onClick={function(e) { e.stopPropagation() }}>
        <div className="text-sm font-bold uppercase mb-1">IMPORT</div>
        <div className="text-[11px] text-cyan uppercase font-semibold mb-1 truncate">{(file.name || '').toUpperCase()}</div>
        <div className="text-[10px] text-teal uppercase mb-3">{note}</div>
        <div className="text-[9px] text-dgray uppercase font-semibold mb-1.5">ROUTE TO — CONFIRM OR CHANGE</div>
        <div className="flex flex-col gap-1.5 mb-4">
          {DESTS.map(function(d) {
            return (
              <button key={d.key} onClick={function() { setDest(d.key) }} className={'text-left px-3 py-2 rounded border transition ' + (dest === d.key ? 'bg-teal/15 border-teal text-teal' : 'bg-card2 border-border text-dgray hover:text-white')}>
                <div className="text-[11px] font-bold uppercase">{d.label}</div>
                <div className="text-[9px] opacity-70 uppercase">{d.hint}</div>
              </button>
            )
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={props.onClose} className="px-3 py-1.5 bg-card2 text-dgray text-[10px] font-semibold rounded uppercase hover:text-white">CANCEL</button>
          <button onClick={function() { if (dest) props.onRoute(file, dest) }} className="px-4 py-1.5 bg-teal text-white text-[11px] font-bold rounded uppercase hover:bg-teal/80">IMPORT →</button>
        </div>
      </div>
    </div>
  )
}
