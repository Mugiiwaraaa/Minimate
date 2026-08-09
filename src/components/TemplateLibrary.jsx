import { useState, useEffect } from 'react'
import * as ca from '../lib/commissioningAgent'

/* Modbus register-map library — one entry per DEVICE KIND.

   A real loop mixes device kinds: a sensor loop carries a pressure sensor, a velocity sensor and a
   temp/humidity sensor on one bus, each with completely different registers and scaling. So the
   generator resolves every slave's registers through its own device type — thermostat registers
   must never end up applied to a PMU or a sensor. Two thermostat models are two device types
   ("FCU EC MOTOR" vs "FCU 3-SPEED"), not one type with a chosen variant.

   Import path: a config.csv you already know is correct for one device. Since such a file often
   describes several different devices, you pick WHICH device in it to read. */
export default function TemplateLibrary({ onClose }) {
  var loadSt = useState(true), loading = loadSt[0], setLoading = loadSt[1]
  var errSt = useState(''), err = errSt[0], setErr = errSt[1]
  var tplSt = useState([]), templates = tplSt[0], setTemplates = tplSt[1]
  var busySt = useState(''), busy = busySt[0], setBusy = busySt[1]
  var expandSt = useState(null), expanded = expandSt[0], setExpanded = expandSt[1]

  var showImportSt = useState(false), showImport = showImportSt[0], setShowImport = showImportSt[1]
  var importModeSt = useState('config'), importMode = importModeSt[0], setImportMode = importModeSt[1]
  var formSt = useState({ device_type: '', model: '', id: '', data_array: '' })
  var form = formSt[0], setForm = formSt[1]
  var fileSt = useState(null), file = fileSt[0], setFile = fileSt[1]
  var foundSt = useState(null), found = foundSt[0], setFound = foundSt[1] // devices inside the picked csv

  function refresh() {
    setLoading(true); setErr('')
    ca.modbusTemplatesList()
      .then(function(res) { setTemplates(res.templates || []); setLoading(false) })
      .catch(function(e) { setErr(e.message); setLoading(false) })
  }
  useEffect(refresh, [])

  function readText(f) {
    return new Promise(function(resolve, reject) {
      var r = new FileReader()
      r.onload = function() { resolve(r.result) }
      r.onerror = reject
      r.readAsText(f)
    })
  }
  function readBase64(f) {
    return new Promise(function(resolve, reject) {
      var r = new FileReader()
      r.onload = function() { resolve(r.result.split(',')[1]) }
      r.onerror = reject
      r.readAsDataURL(f)
    })
  }

  // A config.csv usually holds many devices — list them so the user picks which one to import.
  function pickFile(f) {
    setFile(f); setFound(null); setForm(Object.assign({}, form, { data_array: '' }))
    if (!f || importMode !== 'config') return
    readText(f).then(function(content) {
      return ca.modbusTemplatesInspectConfigCsv({ content: content })
    }).then(function(res) {
      var devs = res.devices || []
      setFound(devs)
      if (devs.length === 1) setForm(function(p) { return Object.assign({}, p, { data_array: devs[0].name }) })
    }).catch(function(e) { setErr(e.message) })
  }

  function doImport() {
    if (!form.device_type.trim() || !file) return
    setBusy('import'); setErr('')
    var base = {
      device_type: form.device_type.trim().toUpperCase(),
      model: form.model, id: form.id || undefined,
    }
    var p = importMode === 'config'
      ? readText(file).then(function(content) {
          return ca.modbusTemplatesImportConfigCsv(
            Object.assign({}, base, { content: content, data_array: form.data_array || undefined }))
        })
      : readBase64(file).then(function(b64) {
          return ca.modbusTemplatesImportRegisterSheet(
            Object.assign({}, base, { filename: file.name, content_base64: b64 }))
        })
    p.then(function(res) {
        setBusy(''); setShowImport(false); setFile(null); setFound(null)
        setForm({ device_type: '', model: '', id: '', data_array: '' })
        refresh()
        if (res.validation_errors && res.validation_errors.length > 0) {
          setErr('Imported, but needs fixing: ' + res.validation_errors.join('; '))
        }
      })
      .catch(function(e) { setErr(e.message); setBusy('') })
  }

  function retype(t) {
    var next = prompt('Which device kind does "' + t.id + '" describe?', t.device_type)
    if (next === null || !next.trim()) return
    setBusy(t.id); setErr('')
    ca.modbusTemplatesRetype({ id: t.id, device_type: next.trim().toUpperCase() })
      .then(function() { refresh(); setBusy('') })
      .catch(function(e) { setErr(e.message); setBusy('') })
  }

  function remove(t) {
    if (!confirm('Delete the register map for "' + (t.device_type || t.id) + '"?')) return
    setBusy(t.id); setErr('')
    ca.modbusTemplatesDelete({ id: t.id })
      .then(function() { refresh(); setBusy('') })
      .catch(function(e) { setErr(e.message); setBusy('') })
  }

  var untyped = templates.filter(function(t) { return !t.device_type })
  var typed = templates.filter(function(t) { return t.device_type })
    .sort(function(a, b) { return a.device_type < b.device_type ? -1 : 1 })

  function row(t) {
    var isOpen = expanded === t.id
    return (
      <div key={t.id} className="border border-border rounded mb-1 overflow-hidden">
        <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] cursor-pointer hover:bg-teal/5"
          onClick={function() { setExpanded(isOpen ? null : t.id) }}>
          <span className="text-dgray w-3">{isOpen ? '▾' : '▸'}</span>
          <span className="font-bold text-cyan uppercase">{t.device_type || '(no device kind set)'}</span>
          <span className="text-dgray">{t.roles} pts</span>
          <span className="text-dgray">array {t.array_length}</span>
          {t.model && <span className="text-dgray truncate max-w-[25%]">{t.model}</span>}
          <span className={'text-[9px] px-1.5 py-0.5 rounded uppercase ' +
            (t.status === 'vendor-confirmed' ? 'bg-green/20 text-green' :
             t.status === 'placeholder' ? 'bg-red/20 text-red' : 'bg-orange/20 text-orange')}>{t.status}</span>
          <span className="ml-auto flex items-center gap-2" onClick={function(e) { e.stopPropagation() }}>
            <button onClick={function() { retype(t) }} disabled={busy === t.id}
              className="text-[10px] text-dgray hover:text-cyan uppercase disabled:opacity-40">Rename kind</button>
            <button onClick={function() { remove(t) }} disabled={busy === t.id}
              className="text-[10px] text-red/50 hover:text-red uppercase disabled:opacity-40">Delete</button>
          </span>
        </div>
        {isOpen && (
          <div className="bg-navy/40 px-3 py-2 border-t border-border/40">
            <div className="text-[9px] text-dgray uppercase mb-1">Source: {t.source}</div>
            <table className="w-full">
              <thead><tr className="border-b border-border/40">
                <th className="text-[9px] text-dgray text-left py-1">Point</th>
                <th className="text-[9px] text-dgray text-left py-1">Register</th>
                <th className="text-[9px] text-dgray text-left py-1">BACnet</th>
              </tr></thead>
              <tbody>
                {(t.points || []).map(function(p, i) {
                  return (
                    <tr key={i} className="border-b border-border/10">
                      <td className="text-[10px] text-white py-0.5">{p.role}</td>
                      <td className="text-[10px] text-cyan py-0.5">{p.register}</td>
                      <td className="text-[10px] py-0.5">
                        {p.server_exposed
                          ? <span className="text-purple">{p.object_type}</span>
                          : <span className="text-dgray italic">polled only, not published</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col" onClick={function(e) { e.stopPropagation() }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-sm font-bold uppercase">Device Register Maps</h2>
            <div className="text-[10px] text-dgray">One per device kind. Each slave on a loop uses its own — a sensor never gets thermostat registers.</div>
          </div>
          <button onClick={onClose} className="text-dgray hover:text-white text-lg leading-none px-1">×</button>
        </div>

        <div className="overflow-y-auto px-4 py-3 flex-1">
          {loading && <div className="text-[11px] text-dgray uppercase">Loading…</div>}
          {err && <div className="text-[11px] text-red mb-2">{err}</div>}
          {!loading && templates.length === 0 && (
            <div className="text-[11px] text-dgray italic">No register maps yet. Import one from a config.csv you know is correct.</div>
          )}
          {typed.map(row)}
          {untyped.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] text-orange uppercase font-bold mb-1">Needs a device kind before it can be used</div>
              {untyped.map(row)}
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-3">
          {!showImport ? (
            <button onClick={function() { setShowImport(true) }} className="px-3 py-1.5 bg-teal text-white text-[11px] font-semibold uppercase rounded hover:bg-teal/80">
              + Import Register Map
            </button>
          ) : (
            <div className="bg-navy/40 rounded-lg p-3 border border-border">
              <div className="flex gap-2 mb-2">
                <button onClick={function() { setImportMode('config'); setFound(null) }} className={'px-2 py-1 text-[10px] font-semibold uppercase rounded ' + (importMode === 'config' ? 'bg-teal text-white' : 'bg-card2 text-dgray')}>From config.csv</button>
                <button onClick={function() { setImportMode('register'); setFound(null) }} className={'px-2 py-1 text-[10px] font-semibold uppercase rounded ' + (importMode === 'register' ? 'bg-teal text-white' : 'bg-card2 text-dgray')}>From register sheet</button>
              </div>
              <div className="text-[9px] text-dgray mb-2 uppercase">
                {importMode === 'config'
                  ? 'A config.csv already correct for this device kind. If it holds several devices, pick which one to read.'
                  : 'Manufacturer’s Modbus point list (Excel/CSV) — columns matched by alias, not fixed position.'}
              </div>

              <input type="file" accept={importMode === 'config' ? '.csv' : '.csv,.xlsx,.xlsm'}
                onChange={function(e) { pickFile(e.target.files[0] || null) }}
                className="text-[10px] text-dgray mb-2 block" />

              {found && found.length > 1 && (
                <div className="mb-2">
                  <label className="block text-[9px] text-dgray mb-0.5">
                    This file describes {found.length} devices — import which one?
                  </label>
                  <select value={form.data_array} onChange={function(e) { setForm(Object.assign({}, form, { data_array: e.target.value })) }}
                    className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-teal">
                    <option value="">Select a device…</option>
                    {found.map(function(d) {
                      return <option key={d.name} value={d.name}>{d.name} ({d.data_format}, array {d.length})</option>
                    })}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 mb-2">
                <div>
                  <label className="block text-[9px] text-dgray mb-0.5">Device Kind</label>
                  <input value={form.device_type} onChange={function(e) { setForm(Object.assign({}, form, { device_type: e.target.value })) }}
                    placeholder="PRESSURE SENSOR" style={{ textTransform: 'uppercase' }}
                    className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-teal" />
                </div>
                <div>
                  <label className="block text-[9px] text-dgray mb-0.5">Model (opt)</label>
                  <input value={form.model} onChange={function(e) { setForm(Object.assign({}, form, { model: e.target.value })) }}
                    className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-teal" />
                </div>
                <div>
                  <label className="block text-[9px] text-dgray mb-0.5">Map ID (opt)</label>
                  <input value={form.id} onChange={function(e) { setForm(Object.assign({}, form, { id: e.target.value })) }}
                    placeholder="auto" className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-teal" />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={doImport}
                  disabled={busy === 'import' || !form.device_type.trim() || !file || (found && found.length > 1 && !form.data_array)}
                  className="px-3 py-1.5 bg-teal text-white text-[11px] font-semibold uppercase rounded hover:bg-teal/80 disabled:opacity-40">
                  {busy === 'import' ? 'Importing…' : 'Import'}
                </button>
                <button onClick={function() { setShowImport(false); setFile(null); setFound(null) }} className="px-3 py-1.5 bg-card2 text-dgray text-[11px] rounded hover:text-white uppercase">Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
