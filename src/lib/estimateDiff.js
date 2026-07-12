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
// equipmentMap: {panelId: [{id, name, estimateType, points: [{qty}, ...]}]} (live, from App
//   state — every panel's equipment is aggregated ACROSS PANELS by base type before
//   comparing. Matched by eq.estimateType when present (equipment added via the estimate
//   picker — each physical unit is its own row, e.g. "HRAHU-1".."HRAHU-5", but they all
//   carry estimateType:"HRAHU" so they aggregate back into one comparable total), falling
//   back to eq.name for manually-typed or smartParser-imported equipment that has no
//   estimateType.
// aliases: {SITE_NAME_UPPER: 'Estimate Name'} — manual reconciliation for equipment named
//   differently on site vs in the design (e.g. "SPF" on site == "STAIRCASE PRESSURIZATION
//   FAN" in the estimate). Resolved BEFORE matching, in both directions.
// dismissed: {ESTIMATE_NAME_UPPER: true} — estimate items the engineer confirmed don't need
//   tracking (descoped, duplicate, etc.) — excluded entirely, not just hidden.
function diffEstimateVsSite(estimateRows, equipmentMap, aliases, dismissed) {
  aliases = aliases || {}
  dismissed = dismissed || {}

  var liveByName = {}
  Object.keys(equipmentMap || {}).forEach(function(pid) {
    ;(equipmentMap[pid] || []).forEach(function(eq) {
      var baseName = eq.estimateType || eq.name
      var rawKey = up(baseName)
      var resolvedName = aliases[rawKey] || baseName
      var key = up(resolvedName)
      var pts = (eq.points || []).reduce(function(s, p) { return s + (Number(p.qty) || 1) }, 0)
      if (!liveByName[key]) liveByName[key] = { name: resolvedName, points: 0 }
      liveByName[key].points += pts
    })
  })

  var estByName = {}
  ;(estimateRows || []).forEach(function(r) {
    var key = up(r.equipment)
    if (dismissed[key]) return
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

// Convert ONE parseIoSummary() equipment entry into an ARRAY of qty SEPARATE
// panel-equipment objects (e.g. picking "HRAHU x2" produces "HRAHU-1" AND
// "HRAHU-2" as two independent rows) — used by the "+ ADD FROM ESTIMATE"
// picker in PanelDetail.jsx. Each physical unit needs its OWN row: cable
// pull/continuity/termination/test are tracked per unit during commissioning,
// so one row with a "qty" multiplier (the original design) can't represent
// "unit 1 done, unit 2 not done" — this mirrors how smartParser.js's real
// IO List import already splits a qty>1 group into one row per unit
// (parseIOList's flushGroup/parseEquipTags). Each row carries
// estimateType: estEq.type so diffEstimateVsSite can aggregate all of a
// type's units back into one comparable total regardless of which panel(s)
// they ended up on.
//
// startIndex numbers the created units (default 1) — pass
// (already-allocated count for this type) + 1 so e.g. adding 2 more CAHUs
// after 2 already exist produces CAHU-3/CAHU-4, not a colliding CAHU-1/CAHU-2.
// overrideQty lets the engineer add PART of the estimate's total qty to this
// panel (e.g. 2 of 6 CAHUs — the rest likely belong on other panels);
// defaults to the estimate's full qty when omitted. Point quantities are
// PER-UNIT (not multiplied — each unit is its own row now). Note: IO_COLUMNS
// has no PWM column (only DI/DO/AI/AO/SI) — a PWM point still gets created
// here (data isn't lost) but won't show under any column in the grid, a
// pre-existing grid limitation.
function estimateEquipmentToPanelEquipment(estEq, overrideQty, startIndex) {
  var qty = Number(overrideQty != null ? overrideQty : estEq.qty) || 1
  var start = Number(startIndex) || 1
  var units = []
  for (var i = 0; i < qty; i++) {
    var points = []
    ;(estEq.points || []).forEach(function(pt) {
      var t = pt.pts || {}
      var types = [['DI', t.DI], ['DO', t.DO], ['PWM', t.PWM], ['AI', t.AI], ['AO', t.AO], ['INT', t.INT]]
      types.forEach(function(pair) {
        var n = pair[1]
        if (!n) return
        points.push({
          id: nid('pt'), description: pt.desc || '', type: pair[0], qty: n,
          cable_pulled: false, cable_continuity: false, term_ddc_side: false,
          term_field_side: false, functional_test: false
        })
      })
    })
    if (points.length === 0) {
      points.push({ id: nid('pt'), description: '', type: '', qty: 0, cable_pulled: false, cable_continuity: false, term_ddc_side: false, term_field_side: false, functional_test: false })
    }
    units.push({ id: nid('eq'), name: estEq.type + '-' + (start + i), estimateType: estEq.type, points: points })
  }
  return units
}

export { diffEstimateVsSite, flattenIoSummaryForDataset, estimateEquipmentToPanelEquipment }
