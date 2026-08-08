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

export { parseTermination, parseTerminationSheet, looksLikeTermination, applyTermination, isDdcSheet, aoaOf }
