/* --- DrawingsPage.jsx --- Traced drawings library ---
   Every traced drawing is saved (pins + traces + zones) grouped by
   Floor / Block / Zone. Reopen to modify unlimited times — the file
   comes from this device's cache (IndexedDB); if it is not on this
   device, the user re-selects the original file. */

import { useState } from 'react'
import { getFile, hashFile } from '../lib/fileStore'

function up(v) { return (v || '').toUpperCase().trim() }

export default function DrawingsPage(props) {
  // props: drawings, onOpen(record, file), onUpdateMeta(id, fields), onDelete(id)
  var drawings = props.drawings || []
  var locateState = useState(null) // record id awaiting manual file selection
  var locateId = locateState[0]
  var setLocateId = locateState[1]
  var msgState = useState('')
  var msg = msgState[0]
  var setMsg = msgState[1]

  function handleOpen(record) {
    setMsg('')
    getFile(record.fileHash).then(function(file) {
      if (file) {
        props.onOpen(record, file)
      } else {
        setLocateId(record.id)
        setMsg('THE ORIGINAL FILE IS NOT CACHED ON THIS DEVICE — SELECT IT TO REOPEN "' + record.name + '"')
      }
    })
  }

  function handleLocate(record, e) {
    var file = e.target.files[0]
    e.target.value = ''
    if (!file) return
    hashFile(file).then(function(hash) {
      if (record.fileHash && hash !== record.fileHash) {
        setMsg('WARNING: THIS FILE DIFFERS FROM THE ORIGINAL — PINS MAY NOT LINE UP. OPENING ANYWAY.')
      } else {
        setMsg('')
      }
      setLocateId(null)
      props.onOpen(record, file)
    })
  }

  // Group by FLOOR / BLOCK / ZONE label
  var groups = {}
  var order = []
  drawings.forEach(function(d) {
    var key = up([d.floor, d.block, d.zone].filter(function(x) { return x }).join(' · ')) || 'UNSORTED'
    if (!groups[key]) { groups[key] = []; order.push(key) }
    groups[key].push(d)
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-extrabold uppercase">TRACED DRAWINGS</h1>
          <div className="text-[10px] text-dgray uppercase">PINS, LOOPS AND ZONES ARE SAVED WITH THE PROJECT — FILES STAY CACHED ON EACH DEVICE</div>
        </div>
        <div className="text-[10px] text-dgray uppercase">{drawings.length} DRAWING{drawings.length === 1 ? '' : 'S'}</div>
      </div>

      {msg && (
        <div className="bg-orange/10 border border-orange/30 rounded-lg p-3 mb-4 text-[10px] text-orange uppercase">{msg}</div>
      )}

      {drawings.length === 0 && (
        <div className="text-center text-dgray mt-16">
          <div className="text-3xl mb-3">📐</div>
          <div className="text-sm font-bold text-white uppercase mb-1">NO TRACED DRAWINGS YET</div>
          <div className="text-xs uppercase">USE IMPORT DRAWINGS → TRACE TO MARK LOOPS ON A DRAWING</div>
        </div>
      )}

      {order.map(function(key) {
        return (
          <div key={key} className="mb-6">
            <div className="text-[10px] font-semibold text-dgray uppercase tracking-widest mb-2">{key}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {groups[key].map(function(d) {
                var loopCount = (d.traces || []).filter(function(t) { return (t.deviceIds || []).length > 0 }).length
                var devCount = (d.traces || []).reduce(function(s, t) { return s + (t.deviceIds || []).length }, 0)
                return (
                  <div key={d.id} className="bg-card rounded-xl border border-border p-4 hover:border-teal/50 transition">
                    <div className="flex items-start justify-between mb-2">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-white uppercase truncate">{d.name}</div>
                        <div className="text-[9px] text-dgray uppercase truncate">{d.fileName}</div>
                      </div>
                      <span className="text-lg shrink-0 ml-2">{d.fileKind === 'image' ? '📸' : '📐'}</span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="bg-card2 rounded-lg p-2 text-center">
                        <div className="text-base font-extrabold text-teal">{loopCount}</div>
                        <div className="text-[8px] text-dgray uppercase">LOOPS</div>
                      </div>
                      <div className="bg-card2 rounded-lg p-2 text-center">
                        <div className="text-base font-extrabold text-cyan">{devCount}</div>
                        <div className="text-[8px] text-dgray uppercase">DEVICES</div>
                      </div>
                      <div className="bg-card2 rounded-lg p-2 text-center">
                        <div className="text-base font-extrabold text-purple">{(d.zones || []).length}</div>
                        <div className="text-[8px] text-dgray uppercase">ZONES</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 mb-3">
                      <input value={d.floor || ''} onChange={function(e) { props.onUpdateMeta(d.id, { floor: up(e.target.value) }) }} placeholder="FLOOR" className="bg-navy border border-border rounded px-2 py-1 text-[9px] text-white uppercase outline-none focus:border-teal" />
                      <input value={d.block || ''} onChange={function(e) { props.onUpdateMeta(d.id, { block: up(e.target.value) }) }} placeholder="BLOCK" className="bg-navy border border-border rounded px-2 py-1 text-[9px] text-white uppercase outline-none focus:border-teal" />
                      <input value={d.zone || ''} onChange={function(e) { props.onUpdateMeta(d.id, { zone: up(e.target.value) }) }} placeholder="ZONE" className="bg-navy border border-border rounded px-2 py-1 text-[9px] text-white uppercase outline-none focus:border-teal" />
                    </div>

                    <div className="flex items-center gap-2">
                      <button onClick={function() { handleOpen(d) }} className="flex-1 px-3 py-1.5 bg-teal text-white text-[10px] font-bold rounded-md uppercase hover:bg-teal/80 transition">OPEN & EDIT</button>
                      {locateId === d.id && (
                        <label className="px-3 py-1.5 bg-orange/20 text-orange text-[10px] font-bold rounded-md uppercase cursor-pointer hover:bg-orange/30 transition">
                          SELECT FILE
                          <input type="file" accept=".pdf,image/*" onChange={function(e) { handleLocate(d, e) }} className="hidden" />
                        </label>
                      )}
                      <button onClick={function() { props.onDelete(d.id) }} className="px-2 py-1.5 text-dgray hover:text-red text-[10px] uppercase transition">DELETE</button>
                    </div>
                    <div className="text-[8px] text-dgray uppercase mt-2">UPDATED {(d.updatedAt || d.createdAt || '').substring(0, 10)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
