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

function parseTerminationSheet(rows) {
  var pins = []; var modules = []; var controller = ''
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    var c2 = cS(r, 2)
    if (!controller) {
      var cc = cS(r, 2) + ' ' + cS(r, 3)
      if (/controller/i.test(cc)) { controller = (cS(r, 3) || cS(r, 4) || '').replace(/controller/i, '').replace(/^[\s—\-]+/, '').trim() }
    }
    var joined = cS(r, 2) + ' ' + cS(r, 3)
    var mm = joined.match(/module[-\s]*([A-Za-z0-9\-]+)/i)
    if (mm) { modules.push({ type: mm[1].toUpperCase() }); continue }
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
        linkedPointId: null
      })
    }
  }
  return { controller: controller || 'ME521', modules: modules, pins: pins }
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
