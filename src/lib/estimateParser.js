/* --- estimateParser.js --- R2 Estimate/Design engine parsers ---
   Pure, kind-based extractors for the design-estimate workbook AND for the
   same document types imported STANDALONE (cable / containment / BOQ /
   schedule files that vary and revise independently). Every parser takes an
   AOA (array-of-arrays, 1 row = 1 array; use aoaOf(ws) via SheetJS) and
   returns structured data — confirm-first UI reviews it before commit.

   Grounded on the real BN-01 ADEK budget (see project-doc-engine-domain
   memory). IMPORTANT quirks handled:
   - Use I-O Summary (design view), NOT IO CUST (client-masked).
   - Point marks are 'x' OR an integer COUNT (capture the count).
   - Equipment blocks terminate ONLY on an anchored 'TOTAL' (a point named
     "Total recovery wheel..." must NOT end the block). */

/* ================= low-level helpers ================= */
function cS(r, n) { var v = r && r[n - 1]; return (v === undefined || v === null) ? '' : ('' + v).trim() }
function isNumStr(v) { return v !== '' && /^-?\d+(\.\d+)?$/.test(('' + v).trim()) }
function toNum(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n }
function marked(v) { var t = ('' + v).trim(); return t !== '' && t !== '0' }
function rowText(r) { var s = ''; for (var i = 0; i < r.length; i++) { s += ' ' + (r[i] == null ? '' : r[i]) } return s }
function isTotalCell(c) { var u = c.toUpperCase().trim(); return u === 'TOTAL' || u.indexOf('TOTAL (') === 0 || u.indexOf('TOTAL(') === 0 }
function findHeaderRow(rows, needle) {
  for (var i = 0; i < rows.length; i++) { if (rowText(rows[i]).toUpperCase().indexOf(needle.toUpperCase()) >= 0) return i }
  return -1
}

function aoaOf(ws) {
  var X = (typeof window !== 'undefined' && window.XLSX) ? window.XLSX : null
  if (!X) return []
  return X.utils.sheet_to_json(ws, { header: 1, defval: '' })
}

/* ================= sheet classification ================= */
function classifySheet(name) {
  var n = ('' + name).toLowerCase().trim()
  if (/i-?\s*o\s*summary/.test(n)) return 'io_summary'
  if (/i-?\s*o\s*(cust|customer)/.test(n)) return 'io_cust'
  if (/^ddc\b/.test(n) || n === 'ddc') return 'ddc'
  if (/analysis/.test(n)) return 'analysis'
  if (/^boq$/.test(n) || /bill of quant/.test(n)) return 'boq'
  if (/cable/.test(n)) return 'cables'
  if (/containment/.test(n)) return 'containment'
  if (/equipment\s*schedule/.test(n)) return 'equipment'
  if (/model\s*num/.test(n)) return 'model_numbers'
  if (/schedule|fcu|vav/.test(n)) return 'schedule'
  return 'other'
}
var SUGGESTED_KINDS = { io_summary: 1, ddc: 1, analysis: 1, boq: 1, cables: 1, containment: 1, equipment: 1, schedule: 1 }
var KIND_LABELS = {
  io_summary: 'BASE IO (I-O SUMMARY)', io_cust: 'IO CUSTOMER (SKIP)', ddc: 'DDC SIZING / CONTROLLERS',
  analysis: 'HARDWARE / ANALYSIS', boq: 'BILL OF QUANTITIES', cables: 'CABLE TAKEOFF',
  containment: 'CONTAINMENT', equipment: 'EQUIPMENT SCHEDULE', model_numbers: 'MODEL CATALOG',
  schedule: 'SCHEDULE (GENERIC)', other: 'OTHER'
}

function sheetList(workbook) {
  var out = []
  var names = workbook.SheetNames || []
  for (var i = 0; i < names.length; i++) {
    var kind = classifySheet(names[i])
    out.push({ name: names[i], kind: kind, label: KIND_LABELS[kind] || 'OTHER', suggested: !!SUGGESTED_KINDS[kind] })
  }
  return out
}

/* ================= I-O SUMMARY -> base IO points ================= */
var IO_MARK_COLS = [[4, 'DI'], [5, 'DO'], [6, 'PWM'], [7, 'AI'], [8, 'AO'], [9, 'INT']]
function parseIoSummary(rows) {
  var equip = []; var cur = null; var devLabels = {}
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]; var c2 = cS(r, 2); var c3 = cS(r, 3)
    if (rowText(r).indexOf('DI-Hardware') >= 0) {
      for (var n = 10; n <= 26; n++) { var lb = cS(r, n); if (lb) devLabels[n] = lb }
      continue
    }
    if (c3 && (isTotalCell(c3) || c3.toUpperCase().indexOf('LOCATION OF') >= 0 || c3.indexOf('Start From') === 0)) { cur = null; continue }
    if (isNumStr(c2) && c3 && !isTotalCell(c3)) { cur = { type: c3, qty: toNum(c2), tags: '', points: [] }; equip.push(cur); continue }
    if (!cur) continue
    if (cur.points.length === 0 && c3 && /\d/.test(c3) && (c3.indexOf('-') >= 0 || c3.indexOf(',') >= 0)) { cur.tags = c3; continue }
    if (c3) {
      var pts = {}; var has = false
      for (var k = 0; k < IO_MARK_COLS.length; k++) {
        var v = cS(r, IO_MARK_COLS[k][0])
        if (marked(v)) { var iv = parseInt(v, 10); pts[IO_MARK_COLS[k][1]] = isNaN(iv) ? 1 : iv; has = true }
      }
      var devs = []
      for (var m = 10; m <= 26; m++) { if (marked(cS(r, m)) && devLabels[m]) devs.push(devLabels[m]) }
      if (has) cur.points.push({ desc: c3, pts: pts, devices: devs })
    }
  }
  return { equipment: equip.filter(function(e) { return e.points.length > 0 }) }
}

/* ================= DDC sheet -> sizing + controller allocation ================= */
function parseDdc(rows) {
  var hi = findHeaderRow(rows, 'Total Points')
  var ctrlCols = []
  if (hi >= 0) {
    var hr = rows[hi]
    for (var n = 16; n <= 30; n++) { var lb = cS(hr, n); if (lb) ctrlCols.push({ col: n, name: lb }) }
  }
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]; var c2 = cS(r, 2); var c3 = cS(r, 3)
    if (!isNumStr(c2) || !c3 || isTotalCell(c3) || c3.toUpperCase().indexOf('LOCATION') >= 0) continue
    var ctrls = []
    for (var k = 0; k < ctrlCols.length; k++) { var cv = cS(r, ctrlCols[k].col); if (marked(cv)) ctrls.push({ type: ctrlCols[k].name, qty: toNum(cv) }) }
    out.push({
      qty: toNum(c2), equipment: c3, location: cS(r, 4),
      total: toNum(cS(r, 5)), di: toNum(cS(r, 6)), do: toNum(cS(r, 7)),
      ai: toNum(cS(r, 14)), ao: toNum(cS(r, 15)), controllers: ctrls
    })
  }
  return { rows: out, controllerColumns: ctrlCols.map(function(c) { return c.name }) }
}

/* ================= Analysis -> hardware BOM (pricing captured, hidden) ================= */
function parseAnalysis(rows) {
  var items = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]; var model = cS(r, 5); var desc = cS(r, 7)
    if (!model || model.toUpperCase() === 'KP MODEL NO' || model.toUpperCase().indexOf('MODEL') >= 0) continue
    var qty = cS(r, 3)
    if (!isNumStr(qty) && !desc) continue
    items.push({
      model: model, orderCode: cS(r, 6), description: desc,
      qty: toNum(qty), spares: toNum(cS(r, 4)),
      // pricing captured but not surfaced in UI (finance/R6):
      price: { unit: toNum(cS(r, 9)), total: toNum(cS(r, 10)), markup: toNum(cS(r, 11)) }
    })
  }
  return { items: items }
}

/* ================= BOQ -> field-device materials (grouped) ================= */
function parseBoq(rows) {
  var items = []; var group = ''
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]; var sn = cS(r, 2); var model = cS(r, 3); var desc = cS(r, 6); var qty = cS(r, 7)
    if (desc && desc.toUpperCase() === 'DESCRIPTION') continue
    // group header: text (col2/3) but no numeric S/n and no qty
    if (!isNumStr(sn) && !qty) {
      var g = sn || model
      if (g && g.toUpperCase().indexOf('BILL OF') < 0 && g.toUpperCase().indexOf('S/N') < 0) group = g
      continue
    }
    if (isNumStr(sn) && (model || desc)) {
      items.push({ group: group, sn: toNum(sn), model: model, description: desc, qty: toNum(qty), unit: cS(r, 8) })
    }
  }
  return { items: items }
}

/* ================= Cables / Option-Cables -> takeoff ================= */
function parseCables(rows) {
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]; var device = cS(r, 6)
    if (!device || device.toUpperCase() === 'DEVICE') continue
    var pts = cS(r, 7); var total = cS(r, 11)
    if (!isNumStr(pts) && !isNumStr(total)) continue
    out.push({
      qtyRolls: toNum(cS(r, 3)), model: cS(r, 4), description: cS(r, 5), device: device,
      points: toNum(pts), mPerRoll: toNum(cS(r, 8)), wireType: cS(r, 9),
      lengthPer: toNum(cS(r, 10)), totalLength: toNum(total)
    })
  }
  return { rows: out }
}

/* ================= Equipment Schedule (also a flexible schedule) ================= */
function parseEquipment(rows) {
  var out = []; var group = ''
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]; var sn = cS(r, 2); var eq = cS(r, 3); var qty = cS(r, 5)
    if (eq && eq.toUpperCase().indexOf('EQUIPMENT DESC') >= 0) continue
    if (!isNumStr(sn) && (!qty || !isNumStr(qty))) {
      var glabel = eq || cS(r, 2)
      if (glabel && /^[A-Z][A-Z &/()\-]+$/.test(glabel) && glabel.length < 30) group = glabel
      continue
    }
    if (eq && (isNumStr(sn) || isNumStr(qty))) {
      out.push({
        group: group, sn: sn, equipment: eq, qty: toNum(qty),
        control: !!cS(r, 6), monitor: !!cS(r, 7), integration: !!cS(r, 8), comments: cS(r, 9)
      })
    }
  }
  return { rows: out }
}

/* ================= Model Numbers -> flat catalog (paired columns) ================= */
function parseModelNumbers(rows) {
  var cat = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    for (var c = 1; c < r.length; c += 2) {
      var model = cS(r, c); var desc = cS(r, c + 1)
      if (model && /[0-9]/.test(model) && model.length >= 3 && desc) cat.push({ model: model, description: desc })
    }
  }
  return { catalog: cat }
}

/* ================= Containment -> summary counts only ================= */
function parseContainment(rows) {
  var summary = {}
  var keys = ['Total Wires', 'MCC', 'Field Devices', 'VAV', 'FCU', 'MCC Panels', 'FBM Panels', 'DDC Panels']
  for (var i = 0; i < rows.length && i < 14; i++) {
    var r = rows[i]; var label = cS(r, 3)
    if (!label) continue
    for (var k = 0; k < keys.length; k++) {
      if (label.toUpperCase().indexOf(keys[k].toUpperCase()) === 0) {
        var val = isNumStr(cS(r, 4)) ? toNum(cS(r, 4)) : toNum(cS(r, 5))
        summary[keys[k]] = val
      }
    }
  }
  return { summary: summary }
}

/* ================= Generic table (flexible schedules; UI maps columns) ================= */
function parseGeneric(rows) {
  var hi = -1
  for (var i = 0; i < rows.length; i++) {
    var cnt = 0; for (var n = 1; n <= rows[i].length; n++) { if (cS(rows[i], n)) cnt++ }
    if (cnt >= 3) { hi = i; break }
  }
  if (hi < 0) return { header: [], rows: [] }
  var header = rows[hi].map(function(v) { return v == null ? '' : ('' + v).trim() })
  var body = []
  for (var j = hi + 1; j < rows.length; j++) {
    var any = false; for (var m = 0; m < rows[j].length; m++) { if (cS(rows[j], m + 1)) { any = true; break } }
    if (any) body.push(rows[j])
  }
  return { header: header, rows: body }
}

/* ================= orchestration ================= */
var PARSERS = {
  io_summary: parseIoSummary, ddc: parseDdc, analysis: parseAnalysis, boq: parseBoq,
  cables: parseCables, containment: parseContainment, equipment: parseEquipment,
  model_numbers: parseModelNumbers, schedule: parseGeneric
}

function parseSheet(kind, rows) {
  var fn = PARSERS[kind] || parseGeneric
  return fn(rows)
}

/* Parse selected sheets of an already-loaded SheetJS workbook.
   selected: array of sheet names (or null = all suggested). */
function parseEstimate(workbook, selected) {
  var list = sheetList(workbook)
  var out = []
  for (var i = 0; i < list.length; i++) {
    var meta = list[i]
    var take = selected ? (selected.indexOf(meta.name) >= 0) : meta.suggested
    if (!take || meta.kind === 'io_cust' || meta.kind === 'other') continue
    var rows = aoaOf(workbook.Sheets[meta.name])
    out.push({ name: meta.name, kind: meta.kind, label: meta.label, data: parseSheet(meta.kind, rows) })
  }
  return { sheets: out }
}

export {
  classifySheet, sheetList, aoaOf, parseSheet, parseEstimate,
  parseIoSummary, parseDdc, parseAnalysis, parseBoq, parseCables,
  parseEquipment, parseModelNumbers, parseContainment, parseGeneric,
  KIND_LABELS
}
