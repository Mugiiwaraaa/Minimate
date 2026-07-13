/* --- DocumentsPage.jsx --- R2 Document archive ---
   Pure archive of every imported file for the project: drawings + the
   document register (IO lists, DDC schedules, other originals). Design-stage
   workflow (estimate import, IO summary, cable takeoff, BOQ/BOM, the diff
   view, the grouping canvas) lives in DesignPage.jsx instead — this page is
   deliberately just "go back and find a file," not an authoring surface. */

import { useState } from 'react'
import { DOC_TYPE_LABELS } from '../lib/docStore'
import DocGrid from '../components/DocGrid'
import IoListPage from './IoListPage'

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase() }

export default function DocumentsPage(props) {
  // props: panels, equipmentMap, onUpdateEquipment, documents, onUpdateDoc,
  //        onDeleteDoc, drawingsElement
  var viewState = useState('drawings'); var view = viewState[0]; var setView = viewState[1]
  var openDocState = useState(null); var openDoc = openDocState[0]; var setOpenDoc = openDocState[1]

  var thc = 'text-[9px] text-dgray text-left px-2 py-1.5 uppercase'
  var tdc = 'text-[11px] px-2 py-1.5 uppercase'
  var inCls = 'bg-transparent border border-transparent rounded px-1 py-0.5 uppercase outline-none focus:border-teal focus:bg-navy'

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-3">
        <h1 className="text-lg md:text-xl font-bold uppercase">DOCUMENTS <span className="text-dgray font-normal text-xs ml-2">DRAWINGS + LIBRARY ARCHIVE</span></h1>
        <div className="text-[10px] text-dgray uppercase">USE THE <span className="text-orange font-bold">IMPORT</span> BUTTON (SIDEBAR) TO ADD FILES</div>
      </div>

      <div className="flex gap-1.5 mb-4 border-b border-border pb-2">
        {['drawings', 'library'].map(function(v) {
          var labels = { drawings: 'DRAWINGS', library: 'DOCUMENT LIBRARY' }
          return <button key={v} onClick={function() { setView(v) }} className={'px-3 py-1.5 rounded text-[10px] font-bold uppercase transition ' + (view === v ? 'bg-teal/20 text-teal' : 'bg-card2 text-dgray hover:text-white')}>{labels[v]}</button>
        })}
      </div>

      {view === 'drawings' && (props.drawingsElement || <div className="text-[11px] text-dgray uppercase">DRAWINGS SECTION.</div>)}

      {view === 'library' && openDoc && (
        <div className="bg-card rounded-xl border border-border p-4 mb-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="text-[11px] uppercase"><span className="text-dgray">OPEN: </span><span className="font-bold text-cyan">{openDoc.register_no || openDoc.file_name}</span><span className="text-dgray"> · {openDoc.title}</span></div>
            <button onClick={function() { setOpenDoc(null) }} className="px-3 py-1.5 bg-card2 text-dgray text-[10px] font-semibold rounded uppercase hover:text-white">← BACK TO LIBRARY</button>
          </div>
          {(openDoc.doc_type === 'IO_LIST' || openDoc.doc_type === 'DDC_PANEL_SCHEDULE') ? (
            <IoListPage panels={props.panels} equipmentMap={props.equipmentMap} onUpdateEquipment={props.onUpdateEquipment} />
          ) : (
            <DocGrid table={(openDoc.extracted && openDoc.extracted.table) || { columns: [], rows: [] }} onChange={function(t) {
              var nd = Object.assign({}, openDoc, { extracted: Object.assign({}, openDoc.extracted || {}, { table: t }) })
              setOpenDoc(nd)
              if (props.onUpdateDoc) props.onUpdateDoc(nd)
            }} />
          )}
        </div>
      )}

      {view === 'library' && !openDoc && (
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="text-[10px] text-dgray uppercase font-semibold mb-2">DOCUMENT REGISTER — EVERY IMPORTED ORIGINAL</div>
          {(props.documents || []).length === 0 ? (
            <div className="text-[11px] text-dgray uppercase leading-relaxed">NO DOCUMENTS YET. IMPORTS REGISTER HERE ONCE THE documents TABLE + STORAGE BUCKET SQL (IN docStore.js) IS RUN IN SUPABASE. EXISTING DRAWINGS ARE UNDER THE DRAWINGS TAB — UNCHANGED.</div>
          ) : (
            <div>
            <div className="text-[9px] text-dgray uppercase mb-1 no-print">CLICK A DOCUMENT NAME TO OPEN · OTHER FIELDS EDIT INLINE</div>
            <div className="overflow-x-auto"><table className="w-full"><thead><tr className="border-b border-border">
              <th className={thc}>REGISTER NO</th><th className={thc}>TYPE</th><th className={thc}>TITLE</th><th className={thc}>FLOOR</th><th className={thc + ' text-center'}>REV</th><th className={thc}>STATUS</th><th className={thc}>REMARKS</th><th className={thc}>DATE</th><th className={thc + ' no-print'}></th>
            </tr></thead><tbody>
              {props.documents.map(function(d, i) {
                function upd(patch) { if (props.onUpdateDoc) props.onUpdateDoc(Object.assign({}, d, patch)) }
                return (<tr key={d.id || i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
                  <td className={tdc}><input value={d.register_no || ''} onChange={function(e) { upd({ register_no: up(e.target.value) }) }} className={inCls + ' w-32 text-[11px] font-bold text-cyan'} /></td>
                  <td className={tdc}>
                    <select value={d.doc_type || 'OTHER'} onChange={function(e) { upd({ doc_type: e.target.value }) }} className="bg-navy border border-border rounded px-1 py-0.5 text-[10px] text-purple uppercase outline-none cursor-pointer">
                      {Object.keys(DOC_TYPE_LABELS).map(function(k) { return <option key={k} value={k}>{DOC_TYPE_LABELS[k]}</option> })}
                    </select>
                  </td>
                  <td className={tdc}><button onClick={function() { setOpenDoc(d) }} className="text-left text-[11px] text-white hover:text-teal underline decoration-dotted underline-offset-2 min-w-[180px]" title="OPEN DOCUMENT">{d.title || d.file_name || 'UNTITLED'}</button></td>
                  <td className={tdc}><input value={d.floor || ''} onChange={function(e) { upd({ floor: up(e.target.value) }) }} placeholder="-" className={inCls + ' w-16 text-[11px] text-orange'} /></td>
                  <td className={tdc + ' text-center'}><input value={d.revision || ''} onChange={function(e) { upd({ revision: up(e.target.value) }) }} className={inCls + ' w-10 text-center text-[11px]'} /></td>
                  <td className={tdc + ' text-[10px] ' + (d.status === 'PROCESSED' ? 'text-green' : 'text-orange')}>{d.status}</td>
                  <td className={tdc}><input value={d.remarks || ''} onChange={function(e) { upd({ remarks: up(e.target.value) }) }} placeholder="" className={inCls + ' w-full min-w-[120px] text-[10px] text-orange italic'} /></td>
                  <td className={tdc + ' text-dgray text-[10px] whitespace-nowrap'}>{(d.created_at || '').substring(0, 10)}</td>
                  <td className={tdc + ' no-print whitespace-nowrap'}><button onClick={function() { if (props.onDeleteDoc && window.confirm('DELETE ' + (d.register_no || d.file_name) + ' FROM THE REGISTER?')) props.onDeleteDoc(d.id) }} className="text-dgray hover:text-red px-0.5">✕</button></td>
                </tr>)
              })}
            </tbody></table></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
