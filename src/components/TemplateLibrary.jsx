import { useState, useEffect } from 'react'
import * as ca from '../lib/commissioningAgent'

/* Modbus point-role template library — modal overlay. Config generation needs exactly one ACTIVE
   template per device_type (see commissioning_agent.py's /modbus/templates/*); this is where the
   user picks which template is active, and imports new ones from an example config.csv or a
   manufacturer register sheet. Deliberately never auto-picks — multiple vendors/drafts can compete
   for the same device_type, and activation is a real commissioning decision. */
export default function TemplateLibrary({ onClose }) {
  var loadSt = useState(true), loading = loadSt[0], setLoading = loadSt[1]
  var errSt = useState(''), err = errSt[0], setErr = errSt[1]
  var tplSt = useState([]), templates = tplSt[0], setTemplates = tplSt[1]
  var busySt = useState(''), busy = busySt[0], setBusy = busySt[1]

  var showImportSt = useState(false), showImport = showImportSt[0], setShowImport = showImportSt[1]
  var importModeSt = useState('config'), importMode = importModeSt[0], setImportMode = importModeSt[1]
  var formSt = useState({ device_type: '', model: '', id: '' }), form = formSt[0], setForm = formSt[1]
  var fileSt = useState(null), file = fileSt[0], setFile = fileSt[1]

  function refresh() {
    setLoading(true); setErr('')
    ca.modbusTemplatesList()
      .then(function(res) { setTemplates(res.templates || []); setLoading(false) })
      .catch(function(e) { setErr(e.message); setLoading(false) })
  }
  useEffect(refresh, [])

  function activate(t) {
    setBusy(t.id); setErr('')
    ca.modbusTemplatesActivate({ id: t.id })
      .then(function() { refresh(); setBusy('') })
      .catch(function(e) { setErr(e.message); setBusy('') })
  }

  function readFileAsText(f) {
    return new Promise(function(resolve, reject) {
      var r = new FileReader()
      r.onload = function() { resolve(r.result) }
      r.onerror = reject
      r.readAsText(f)
    })
  }
  function readFileAsBase64(f) {
    return new Promise(function(resolve, reject) {
      var r = new FileReader()
      r.onload = function() { resolve(r.result.split(',')[1]) }
      r.onerror = reject
      r.readAsDataURL(f)
    })
  }

  function doImport() {
    if (!form.device_type.trim() || !file) return
    setBusy('import'); setErr('')
    var p = importMode === 'config'
      ? readFileAsText(file).then(function(content) {
          return ca.modbusTemplatesImportConfigCsv({
            device_type: form.device_type.trim().toUpperCase(), model: form.model, id: form.id || undefined, content: content,
          })
        })
      : readFileAsBase64(file).then(function(content_base64) {
          return ca.modbusTemplatesImportRegisterSheet({
            device_type: form.device_type.trim().toUpperCase(), model: form.model, id: form.id || undefined,
            filename: file.name, content_base64: content_base64,
          })
        })
    p.then(function(res) {
        setBusy('')
        setShowImport(false)
        setForm({ device_type: '', model: '', id: '' })
        setFile(null)
        refresh()
        if (res.validation_errors && res.validation_errors.length > 0) {
          setErr('Imported, but needs fixing: ' + res.validation_errors.join('; '))
        }
      })
      .catch(function(e) { setErr(e.message); setBusy('') })
  }

  var byType = {}
  templates.forEach(function(t) {
    var k = t.device_type || '(NO DEVICE TYPE SET)'
    if (!byType[k]) byType[k] = []
    byType[k].push(t)
  })
  var types = Object.keys(byType).sort()

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" onClick={function(e) { e.stopPropagation() }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-sm font-bold uppercase">Template Library</h2>
            <div className="text-[10px] text-dgray">One active register-map template per device type — you choose, nothing is guessed.</div>
          </div>
          <button onClick={onClose} className="text-dgray hover:text-white text-lg leading-none px-1">×</button>
        </div>

        <div className="overflow-y-auto px-4 py-3 flex-1">
          {loading && <div className="text-[11px] text-dgray uppercase">Loading…</div>}
          {err && <div className="text-[11px] text-red mb-2">{err}</div>}

          {!loading && types.length === 0 && (
            <div className="text-[11px] text-dgray italic">No templates yet. Import one below.</div>
          )}

          {types.map(function(dt) {
            return (
              <div key={dt} className="mb-4">
                <div className="text-[10px] font-bold text-cyan uppercase mb-1">{dt}</div>
                {byType[dt].map(function(t) {
                  return (
                    <div key={t.id} className={'flex items-center gap-2 px-2 py-1.5 mb-1 rounded border text-[11px] ' + (t.active ? 'border-green/50 bg-green/5' : 'border-border')}>
                      <span className={'w-2 h-2 rounded-full shrink-0 ' + (t.active ? 'bg-green' : 'bg-border')} title={t.active ? 'ACTIVE' : 'INACTIVE'} />
                      <span className="font-medium text-white">{t.id}</span>
                      <span className="text-dgray">{t.model}</span>
                      <span className="text-dgray">{t.roles} pts</span>
                      <span className={'text-[9px] px-1.5 py-0.5 rounded uppercase ' +
                        (t.status === 'vendor-confirmed' ? 'bg-green/20 text-green' :
                         t.status === 'placeholder' ? 'bg-red/20 text-red' : 'bg-orange/20 text-orange')}>{t.status}</span>
                      <span className="ml-auto">
                        {t.active ? (
                          <span className="text-green text-[10px] font-bold uppercase">Active</span>
                        ) : (
                          <button onClick={function() { activate(t) }} disabled={busy === t.id || !t.device_type || t.status === 'placeholder'}
                            title={!t.device_type ? 'Set a device_type first (re-import with one)' : t.status === 'placeholder' ? 'Placeholder has no roles yet — import real data first' : ''}
                            className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-teal/50 text-teal hover:bg-teal/10 disabled:opacity-40 disabled:cursor-not-allowed">
                            {busy === t.id ? 'Activating…' : 'Activate'}
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="border-t border-border px-4 py-3">
          {!showImport ? (
            <button onClick={function() { setShowImport(true) }} className="px-3 py-1.5 bg-teal text-white text-[11px] font-semibold uppercase rounded hover:bg-teal/80">
              + Import Template
            </button>
          ) : (
            <div className="bg-navy/40 rounded-lg p-3 border border-border">
              <div className="flex gap-2 mb-2">
                <button onClick={function() { setImportMode('config') }} className={'px-2 py-1 text-[10px] font-semibold uppercase rounded ' + (importMode === 'config' ? 'bg-teal text-white' : 'bg-card2 text-dgray')}>From config.csv</button>
                <button onClick={function() { setImportMode('register') }} className={'px-2 py-1 text-[10px] font-semibold uppercase rounded ' + (importMode === 'register' ? 'bg-teal text-white' : 'bg-card2 text-dgray')}>From register sheet</button>
              </div>
              <div className="text-[9px] text-dgray mb-2 uppercase">
                {importMode === 'config'
                  ? 'One already-correct example device’s config.csv — reverse-parsed into a template.'
                  : 'Manufacturer’s Modbus point list (Excel/CSV) — column names matched by alias, not fixed position.'}
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <div>
                  <label className="block text-[9px] text-dgray mb-0.5">Device Type</label>
                  <input value={form.device_type} onChange={function(e) { setForm(Object.assign({}, form, { device_type: e.target.value })) }}
                    placeholder="e.g. FCU, PMU, CO2" style={{ textTransform: 'uppercase' }}
                    className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-teal" />
                </div>
                <div>
                  <label className="block text-[9px] text-dgray mb-0.5">Model (opt)</label>
                  <input value={form.model} onChange={function(e) { setForm(Object.assign({}, form, { model: e.target.value })) }}
                    className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-teal" />
                </div>
                <div>
                  <label className="block text-[9px] text-dgray mb-0.5">Template ID (opt)</label>
                  <input value={form.id} onChange={function(e) { setForm(Object.assign({}, form, { id: e.target.value })) }}
                    placeholder="auto" className="w-full bg-navy border border-border rounded px-1.5 py-1 text-[11px] text-white outline-none focus:border-teal" />
                </div>
              </div>
              <input type="file" accept={importMode === 'config' ? '.csv' : '.csv,.xlsx,.xlsm'}
                onChange={function(e) { setFile(e.target.files[0] || null) }}
                className="text-[10px] text-dgray mb-2 block" />
              <div className="flex items-center gap-2">
                <button onClick={doImport} disabled={busy === 'import' || !form.device_type.trim() || !file}
                  className="px-3 py-1.5 bg-teal text-white text-[11px] font-semibold uppercase rounded hover:bg-teal/80 disabled:opacity-40">
                  {busy === 'import' ? 'Importing…' : 'Import'}
                </button>
                <button onClick={function() { setShowImport(false); setFile(null) }} className="px-3 py-1.5 bg-card2 text-dgray text-[11px] rounded hover:text-white uppercase">Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
