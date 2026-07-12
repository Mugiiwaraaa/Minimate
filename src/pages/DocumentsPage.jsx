/* --- DocumentsPage.jsx --- R2 Documents library + Estimate engine ---
   Estimate section lives inside the doc library, tied to the doc engine.
   Flow: import design-estimate file -> sheet picker (suggested pre-ticked)
   -> parse (estimateParser) -> confirm-first review -> SAVE to Estimate/Scope
   (data.estimateScope, the "as-designed" layer). Original file archived via
   docStore when Supabase is configured. Standalone cable/BOQ/containment/
   schedule files import the same way (kind-based). */

import { useState, useEffect } from 'react'
import { sheetList, parseSheet, aoaOf } from '../lib/estimateParser'
import { DOC_TYPE_LABELS } from '../lib/docStore'
import DocGrid from '../components/DocGrid'
import IoListPage from './IoListPage'
import { getWorkingCopy, updateWorkingCopy } from '../lib/datasetStore'
import { flattenIoSummaryForDataset, diffEstimateVsSite } from '../lib/estimateDiff'

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase() }

export default function DocumentsPage(props) {
  // props: project, projectName, scope, onUpdateScope
  var scope = props.scope || {}
  var wbState = useState(null); var wb = wbState[0]; var setWb = wbState[1]
  var sheetsState = useState([]); var sheets = sheetsState[0]; var setSheets = sheetsState[1]
  var selState = useState({}); var sel = selState[0]; var setSel = selState[1]
  var parsedState = useState(null); var parsed = parsedState[0]; var setParsed = parsedState[1]
  var tabState = useState(0); var tab = tabState[0]; var setTab = tabState[1]
  var fileState = useState(''); var fileName = fileState[0]; var setFileName = fileState[1]
  var busyState = useState(''); var busy = busyState[0]; var setBusy = busyState[1]
  var openState = useState({}); var opened = openState[0]; var setOpened = openState[1]
  var viewState = useState('estimate'); var view = viewState[0]; var setView = viewState[1]
  var openDocState = useState(null); var openDoc = openDocState[0]; var setOpenDoc = openDocState[1]
  var estDatasetState = useState(null); var estDataset = estDatasetState[0]; var setEstDataset = estDatasetState[1]
  var matchSelState = useState(null); var matchSel = matchSelState[0]; var setMatchSel = matchSelState[1] // {type:'estimate'|'site', name}

  function dismissEstimateItem(name) {
    var next = Object.assign({}, scope, { dismissed: Object.assign({}, scope.dismissed || {}, (function() { var o = {}; o[up(name)] = true; return o })()) })
    if (props.onUpdateScope) props.onUpdateScope(next)
  }

  function matchEquipment(siteName, estimateName) {
    var next = Object.assign({}, scope, { aliases: Object.assign({}, scope.aliases || {}, (function() { var o = {}; o[up(siteName)] = estimateName; return o })()) })
    if (props.onUpdateScope) props.onUpdateScope(next)
    setMatchSel(null)
  }

  function clickEstimateItem(name) {
    if (matchSel && matchSel.type === 'site') { matchEquipment(matchSel.name, name); return }
    setMatchSel(matchSel && matchSel.type === 'estimate' && matchSel.name === name ? null : { type: 'estimate', name: name })
  }

  function clickSiteItem(name) {
    if (matchSel && matchSel.type === 'estimate') { matchEquipment(name, matchSel.name); return }
    setMatchSel(matchSel && matchSel.type === 'site' && matchSel.name === name ? null : { type: 'site', name: name })
  }

  // Estimate file handed in by the global import router
  useEffect(function() {
    if (props.incomingFile) {
      setView('estimate')
      processFile(props.incomingFile)
      if (props.onConsumedIncoming) props.onConsumedIncoming()
    }
  }, [props.incomingFile])

  // Load the ESTIMATE baseline dataset (for the diff-vs-site view) whenever
  // the project changes or a fresh save just happened (busy toggles on save).
  useEffect(function() {
    if (!props.project || !props.project.id) return
    getWorkingCopy(props.project.id, 'estimate-io-summary', function(err, data) {
      if (!err) setEstDataset(data)
    })
  }, [props.project && props.project.id, busy])

  function processFile(file) {
    if (!file) return
    if (!window.XLSX) { setBusy('SPREADSHEET LIBRARY NOT LOADED — RELOAD THE PAGE'); return }
    setBusy('READING ' + up(file.name) + ' ...'); setParsed(null)
    var reader = new FileReader()
    reader.onload = function() {
      try {
        var book = window.XLSX.read(new Uint8Array(reader.result), { type: 'array' })
        var list = sheetList(book)
        var pre = {}
        list.forEach(function(s) { if (s.suggested) pre[s.name] = true })
        setWb(book); setSheets(list); setSel(pre); setFileName(file.name); setBusy('')
        window._estFile = file // held for archive on save
      } catch (err) { setBusy('COULD NOT READ FILE: ' + err) }
    }
    reader.onerror = function() { setBusy('COULD NOT READ FILE') }
    reader.readAsArrayBuffer(file)
  }

  function toggleSheet(name) {
    var next = Object.assign({}, sel); next[name] = !next[name]; setSel(next)
  }

  function doParse() {
    if (!wb) return
    var chosen = Object.keys(sel).filter(function(k) { return sel[k] })
    var byName = {}; sheetList(wb).forEach(function(m) { byName[m.name] = m })
    // skip io_cust/other same as the old parseEstimate() did
    var queue = chosen.filter(function(name) {
      var m = byName[name]; return m && m.kind !== 'io_cust' && m.kind !== 'other'
    })
    var out = []
    // one sheet per macrotask so a big workbook (real files run 5-6MB+) never
    // blocks the main thread long enough to trip Chrome's Page Unresponsive check
    function step(i) {
      if (i >= queue.length) { setParsed({ sheets: out }); setTab(0); setBusy(''); return }
      var meta = byName[queue[i]]
      setBusy('PARSING SHEET ' + (i + 1) + '/' + queue.length + ': ' + up(meta.name) + ' ...')
      setTimeout(function() {
        try {
          var rows = aoaOf(wb.Sheets[meta.name])
          out.push({ name: meta.name, kind: meta.kind, label: meta.label, data: parseSheet(meta.kind, rows) })
          step(i + 1)
        } catch (err) { setBusy('PARSE FAILED ON ' + meta.name + ': ' + err) }
      }, 20)
    }
    setBusy('PARSING ' + queue.length + ' SHEET(S) ...')
    setTimeout(function() { step(0) }, 20)
  }

  function saveScope() {
    if (!parsed) return
    var next = {
      fileName: fileName,
      importedAt: new Date().toISOString(),
      sheets: parsed.sheets
    }
    if (props.onUpdateScope) props.onUpdateScope(next)
    setBusy('SAVED TO ESTIMATE SCOPE')
    setTimeout(function() { setBusy('') }, 2500)

    // Design Engine: also persist the I-O Summary sheet as the ESTIMATE
    // baseline dataset (S2 datasetStore.js) so it can be diffed against the
    // live as-per-site panels/equipmentMap. Best-effort, non-blocking.
    var ioSummarySheet = parsed.sheets.filter(function(s) { return s.kind === 'io_summary' })[0]
    if (ioSummarySheet && props.project && props.project.id) {
      var estRows = flattenIoSummaryForDataset(ioSummarySheet.data.equipment)
      var estId = 'estimate-io-summary'
      getWorkingCopy(props.project.id, estId, function(err, existing) {
        updateWorkingCopy(props.project.id, estId, {
          kind: 'IO_SUMMARY',
          name: 'ESTIMATE — ' + fileName,
          columns: [{ id: 'equipment', title: 'EQUIPMENT', type: 'text' }, { id: 'qty', title: 'POINTS', type: 'number' }],
          rows: estRows,
          source_doc_id: null,
          version: existing ? existing.version : 1
        }, function(uerr) { if (uerr) console.warn('[MINIMATE] Estimate dataset save failed (non-blocking):', uerr.message) })
      })
    }
  }

  function toggleOpen(k) { var n = Object.assign({}, opened); n[k] = !n[k]; setOpened(n) }

  var thc = 'text-[9px] text-dgray text-left px-2 py-1.5 uppercase'
  var tdc = 'text-[11px] px-2 py-1.5 uppercase'
  var inCls = 'bg-transparent border border-transparent rounded px-1 py-0.5 uppercase outline-none focus:border-teal focus:bg-navy'

  function num(n) { return (n == null || n === '') ? '' : ('' + n) }

  function renderSheet(sh) {
    var d = sh.data || {}
    if (sh.kind === 'io_summary') {
      return (
        <table className="w-full"><thead><tr className="border-b border-border">
          <th className={thc}>EQUIPMENT</th><th className={thc + ' text-center'}>QTY</th><th className={thc + ' text-center'}>POINTS</th><th className={thc}>TAGS</th>
        </tr></thead><tbody>
          {(d.equipment || []).map(function(e, i) {
            var key = 'io' + i
            var isOpen = opened[key]
            var rows = [(
              <tr key={key} className={'border-b border-border/30 cursor-pointer hover:bg-card2/40' + (i % 2 ? ' bg-card2/20' : '')} onClick={function() { toggleOpen(key) }}>
                <td className={tdc + ' font-bold text-cyan'}><span className="text-dgray mr-1">{isOpen ? '▾' : '▸'}</span>{e.type}</td>
                <td className={tdc + ' text-center'}>{e.qty}</td>
                <td className={tdc + ' text-center font-bold text-teal'}>{e.points.length}</td>
                <td className={tdc + ' text-dgray text-[10px]'}>{e.tags}</td>
              </tr>
            )]
            if (isOpen) {
              rows.push(
                <tr key={key + 'p'} className="bg-navy/40"><td colSpan={4} className="px-4 py-2">
                  <table className="w-full"><tbody>
                    {e.points.map(function(p, pi) {
                      var types = Object.keys(p.pts).map(function(k) { return k + (p.pts[k] > 1 ? '×' + p.pts[k] : '') }).join(' / ')
                      return (<tr key={pi} className="border-b border-border/20">
                        <td className={tdc}>{p.desc}</td>
                        <td className={tdc + ' text-teal font-bold w-24'}>{types}</td>
                        <td className={tdc + ' text-dgray text-[10px]'}>{(p.devices || []).join(', ')}</td>
                      </tr>)
                    })}
                  </tbody></table>
                </td></tr>
              )
            }
            return rows
          })}
        </tbody></table>
      )
    }
    if (sh.kind === 'ddc') {
      return (
        <table className="w-full"><thead><tr className="border-b border-border">
          <th className={thc}>EQUIPMENT</th><th className={thc + ' text-center'}>QTY</th><th className={thc + ' text-center'}>TOTAL</th><th className={thc + ' text-center'}>DI</th><th className={thc + ' text-center'}>DO</th><th className={thc + ' text-center'}>AI</th><th className={thc + ' text-center'}>AO</th><th className={thc}>CONTROLLERS</th>
        </tr></thead><tbody>
          {(d.rows || []).map(function(r, i) {
            return (<tr key={i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
              <td className={tdc + ' font-bold text-cyan'}>{r.equipment}</td>
              <td className={tdc + ' text-center'}>{r.qty}</td>
              <td className={tdc + ' text-center font-bold text-teal'}>{r.total}</td>
              <td className={tdc + ' text-center'}>{num(r.di)}</td><td className={tdc + ' text-center'}>{num(r.do)}</td>
              <td className={tdc + ' text-center'}>{num(r.ai)}</td><td className={tdc + ' text-center'}>{num(r.ao)}</td>
              <td className={tdc + ' text-[10px] text-purple'}>{(r.controllers || []).map(function(c) { return c.type + (c.qty > 1 ? '×' + c.qty : '') }).join(', ')}</td>
            </tr>)
          })}
        </tbody></table>
      )
    }
    if (sh.kind === 'analysis') {
      return (
        <div>
          <div className="text-[9px] text-dgray uppercase mb-1">PRICING CAPTURED, HELD FOR FINANCE (NOT SHOWN)</div>
          <table className="w-full"><thead><tr className="border-b border-border">
            <th className={thc}>MODEL</th><th className={thc}>ORDER CODE</th><th className={thc}>DESCRIPTION</th><th className={thc + ' text-center'}>QTY</th><th className={thc + ' text-center'}>SPARES</th>
          </tr></thead><tbody>
            {(d.items || []).map(function(it, i) {
              return (<tr key={i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
                <td className={tdc + ' font-bold text-cyan'}>{it.model}</td>
                <td className={tdc + ' text-dgray'}>{it.orderCode}</td>
                <td className={tdc}>{it.description}</td>
                <td className={tdc + ' text-center font-bold'}>{it.qty}</td>
                <td className={tdc + ' text-center text-dgray'}>{num(it.spares)}</td>
              </tr>)
            })}
          </tbody></table>
        </div>
      )
    }
    if (sh.kind === 'boq') {
      return (
        <table className="w-full"><thead><tr className="border-b border-border">
          <th className={thc}>GROUP</th><th className={thc}>MODEL</th><th className={thc}>DESCRIPTION</th><th className={thc + ' text-center'}>QTY</th><th className={thc + ' text-center'}>UNIT</th>
        </tr></thead><tbody>
          {(d.items || []).map(function(it, i) {
            return (<tr key={i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
              <td className={tdc + ' text-orange text-[10px]'}>{it.group}</td>
              <td className={tdc + ' font-bold text-cyan'}>{it.model}</td>
              <td className={tdc}>{it.description}</td>
              <td className={tdc + ' text-center font-bold'}>{it.qty}</td>
              <td className={tdc + ' text-center text-dgray'}>{it.unit}</td>
            </tr>)
          })}
        </tbody></table>
      )
    }
    if (sh.kind === 'cables') {
      return (
        <table className="w-full"><thead><tr className="border-b border-border">
          <th className={thc}>DEVICE / CIRCUIT</th><th className={thc}>MODEL</th><th className={thc}>WIRE</th><th className={thc + ' text-center'}>POINTS</th><th className={thc + ' text-center'}>TOTAL M</th>
        </tr></thead><tbody>
          {(d.rows || []).map(function(r, i) {
            return (<tr key={i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
              <td className={tdc + ' font-bold text-cyan'}>{r.device}</td>
              <td className={tdc + ' text-dgray'}>{r.model}</td>
              <td className={tdc + ' text-[10px]'}>{r.wireType}</td>
              <td className={tdc + ' text-center'}>{num(r.points)}</td>
              <td className={tdc + ' text-center font-bold text-teal'}>{num(r.totalLength)}</td>
            </tr>)
          })}
        </tbody></table>
      )
    }
    if (sh.kind === 'equipment') {
      return (
        <table className="w-full"><thead><tr className="border-b border-border">
          <th className={thc}>GROUP</th><th className={thc}>EQUIPMENT</th><th className={thc + ' text-center'}>QTY</th><th className={thc + ' text-center'}>CTRL</th><th className={thc + ' text-center'}>MON</th><th className={thc + ' text-center'}>INT</th>
        </tr></thead><tbody>
          {(d.rows || []).map(function(r, i) {
            function mk(b) { return b ? <span className="text-green font-bold">✓</span> : <span className="text-dgray">·</span> }
            return (<tr key={i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
              <td className={tdc + ' text-orange text-[10px]'}>{r.group}</td>
              <td className={tdc + ' font-bold text-cyan'}>{r.equipment}</td>
              <td className={tdc + ' text-center font-bold'}>{r.qty}</td>
              <td className={tdc + ' text-center'}>{mk(r.control)}</td>
              <td className={tdc + ' text-center'}>{mk(r.monitor)}</td>
              <td className={tdc + ' text-center'}>{mk(r.integration)}</td>
            </tr>)
          })}
        </tbody></table>
      )
    }
    if (sh.kind === 'model_numbers') {
      return (
        <table className="w-full"><thead><tr className="border-b border-border">
          <th className={thc}>MODEL</th><th className={thc}>DESCRIPTION</th>
        </tr></thead><tbody>
          {(d.catalog || []).map(function(c, i) {
            return (<tr key={i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
              <td className={tdc + ' font-bold text-cyan'}>{c.model}</td><td className={tdc}>{c.description}</td>
            </tr>)
          })}
        </tbody></table>
      )
    }
    if (sh.kind === 'containment') {
      var sm = d.summary || {}
      return (
        <div className="flex flex-wrap gap-2">
          {Object.keys(sm).map(function(k) {
            return (<div key={k} className="bg-card2 rounded-lg px-3 py-2"><div className="text-[9px] text-dgray uppercase">{k}</div><div className="text-lg font-extrabold text-teal">{sm[k]}</div></div>)
          })}
        </div>
      )
    }
    // generic schedule
    var hdr = d.header || []
    return (
      <table className="w-full"><thead><tr className="border-b border-border">
        {hdr.map(function(h, i) { return <th key={i} className={thc}>{h}</th> })}
      </tr></thead><tbody>
        {(d.rows || []).slice(0, 300).map(function(r, i) {
          return (<tr key={i} className={'border-b border-border/30' + (i % 2 ? ' bg-card2/20' : '')}>
            {hdr.map(function(h, ci) { return <td key={ci} className={tdc}>{num(r[ci])}</td> })}
          </tr>)
        })}
      </tbody></table>
    )
  }

  var savedSheets = scope.sheets || []

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-3">
        <h1 className="text-lg md:text-xl font-bold uppercase">DOCUMENTS <span className="text-dgray font-normal text-xs ml-2">DESIGN ENGINE + LIBRARY</span></h1>
        <div className="text-[10px] text-dgray uppercase">USE THE <span className="text-orange font-bold">IMPORT</span> BUTTON (SIDEBAR) TO ADD FILES</div>
      </div>

      <div className="flex gap-1.5 mb-4 border-b border-border pb-2">
        {['estimate', 'drawings', 'library'].map(function(v) {
          var labels = { estimate: 'DESIGN ENGINE', drawings: 'DRAWINGS', library: 'DOCUMENT LIBRARY' }
          return <button key={v} onClick={function() { setView(v) }} className={'px-3 py-1.5 rounded text-[10px] font-bold uppercase transition ' + (view === v ? 'bg-teal/20 text-teal' : 'bg-card2 text-dgray hover:text-white')}>{labels[v]}</button>
        })}
      </div>

      {view === 'estimate' && busy && <div className="mb-3 text-[11px] text-teal uppercase font-semibold">{busy}</div>}

      {/* Sheet picker */}
      {view === 'estimate' && sheets.length > 0 && !parsed && (
        <div className="bg-card rounded-xl border border-border p-4 mb-4">
          <div className="text-[10px] text-dgray uppercase font-semibold mb-2">{up(fileName)} — CHOOSE SHEETS TO IMPORT (USEFUL ONES PRE-TICKED)</div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {sheets.map(function(s) {
              var on = !!sel[s.name]
              var dead = s.kind === 'io_cust' || s.kind === 'other'
              return (
                <button key={s.name} onClick={function() { toggleSheet(s.name) }} className={'px-2.5 py-1 rounded text-[9px] font-bold uppercase transition text-left ' + (on ? 'bg-teal/20 text-teal' : (dead ? 'bg-card2 text-dgray/60 line-through' : 'bg-card2 text-dgray hover:text-white'))}>
                  {on ? '✓ ' : ''}{s.name} <span className="text-[8px] opacity-70">· {s.label}</span>
                </button>
              )
            })}
          </div>
          <button onClick={doParse} className="px-4 py-2 bg-teal text-white text-xs font-semibold rounded-md hover:bg-teal/80 uppercase">PARSE SELECTED →</button>
        </div>
      )}

      {/* Review */}
      {view === 'estimate' && parsed && parsed.sheets.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4 mb-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="text-[10px] text-dgray uppercase font-semibold">REVIEW — {up(fileName)} · CONFIRM BEFORE SAVING TO SCOPE</div>
            <div className="flex gap-2">
              <button onClick={function() { setParsed(null) }} className="px-3 py-1.5 bg-card2 text-dgray text-[10px] font-semibold rounded uppercase hover:text-white">← BACK</button>
              <button onClick={saveScope} className="px-4 py-1.5 bg-green/20 text-green text-[11px] font-bold rounded uppercase hover:bg-green/30">✓ SAVE TO ESTIMATE SCOPE</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-3 border-b border-border pb-2">
            {parsed.sheets.map(function(s, i) {
              return <button key={i} onClick={function() { setTab(i) }} className={'px-2.5 py-1 rounded text-[9px] font-bold uppercase transition ' + (tab === i ? 'bg-teal/20 text-teal' : 'bg-card2 text-dgray hover:text-white')}>{s.label}</button>
            })}
          </div>
          <div className="overflow-x-auto">{parsed.sheets[tab] && renderSheet(parsed.sheets[tab])}</div>
        </div>
      )}

      {/* Current saved scope */}
      {view === 'estimate' && (
      <div className="bg-card rounded-xl border border-border p-4">
        <div className="text-[10px] text-dgray uppercase font-semibold mb-2">ESTIMATE SCOPE (AS-DESIGNED)</div>
        {savedSheets.length === 0 ? (
          <div className="text-[11px] text-dgray uppercase">NO ESTIMATE SAVED YET — USE THE IMPORT BUTTON IN THE SIDEBAR TO ADD A DESIGN ESTIMATE.</div>
        ) : (
          <div>
            <div className="text-[11px] uppercase mb-2"><span className="text-dgray">SOURCE: </span><span className="font-bold text-cyan">{up(scope.fileName)}</span><span className="text-dgray"> · SAVED {scope.importedAt ? scope.importedAt.substring(0, 10) : ''}</span></div>
            <div className="flex flex-wrap gap-2">
              {savedSheets.map(function(s, i) {
                var count = s.data && (s.data.equipment || s.data.rows || s.data.items || s.data.catalog || []).length
                return (<div key={i} className="bg-card2 rounded-lg px-3 py-2"><div className="text-[9px] text-dgray uppercase">{s.label}</div><div className="text-sm font-extrabold text-teal">{count != null ? count : '✓'} <span className="text-[9px] text-dgray font-normal">{count != null ? 'ROWS' : ''}</span></div></div>)
              })}
            </div>
          </div>
        )}
      </div>
      )}

      {/* Diff vs site — compares the saved estimate baseline against the LIVE
          as-per-site panels/equipmentMap (same props every other page uses).
          Works identically for a new build (site state built up by hand from
          empty) or a retrofit (site state seeded from an existing as-built
          survey import) — this just compares whatever the live state
          currently is against the design estimate, equipment-type by
          equipment-type (the I-O Summary has no panel grouping to compare
          against — see estimateDiff.js). */}
      {view === 'estimate' && estDataset && (
        <div className="bg-card rounded-xl border border-border p-4 mt-4">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] text-dgray uppercase font-semibold">ESTIMATE VS AS-PER-SITE</div>
            {matchSel && <div className="text-[9px] text-teal uppercase">{matchSel.name} SELECTED — CLICK ITS MATCH ON THE OTHER SIDE <button onClick={function() { setMatchSel(null) }} className="ml-1 text-dgray hover:text-white">✕</button></div>}
          </div>
          <div className="text-[9px] text-dgray uppercase mb-3">CLICK AN ITEM ON EACH SIDE TO LINK THEM AS THE SAME EQUIPMENT (NAMING DIFFERENCE) · ✕ DISMISSES AN ESTIMATE ITEM YOU DON'T NEED TO TRACK</div>
          {(function() {
            var diff = diffEstimateVsSite(estDataset.rows, props.equipmentMap || {}, scope.aliases || {}, scope.dismissed || {})
            var nothingToShow = diff.missingOnSite.length === 0 && diff.notInEstimate.length === 0 && diff.mismatched.length === 0
            if (nothingToShow) return <div className="text-[11px] text-green uppercase">✓ SITE MATCHES THE DESIGN ESTIMATE — NOTHING OUTSTANDING</div>
            return (
              <div className="space-y-3">
                {diff.missingOnSite.length > 0 && (
                  <div>
                    <div className="text-[9px] text-orange uppercase font-semibold mb-1">IN ESTIMATE, NOT BUILT ON SITE YET ({diff.missingOnSite.length})</div>
                    <div className="flex flex-wrap gap-1.5">
                      {diff.missingOnSite.map(function(d, i) {
                        var sel = matchSel && matchSel.type === 'estimate' && matchSel.name === d.equipment
                        return (
                          <span key={i} className={'text-[10px] px-2 py-1 rounded uppercase flex items-center gap-1 ' + (sel ? 'bg-teal text-white' : 'bg-orange/10 text-orange hover:bg-orange/20')}>
                            <button onClick={function() { clickEstimateItem(d.equipment) }} title="CLICK TO MATCH WITH A SITE ITEM">{d.equipment}</button>
                            <button onClick={function() { dismissEstimateItem(d.equipment) }} title="DISMISS — DON'T TRACK THIS" className="opacity-60 hover:opacity-100">✕</button>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}
                {diff.notInEstimate.length > 0 && (
                  <div>
                    <div className="text-[9px] text-cyan uppercase font-semibold mb-1">ON SITE, NOT IN THE DESIGN ESTIMATE ({diff.notInEstimate.length})</div>
                    <div className="flex flex-wrap gap-1.5">
                      {diff.notInEstimate.map(function(d, i) {
                        var sel = matchSel && matchSel.type === 'site' && matchSel.name === d.equipment
                        return (
                          <button key={i} onClick={function() { clickSiteItem(d.equipment) }} title="CLICK TO MATCH WITH AN ESTIMATE ITEM" className={'text-[10px] px-2 py-1 rounded uppercase ' + (sel ? 'bg-teal text-white' : 'bg-cyan/10 text-cyan hover:bg-cyan/20')}>{d.equipment}</button>
                        )
                      })}
                    </div>
                  </div>
                )}
                {diff.mismatched.length > 0 && (
                  <div>
                    <div className="text-[9px] text-red uppercase font-semibold mb-1">POINT COUNT MISMATCH ({diff.mismatched.length})</div>
                    <div className="flex flex-wrap gap-1.5">
                      {diff.mismatched.map(function(d, i) { return <span key={i} className="text-[10px] bg-red/10 text-red px-2 py-1 rounded uppercase">{d.equipment} — EST {d.estimatePoints} / SITE {d.sitePoints}</span> })}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}

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
