/* --- BlockersPage.jsx --- Blockers board ---
   Cable-issue marks from Trace Studio land here automatically
   (loop, between-devices, floor, drawing). Manual blockers can be
   added too. Resolve / reopen / delete. */

import { useState } from 'react'

function up(v) { return (v || '').toUpperCase() }

export default function BlockersPage(props) {
  // props: blockers, onUpdate(list)
  var blockers = props.blockers || []
  var showAddState = useState(false)
  var showAdd = showAddState[0]
  var setShowAdd = showAddState[1]
  var draftState = useState({ text: '', loop: '', floor: '' })
  var draft = draftState[0]
  var setDraft = draftState[1]

  var open = blockers.filter(function(b) { return b.status !== 'resolved' })
  var resolved = blockers.filter(function(b) { return b.status === 'resolved' })

  function setStatus(id, status) {
    props.onUpdate(blockers.map(function(b) {
      if (b.id !== id) return b
      return Object.assign({}, b, { status: status, resolvedAt: status === 'resolved' ? new Date().toISOString() : null })
    }))
  }

  function remove(id) {
    props.onUpdate(blockers.filter(function(b) { return b.id !== id }))
  }

  function updateText(id, text) {
    props.onUpdate(blockers.map(function(b) {
      return b.id === id ? Object.assign({}, b, { text: up(text) }) : b
    }))
  }

  function addManual() {
    if (!draft.text.trim()) return
    props.onUpdate(blockers.concat([{
      id: 'blk-' + Date.now() + '-' + Math.floor(Math.random() * 100000),
      text: up(draft.text).trim(),
      loop: up(draft.loop).trim(),
      from: '',
      to: '',
      floor: up(draft.floor).trim(),
      drawingId: '',
      source: 'MANUAL',
      status: 'open',
      createdAt: new Date().toISOString()
    }]))
    setDraft({ text: '', loop: '', floor: '' })
    setShowAdd(false)
  }

  function card(b) {
    var isResolved = b.status === 'resolved'
    return (
      <div key={b.id} className={'bg-card rounded-xl border p-4 transition ' + (isResolved ? 'border-border opacity-60' : 'border-red/40')}>
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={'text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ' + (isResolved ? 'bg-green/20 text-green' : 'bg-red/20 text-red')}>{isResolved ? 'RESOLVED' : 'OPEN'}</span>
            {b.loop && <span className="text-[9px] bg-teal/20 text-teal px-1.5 py-0.5 rounded uppercase font-semibold">{b.loop}</span>}
            {b.from && b.to && <span className="text-[9px] text-cyan uppercase">{b.from} → {b.to}</span>}
            {b.floor && <span className="text-[9px] text-orange uppercase">{b.floor}</span>}
            <span className="text-[9px] bg-card2 text-dgray px-1.5 py-0.5 rounded uppercase">{b.source === 'TRACE' ? '📐 FROM DRAWING' : 'MANUAL'}</span>
          </div>
          <button onClick={function() { remove(b.id) }} className="text-dgray hover:text-red text-xs shrink-0">✕</button>
        </div>
        <input value={b.text} onChange={function(e) { updateText(b.id, e.target.value) }}
          className="w-full bg-transparent border-b border-transparent focus:border-teal text-sm text-white uppercase outline-none mb-3" />
        <div className="flex items-center justify-between">
          <span className="text-[9px] text-dgray uppercase">RAISED {(b.createdAt || '').substring(0, 10)}{b.resolvedAt ? ' · RESOLVED ' + b.resolvedAt.substring(0, 10) : ''}</span>
          {isResolved ? (
            <button onClick={function() { setStatus(b.id, 'open') }} className="px-3 py-1 bg-card2 text-dgray text-[10px] font-bold rounded uppercase hover:text-white transition">REOPEN</button>
          ) : (
            <button onClick={function() { setStatus(b.id, 'resolved') }} className="px-3 py-1 bg-green/20 text-green text-[10px] font-bold rounded uppercase hover:bg-green/30 transition">MARK RESOLVED</button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-extrabold uppercase">BLOCKERS</h1>
          <div className="text-[10px] text-dgray uppercase">CABLE ISSUES MARKED ON DRAWINGS LAND HERE AUTOMATICALLY</div>
        </div>
        <button onClick={function() { setShowAdd(!showAdd) }} className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 uppercase">+ ADD BLOCKER</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <div className="bg-card rounded-xl p-4 border border-border"><div className="text-[11px] text-dgray uppercase">OPEN</div><div className="text-2xl font-extrabold text-red">{open.length}</div></div>
        <div className="bg-card rounded-xl p-4 border border-border"><div className="text-[11px] text-dgray uppercase">RESOLVED</div><div className="text-2xl font-extrabold text-green">{resolved.length}</div></div>
        <div className="bg-card rounded-xl p-4 border border-border hidden md:block"><div className="text-[11px] text-dgray uppercase">TOTAL</div><div className="text-2xl font-extrabold text-cyan">{blockers.length}</div></div>
      </div>

      {showAdd && (
        <div className="bg-card rounded-xl border border-teal p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
            <input value={draft.text} onChange={function(e) { setDraft(Object.assign({}, draft, { text: up(e.target.value) })) }} placeholder="WHAT IS BLOCKED?" className="md:col-span-2 bg-navy border border-border rounded px-2 py-1.5 text-xs text-white uppercase outline-none focus:border-teal" />
            <input value={draft.loop} onChange={function(e) { setDraft(Object.assign({}, draft, { loop: up(e.target.value) })) }} placeholder="LOOP (OPT)" className="bg-navy border border-border rounded px-2 py-1.5 text-xs text-white uppercase outline-none focus:border-teal" />
            <input value={draft.floor} onChange={function(e) { setDraft(Object.assign({}, draft, { floor: up(e.target.value) })) }} placeholder="FLOOR (OPT)" className="bg-navy border border-border rounded px-2 py-1.5 text-xs text-white uppercase outline-none focus:border-teal" />
          </div>
          <div className="flex gap-2">
            <button onClick={addManual} className="px-4 py-1.5 bg-teal text-white text-xs font-semibold rounded hover:bg-teal/80 uppercase">ADD</button>
            <button onClick={function() { setShowAdd(false) }} className="px-4 py-1.5 bg-card2 text-dgray text-xs rounded hover:text-white uppercase">CANCEL</button>
          </div>
        </div>
      )}

      {blockers.length === 0 && (
        <div className="text-center text-dgray mt-16">
          <div className="text-3xl mb-3">⚠</div>
          <div className="text-sm font-bold text-white uppercase mb-1">NO BLOCKERS</div>
          <div className="text-xs uppercase">USE MARK MODE IN TRACE STUDIO TO FLAG CABLE ISSUES ON THE DRAWING</div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{open.map(card)}</div>
      {resolved.length > 0 && (
        <div className="mt-6">
          <div className="text-[10px] font-semibold text-dgray uppercase tracking-widest mb-2">RESOLVED</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{resolved.map(card)}</div>
        </div>
      )}
    </div>
  )
}
