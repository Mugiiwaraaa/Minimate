/* --- terminationParser.js --- R2 import an existing termination workbook ---
   Reads a termination .xlsx (one sheet PER DDC, named DDC-GF-01 etc.) into the
   app's terminationMap shape so PanelDetail can render + the engineer can
   modify it. Sheet columns (from real BN-01 file): col2=PIN col3=COM
   col4=System col5=Point Description col6=Object Instance col7=Cable Number
   col8=Cable Description col9=Sensor/MCC; module footer 'Module-FBM-16I'.
   Pure functions on AOA (window.XLSX sheet_to_json header:1) — testable. */

function cS(r, n) { var v = r && r[n - 1]; return (v === undefined || v === null) ? '' : ('' + v).trim() }
function isPinCell(v) { return /^U[OI]\d+$/i.test(v) }
function sectionFor(pin) { return /^UO/i.test(pin) ? 'UNIVERSAL OUTPUT' : 'UNIVERSAL INPUT' }
function isDdcSheet(name) { return /^DDC-/i.test(('' + name).trim()) }

/* Split a controller's pin rows into physical device blocks (its own onboard I/O, then each
   expansion module) and make every pin label globally unique within the panel.

   WHY: a termination workbook labels every device's terminals from its own 1, so one sheet can
   carry three different physical "UI3" terminals — the ME521's own UI3, module 1's UI3 and
   module 2's UI3. Imported pins kept the bare label, so the PIN column couldn't tell an engineer
   which terminal to actually wire (found on real BN01 data: DDC-GF-02's UI3 appears 3x, holding
   AI-3, AI-13 and BI-61). generatePinLayout() already prefixes module pins 'M<n>-'; this brings
   imported sheets to the same convention.

   HOW: a block boundary is detected by the pin number RESETTING for a given prefix (…UI9, UI10,
   UI1 -> new device), NOT by the position of the 'Module-FBM-16I' marker rows — those are
   footers in some sheets and headers in others, so relying on them would mis-assign pins to the
   wrong module. Verified against real BN01 DDC-GF-02: 48 pins split exactly 16/16/16 into
   ME521 (UO1-8, UI3-10), FBM-8I8O (UO1-8, UI1-8), FBM-16I (UI1-16).

   Pure function, and idempotent: pins already carrying an 'M<n>-' prefix are left alone, so
   running it twice (or on a freshly generated sheet) changes nothing. */
function assignPinBlocks(pins, modules, controllerModel) {
  var byCtrl = {}
  ;(pins || []).forEach(function(p) {
    var ci = p.controllerIndex || 1
    if (!byCtrl[ci]) byCtrl[ci] = { block: 0, last: {} }
    var st = byCtrl[ci]
    var m = /^(?:M(\d+)-)?([A-Za-z]+)(\d+)$/.exec(p.pin || '')
    if (!m) { p._block = st.block; return }
    if (m[1]) { p._block = parseInt(m[1], 10); return }   // already prefixed — trust it
    var prefix = m[2].toUpperCase()
    var num = parseInt(m[3], 10)
    if (st.last[prefix] !== undefined && num <= st.last[prefix]) { st.block += 1; st.last = {} }
    st.last[prefix] = num
    p._block = st.block
  })

  var ctrlName = controllerModel || 'CONTROLLER'
  return (pins || []).map(function(p) {
    var blk = p._block || 0
    var ci = p.controllerIndex || 1
    var out = {}
    Object.keys(p).forEach(function(k) { if (k !== '_block') out[k] = p[k] })
    if (blk === 0) {
      out.section = 'CONTROLLER'
      out.sectionLabel = ctrlName + ' - ' + sectionFor(out.pin || '')
      return out
    }
    // Module numbering restarts per controller, matching generatePinLayout + sheet_parser.py.
    var mine = (modules || []).filter(function(md) { return (md.controllerIndex || 1) === ci })
    var mt = mine[blk - 1] && mine[blk - 1].type
    out.section = 'MODULE-' + blk
    out.sectionLabel = 'MODULE ' + blk + (mt ? ' (' + mt + ')' : '')
    if (!/^M\d+-/.test(out.pin || '')) out.pin = 'M' + blk + '-' + (out.pin || '')
    return out
  })
}

/* Multi-controller aware: a termination sheet can have more than one "Controller N" block
   (confirmed on real BN01 data — DDC-RF-01 has 2). Each pin/module is tagged with the
   controllerIndex of the block it fell under (1-based, matching sheet_parser.py's Python
   parser). `controller` stays a single string (= controllers[0].model) for backward
   compatibility with existing UI that reads it directly; `controllers` is the authoritative
   multi-controller list. Object-instance tokens are only unique WITHIN one controller (BI-3 on
   controller 1 and BI-3 on controller 2 are different physical points) — anything consuming
   `objectInstance` must key on (controllerIndex, objectInstance) together, not the token alone. */
function parseTerminationSheet(rows) {
  var pins = []; var modules = []; var controllers = []
  var ctrlIndex = 0; var ctrlModel = ''
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    var c2 = cS(r, 2)
    var cc = cS(r, 2) + ' ' + cS(r, 3)
    if (/controller/i.test(cc)) {
      ctrlIndex += 1
      // Two physically separate controllers under one panel each get their own IP and their own
      // independent EIO module numbering (1-4) -- the ONLY thing distinguishing them at the
      // BACnet level is bacnetId. Extract it the same way sheet_parser.py does: from either this
      // "Controller N — model | BACnet ID: id" row, or fall back to the panel's row-2 metadata.
      var rowText = (cS(r, 2) + ' ' + cS(r, 3) + ' ' + cS(r, 4) + ' ' + cS(r, 5) + ' ' + cS(r, 6))
      ctrlModel = (cS(r, 3) || cS(r, 4) || '').replace(/controller/i, '').replace(/^[\s—\-]+/, '').trim()
      var bidMatch = rowText.match(/bacnet\s*id\s*[:\-]?\s*([A-Za-z0-9()/ \-]+)/i)
      var bacnetId = bidMatch ? bidMatch[1].trim() : ''
      controllers.push({ index: ctrlIndex, model: ctrlModel || 'ME521', bacnetId: bacnetId, ip: '' })
      continue
    }
    var joined = cS(r, 2) + ' ' + cS(r, 3)
    var mm = joined.match(/module[-\s]*([A-Za-z0-9\-]+)/i)
    if (mm) { modules.push({ type: mm[1].toUpperCase(), controllerIndex: ctrlIndex || 1 }); continue }
    if (isPinCell(c2)) {
      var desc = cS(r, 5)
      pins.push({
        pin: c2.toUpperCase(),
        com: cS(r, 3),
        system: cS(r, 4),
        pointDescription: desc || 'SPARE',
        objectInstance: cS(r, 6),
        cableNumber: cS(r, 7),
        cableDescription: cS(r, 8),
        sensorMCC: cS(r, 9),
        sectionLabel: sectionFor(c2),
        linkedPointId: null,
        controllerIndex: ctrlIndex || 1
      })
    }
  }
  if (controllers.length === 0) controllers.push({ index: 1, model: 'ME521' })
  // Disambiguate per-device pin labels before handing the sheet to the app (see assignPinBlocks).
  pins = assignPinBlocks(pins, modules, controllers[0].model)
  return { controller: controllers[0].model, controllers: controllers, modules: modules, pins: pins }
}

function aoaOf(ws) {
  var X = (typeof window !== 'undefined' && window.XLSX) ? window.XLSX : null
  if (!X) return []
  return X.utils.sheet_to_json(ws, { header: 1, defval: '' })
}

/* Parse a whole termination workbook -> { <sheetName>: termData }. */
function parseTermination(workbook) {
  var out = {}
  var names = workbook.SheetNames || []
  for (var i = 0; i < names.length; i++) {
    if (!isDdcSheet(names[i])) continue
    var t = parseTerminationSheet(aoaOf(workbook.Sheets[names[i]]))
    if (t.pins.length > 0) { t.sheetName = names[i].trim(); out[names[i].trim()] = t }
  }
  return out
}

/* Does this workbook look like a termination sheet? (>=1 DDC-* sheet) */
function looksLikeTermination(workbook) {
  var names = workbook.SheetNames || []
  var n = 0
  for (var i = 0; i < names.length; i++) { if (isDdcSheet(names[i])) n++ }
  return n >= 1
}

/* Merge parsed termination into the existing terminationMap, matching each
   DDC sheet to a panel by name (case-insensitive). Returns a NEW map +
   the list of matched/unmatched sheet names. */
function applyTermination(terminationMap, panels, parsed) {
  var map = Object.assign({}, terminationMap || {})
  var matched = []; var unmatched = []
  var byName = {}
  ;(panels || []).forEach(function(p) { byName[('' + (p.name || '')).toUpperCase().trim()] = p })
  Object.keys(parsed).forEach(function(sheet) {
    var p = byName[sheet.toUpperCase().trim()]
    if (p) { map[p.id] = parsed[sheet]; matched.push(sheet) }
    else { unmatched.push(sheet) }
  })
  return { terminationMap: map, matched: matched, unmatched: unmatched }
}

export { parseTermination, parseTerminationSheet, looksLikeTermination, applyTermination, isDdcSheet, aoaOf, assignPinBlocks }
