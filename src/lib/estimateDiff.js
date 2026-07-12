/* --- estimateDiff.js --- Design Engine: estimate-vs-as-per-site comparison ---
   Pure comparison between an ESTIMATE dataset (datasetStore.js working copy,
   flattened one-row-per-equipment-type: {equipment, qty}) and the LIVE
   panels/equipmentMap (same shape PanelDetail/IoSheetGrid already use).

   Deliberately EQUIPMENT-LEVEL, not panel-level: the estimate source is
   estimateParser.js's parseIoSummary() (the DESIGN ENGINE tab in
   DocumentsPage.jsx), which has NO panel grouping at all — DDC panel
   assignment is exactly the thing an engineer decides by hand (core
   inversion, same as TraceStudio: parser locates equipment, human decides
   panel structure, code resolves). So live equipment is aggregated ACROSS
   ALL panels by name before comparing — this also makes the comparison work
   identically for a brand-new project (live state built up from scratch)
   and a retrofit (live state seeded from an existing as-built site survey
   import, then compared the same way). */

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase().trim() }

// estimateRows: [{equipment, qty}] (dataset's flattened rows, qty = total points for that type)
// equipmentMap: {panelId: [{id, name, points: [{qty}, ...]}]} (live, from App state — every
//   panel's equipment is aggregated by name regardless of which panel it's under)
function diffEstimateVsSite(estimateRows, equipmentMap) {
  var liveByName = {}
  Object.keys(equipmentMap || {}).forEach(function(pid) {
    ;(equipmentMap[pid] || []).forEach(function(eq) {
      var key = up(eq.name)
      var pts = (eq.points || []).reduce(function(s, p) { return s + (Number(p.qty) || 1) }, 0)
      if (!liveByName[key]) liveByName[key] = { name: eq.name, points: 0 }
      liveByName[key].points += pts
    })
  })

  var estByName = {}
  ;(estimateRows || []).forEach(function(r) {
    var key = up(r.equipment)
    if (!estByName[key]) estByName[key] = { name: r.equipment, points: 0 }
    estByName[key].points += Number(r.qty) || 1
  })

  var missingOnSite = [] // in the design estimate, not built on site yet
  var notInEstimate = [] // built on site, not in the design estimate
  var mismatched = []    // matched by name but point count differs

  Object.keys(estByName).forEach(function(key) {
    var est = estByName[key]
    var live = liveByName[key]
    if (!live) { missingOnSite.push({ equipment: est.name, reason: 'NOT BUILT ON SITE YET' }); return }
    if (live.points !== est.points) {
      mismatched.push({ equipment: est.name, estimatePoints: est.points, sitePoints: live.points })
    }
  })
  Object.keys(liveByName).forEach(function(key) {
    if (!estByName[key]) notInEstimate.push({ equipment: liveByName[key].name, reason: 'NOT IN DESIGN ESTIMATE' })
  })

  return { missingOnSite: missingOnSite, notInEstimate: notInEstimate, mismatched: mismatched }
}

// Flatten estimateParser.js's parseIoSummary() output ({equipment: [{type, qty, points:
// [{pts:{DI,DO,PWM,AI,AO,INT}}]}]}) into the flat rows datasetStore.js expects.
function flattenIoSummaryForDataset(ioSummaryEquipment) {
  return (ioSummaryEquipment || []).map(function(eq) {
    var perUnitPts = (eq.points || []).reduce(function(s, pt) {
      var t = pt.pts || {}
      return s + (t.DI || 0) + (t.DO || 0) + (t.PWM || 0) + (t.AI || 0) + (t.AO || 0) + (t.INT || 0)
    }, 0)
    var qty = Number(eq.qty) || 1
    return { equipment: eq.type, qty: perUnitPts * qty }
  })
}

var _idc = 0
function nid(p) { _idc++; return p + '-' + Date.now() + '-' + _idc }

// Convert ONE parseIoSummary() equipment entry into a real panel-equipment
// object matching IoSheetGrid's shape ({id, name, group_qty, points: [{id,
// description, type, qty, ...stage flags}]}) — used by the "+ ADD FROM
// ESTIMATE" picker in PanelDetail.jsx so the engineer can pick a known
// equipment type instead of typing one from scratch. Point quantities are
// TOTALS (per-unit count x estEq.qty), matching how IoSheetGrid's own _qty
// scaling interprets stored point quantities (see applyOps in
// IoSheetGrid.jsx). Note: IO_COLUMNS has no PWM column (only DI/DO/AI/AO/SI)
// — a PWM point still gets created here (data isn't lost) but won't show
// under any column in the grid, a pre-existing grid limitation.
function estimateEquipmentToPanelEquipment(estEq) {
  var qty = Number(estEq.qty) || 1
  var points = []
  ;(estEq.points || []).forEach(function(pt) {
    var t = pt.pts || {}
    var types = [['DI', t.DI], ['DO', t.DO], ['PWM', t.PWM], ['AI', t.AI], ['AO', t.AO], ['INT', t.INT]]
    types.forEach(function(pair) {
      var n = pair[1]
      if (!n) return
      points.push({
        id: nid('pt'), description: pt.desc || '', type: pair[0], qty: n * qty,
        cable_pulled: false, cable_continuity: false, term_ddc_side: false,
        term_field_side: false, functional_test: false
      })
    })
  })
  if (points.length === 0) {
    points.push({ id: nid('pt'), description: '', type: '', qty: 0, cable_pulled: false, cable_continuity: false, term_ddc_side: false, term_field_side: false, functional_test: false })
  }
  return { id: nid('eq'), name: estEq.type, group_qty: qty, points: points }
}

export { diffEstimateVsSite, flattenIoSummaryForDataset, estimateEquipmentToPanelEquipment }
