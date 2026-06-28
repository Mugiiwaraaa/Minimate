// Minimate Smart Parser v0.1
// Auto-detects: FCU Schedule, VAV Schedule, IO List, DDC Termination Sheet

var DOC_TYPES = {
  FCU_SCHEDULE: 'FCU_SCHEDULE',
  VAV_SCHEDULE: 'VAV_SCHEDULE',
  IO_LIST: 'IO_LIST',
  DDC_TERMINATION: 'DDC_TERMINATION',
  UNKNOWN: 'UNKNOWN'
}

var DOC_LABELS = {}
DOC_LABELS[DOC_TYPES.FCU_SCHEDULE] = 'FCU SCHEDULE'
DOC_LABELS[DOC_TYPES.VAV_SCHEDULE] = 'VAV SCHEDULE'
DOC_LABELS[DOC_TYPES.IO_LIST] = 'IO LIST'
DOC_LABELS[DOC_TYPES.DDC_TERMINATION] = 'DDC TERMINATION SHEET'
DOC_LABELS[DOC_TYPES.UNKNOWN] = 'UNKNOWN DOCUMENT'

var _idCounters = { panel: 200, eq: 300, pt: 400, area: 500, dev: 1000 }
function gid(prefix) { return prefix + '-' + (_idCounters[prefix]++) }

// Generate slug ID from panel name: "DDC-GF-01" → "ddc_gf_01"
function panelSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function up(v) { return (v || '').toUpperCase().trim() }

// ─── Auto-detection ───────────────────────────────────────────────
function detectDocType(wb) {
  var names = wb.SheetNames.map(function(n) { return n.toUpperCase() })
  var allHeaders = []
  names.forEach(function(name, si) {
    var ws = wb.Sheets[wb.SheetNames[si]]
    var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    for (var r = 0; r < Math.min(rows.length, 15); r++) {
      for (var c = 0; c < Math.min((rows[r] || []).length, 20); c++) {
        allHeaders.push(String(rows[r][c] || '').toUpperCase().trim())
      }
    }
  })
  var joined = allHeaders.join(' ')
  var scores = {}
  scores[DOC_TYPES.FCU_SCHEDULE] = 0
  scores[DOC_TYPES.VAV_SCHEDULE] = 0
  scores[DOC_TYPES.IO_LIST] = 0
  scores[DOC_TYPES.DDC_TERMINATION] = 0

  // FCU
  if (joined.indexOf('FCU') >= 0) scores[DOC_TYPES.FCU_SCHEDULE] += 5
  if (joined.indexOf('FAN COIL') >= 0) scores[DOC_TYPES.FCU_SCHEDULE] += 3
  if (names.some(function(n) { return n.indexOf('FCU') >= 0 || n.indexOf('TRACKER') >= 0 })) scores[DOC_TYPES.FCU_SCHEDULE] += 4

  // VAV
  if (joined.indexOf('VAV') >= 0) scores[DOC_TYPES.VAV_SCHEDULE] += 5
  if (names.some(function(n) { return n.indexOf('VAV') >= 0 })) scores[DOC_TYPES.VAV_SCHEDULE] += 4

  // IO List
  if (joined.indexOf('IO LIST') >= 0 || joined.indexOf('I/O LIST') >= 0 || joined.indexOf('IO POINT') >= 0) scores[DOC_TYPES.IO_LIST] += 6
  if (joined.indexOf('IO SCHEDULE') >= 0 || joined.indexOf('I/O SCHEDULE') >= 0 || joined.indexOf('POINT SCHEDULE') >= 0) scores[DOC_TYPES.IO_LIST] += 6
  if (joined.indexOf('LOCATION OF EQUIPMENT') >= 0) scores[DOC_TYPES.IO_LIST] += 5
  if (joined.indexOf('DIGITAL INPUT') >= 0 || joined.indexOf('ANALOG') >= 0) scores[DOC_TYPES.IO_LIST] += 3
  if (joined.indexOf('DI-HARDWARE') >= 0 || joined.indexOf('DO-HARDWARE') >= 0) scores[DOC_TYPES.IO_LIST] += 5
  if (joined.indexOf('REQUIRED POINTS') >= 0) scores[DOC_TYPES.IO_LIST] += 4

  // DDC Termination
  if (joined.indexOf('DDC PANEL SCHEDULE') >= 0) scores[DOC_TYPES.DDC_TERMINATION] += 6
  if (joined.indexOf('PANEL ASSEMBLED') >= 0 || joined.indexOf('ENCLOSURE INSTALLED') >= 0) scores[DOC_TYPES.DDC_TERMINATION] += 5
  if (joined.indexOf('CABLE PULLING') >= 0 && joined.indexOf('PANEL TERMINATION') >= 0) scores[DOC_TYPES.DDC_TERMINATION] += 6
  if (names.some(function(n) { return n.indexOf('DDC SCHEDULE') >= 0 })) scores[DOC_TYPES.DDC_TERMINATION] += 4
  if (joined.indexOf('UNIVERSAL OUTPUT') >= 0 || joined.indexOf('UNIVERSAL INPUT') >= 0) scores[DOC_TYPES.DDC_TERMINATION] += 4
  if (names.filter(function(n) { return n.indexOf('DDC-') >= 0 }).length >= 3) scores[DOC_TYPES.DDC_TERMINATION] += 5

  var best = DOC_TYPES.UNKNOWN
  var bestScore = 3
  Object.keys(scores).forEach(function(type) {
    if (scores[type] > bestScore) { bestScore = scores[type]; best = type }
  })
  return { type: best, scores: scores, label: DOC_LABELS[best] }
}

// ─── Parse equipment IDs like "CAHU-4,5,6" → ["CAHU-4","CAHU-5","CAHU-6"] ──
function parseEquipTags(idStr, qty) {
  if (!idStr) {
    var tags = []
    for (var i = 1; i <= qty; i++) tags.push('UNIT-' + i)
    return tags
  }
  var parts = idStr.split(',').map(function(s) { return s.trim() })
  if (parts.length === 0) return [idStr]
  // First part has the full tag e.g. "CAHU-4"
  var first = parts[0]
  // Find prefix: everything up to the last numeric portion
  var prefixMatch = first.match(/^(.*?[\-\/\s])(\d+.*)$/)
  if (!prefixMatch) {
    // No numeric suffix pattern, treat each as fully specified
    return parts.filter(function(p) { return p.length > 0 })
  }
  var prefix = prefixMatch[1] // e.g. "CAHU-"
  var tags = [first]
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i].trim()
    if (!p) continue
    // If it looks like just a number or short suffix, prepend prefix
    if (/^\d+/.test(p) && p.indexOf('-') < 0 && p.length < first.length) {
      tags.push(prefix + p)
    } else {
      tags.push(p)
    }
  }
  return tags
}

// ─── IO List Parser ──────────────────────────────────────────────
function parseIOList(wb, existingPanels, existingEquipMap) {
  // Find the right sheet - prefer "As per Site" over "Approved"
  var sheetName = wb.SheetNames[0]
  wb.SheetNames.forEach(function(n) {
    var u = n.toUpperCase()
    if (u.indexOf('SITE') >= 0 || u.indexOf('LATEST') >= 0 || u.indexOf('REVISED') >= 0) sheetName = n
  })
  var ws = wb.Sheets[sheetName]
  var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  var panels = []
  var equipMap = {}
  var warnings = []
  var skipped = []
  var updated = []

  // Build lookup of existing panels by name
  var existingByName = {}
  existingPanels.forEach(function(p) { existingByName[up(p.name)] = p })

  var currentPanel = null
  var currentPanelId = null
  var currentEquipList = []
  // Temp group: collects points before splitting by tag
  var currentGroup = null  // {name, qty, idsStr, pointRows:[{desc,di,do,ai,ao,int}]}
  var r = 0

  function flushGroup() {
    if (!currentGroup || currentGroup.pointRows.length === 0) { currentGroup = null; return }
    var g = currentGroup
    var tags = parseEquipTags(g.idsStr, g.qty)
    var numUnits = tags.length || g.qty || 1

    tags.forEach(function(tag) {
      var eq = { id: gid('eq'), name: tag, equipment_ids: tag, qty: 1, points: [] }
      g.pointRows.forEach(function(pr) {
        var types = [
          { type: 'DI', total: pr.di },
          { type: 'DO', total: pr.do },
          { type: 'AI', total: pr.ai },
          { type: 'AO', total: pr.ao },
          { type: 'INT', total: pr.int }
        ]
        types.forEach(function(t) {
          if (t.total <= 0) return
          var perUnit = Math.floor(t.total / numUnits)
          if (perUnit <= 0) perUnit = 1
          eq.points.push({
            id: gid('pt'), description: pr.desc, type: t.type, qty: perUnit,
            cable_pulled: false, cable_continuity: false, term_ddc_side: false,
            term_field_side: false, functional_test: false, excluded: false, exclude_remark: ''
          })
        })
      })
      if (eq.points.length > 0) currentEquipList.push(eq)
    })
    currentGroup = null
  }

  while (r < rows.length) {
    var row = rows[r]
    var c0 = up(String(row[0] || ''))
    var c1 = up(String(row[1] || ''))

    // Detect DDC panel header: col2 starts with "DDC-"
    if (c1.indexOf('DDC-') === 0) {
      // Flush previous group and save panel
      flushGroup()
      if (currentPanel && currentEquipList.length > 0) {
        equipMap[currentPanelId] = currentEquipList
      }

      // Parse panel name and location from "DDC-GF-01 (ELECTRICAL ROOM Z4PT3)"
      var panelStr = c1
      var panelName = panelStr
      var panelLocation = ''
      var parenIdx = panelStr.indexOf('(')
      if (parenIdx >= 0) {
        panelName = panelStr.substring(0, parenIdx).trim()
        panelLocation = panelStr.substring(parenIdx + 1).replace(/\)$/, '').trim()
      }

      // Extract floor from panel name (DDC-GF-01 -> GF)
      var floorMatch = panelName.match(/DDC-([A-Z]+)-/)
      var panelFloor = floorMatch ? floorMatch[1] : ''

      // Check if panel already exists
      var existing = existingByName[panelName]
      if (existing) {
        currentPanelId = existing.id
        currentPanel = existing
        updated.push(panelName)
      } else {
        currentPanelId = panelSlug(panelName)
        currentPanel = {
          id: currentPanelId,
          name: panelName,
          location: panelLocation,
          floor: panelFloor
        }
        panels.push(currentPanel)
      }
      currentEquipList = []
      currentGroup = null
      r++
      continue
    }

    // Detect TOTAL row (end of panel section)
    if (c1.indexOf('TOTAL') >= 0 && currentPanel) {
      flushGroup()
      if (currentEquipList.length > 0) {
        equipMap[currentPanelId] = currentEquipList
      }
      currentPanel = null
      currentPanelId = null
      currentEquipList = []
      r++
      continue
    }

    // Skip header rows
    if (c0 === 'QTY' || c1 === 'LOCATION OF EQUIPMENT' || c1 === 'START FROM HERE') { r++; continue }

    // Inside a panel section
    if (currentPanel) {
      var qty = parseInt(c0)
      // Equipment group header: has numeric qty in col0 and name in col1
      if (qty > 0 && c1 && c1.indexOf('DI-') < 0 && c1.indexOf('DO-') < 0) {
        // Flush previous group
        flushGroup()
        currentGroup = { name: c1, qty: qty, idsStr: '', pointRows: [] }
        // Next row might have equipment IDs (e.g. "CAHU-4,5,6")
        if (r + 1 < rows.length) {
          var nextRow = rows[r + 1]
          var nc0 = String(nextRow[0] || '').trim()
          var nc1 = up(String(nextRow[1] || ''))
          var nc3 = parseInt(nextRow[2]) || 0
          var nc4 = parseInt(nextRow[3]) || 0
          var nc5 = parseInt(nextRow[4]) || 0
          var nc6 = parseInt(nextRow[5]) || 0
          if (!nc0 && nc1 && nc3 === 0 && nc4 === 0 && nc5 === 0 && nc6 === 0 && nc1.indexOf('TOTAL') < 0) {
            currentGroup.idsStr = nc1
            r++ // skip the IDs row
          }
        }
        r++
        continue
      }

      // IO point row: description in col1, counts in col2(DI), col3(DO), col4(AI), col5(AO), col6(INT)
      if (currentGroup && c1 && c0 === '') {
        currentGroup.pointRows.push({
          desc: c1,
          di: parseInt(row[2]) || 0,
          do: parseInt(row[3]) || 0,
          ai: parseInt(row[4]) || 0,
          ao: parseInt(row[5]) || 0,
          int: parseInt(row[6]) || 0
        })
      }
    }

    r++
  }

  // Handle last panel if file doesn't end with TOTAL
  flushGroup()
  if (currentPanel && currentEquipList.length > 0) {
    equipMap[currentPanelId] = currentEquipList
  }

  // Count stats
  var totalPoints = 0
  var totalEquipment = 0
  Object.keys(equipMap).forEach(function(pid) {
    totalEquipment += equipMap[pid].length
    equipMap[pid].forEach(function(eq) {
      eq.points.forEach(function(pt) { totalPoints += pt.qty })
    })
  })

  return {
    docType: DOC_TYPES.IO_LIST,
    docLabel: 'IO LIST',
    sheetName: sheetName,
    panels: panels,
    equipMap: equipMap,
    updated: updated,
    skipped: skipped,
    warnings: warnings,
    totalPoints: totalPoints,
    totalEquipment: totalEquipment,
    target: 'panels'
  }
}

// ─── DDC Termination Sheet Parser ────────────────────────────────
function parseDDCTermination(wb, existingPanels) {
  // First sheet = DDC Schedule overview with panel progress
  var schedSheet = null
  wb.SheetNames.forEach(function(n) {
    if (n.toUpperCase().indexOf('SCHEDULE') >= 0 || n.toUpperCase().indexOf('DDC SCHEDULE') >= 0) schedSheet = n
  })
  if (!schedSheet) schedSheet = wb.SheetNames[0]

  var ws = wb.Sheets[schedSheet]
  var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  var panelUpdates = []
  var warnings = []
  var newPanels = []

  // Build lookup
  var existingByName = {}
  existingPanels.forEach(function(p) { existingByName[up(p.name)] = p })

  // Find header row to map columns
  var headerRow = -1
  var colMap = {}
  for (var r = 0; r < Math.min(rows.length, 10); r++) {
    var row = rows[r]
    for (var c = 0; c < (row || []).length; c++) {
      var v = up(String(row[c] || ''))
      if (v === 'PANEL NAME' || v === 'PANEL') { colMap.name = c; headerRow = r }
      if (v === 'LOCATION') colMap.location = c
      if (v === 'LEVEL') colMap.level = c
      if (v === 'ZONE') colMap.zone = c
      if (v === 'PART') colMap.part = c
      if (v.indexOf('ENCLOSURE') >= 0) colMap.enclosure = c
      if (v.indexOf('ASSEMBLED') >= 0) colMap.assembled = c
      if (v === 'REMARKS') colMap.remarks = c
      if (v.indexOf('DDC INSTALLATION') >= 0 || v.indexOf('DDC INST') >= 0) colMap.ddcInstall = c
      if (v.indexOf('CABLE PULL') >= 0) colMap.cablePull = c
      if (v.indexOf('PANEL TERMINATION') >= 0 || v.indexOf('TERMINATION') >= 0) colMap.termination = c
      if (v.indexOf('INSPECTION') >= 0) colMap.inspection = c
      if (v.indexOf('NO. OF IO') >= 0 || v.indexOf('NO OF IO') >= 0 || v === 'IO') colMap.ioCount = c
      if (v.indexOf('MOUNTING') >= 0) colMap.mounting = c
      if (v.indexOf('CANOPY') >= 0) colMap.canopy = c
      if (v.indexOf('PANEL SIZE') >= 0 || v.indexOf('SIZE') >= 0) colMap.size = c
    }
    if (headerRow >= 0) break
  }

  if (headerRow < 0 || colMap.name === undefined) {
    warnings.push('COULD NOT FIND PANEL NAME COLUMN IN SCHEDULE SHEET')
    return {
      docType: DOC_TYPES.DDC_TERMINATION,
      docLabel: 'DDC TERMINATION SHEET',
      sheetName: schedSheet,
      panelUpdates: [],
      newPanels: [],
      warnings: warnings,
      target: 'panels'
    }
  }

  function isCheck(v) {
    var s = String(v || '').trim()
    return s === '✔️' || s === '✔' || s === '✓' || s === 'YES' || s === 'DONE' || s === 'Y' || s === '1' || s === 'TRUE' || s === 'X' || s === 'x'
  }

  var currentLevel = ''
  for (var r2 = headerRow + 1; r2 < rows.length; r2++) {
    var dr = rows[r2]
    var pName = up(String(dr[colMap.name] || ''))
    if (!pName || pName.indexOf('DDC-') < 0) continue

    // Carry forward level for merged cells
    var lvl = up(String(dr[colMap.level] || ''))
    if (lvl) currentLevel = lvl

    var pLocation = colMap.location !== undefined ? up(String(dr[colMap.location] || '')) : ''
    var pZone = colMap.zone !== undefined ? up(String(dr[colMap.zone] || '')) : ''
    var pPart = colMap.part !== undefined ? up(String(dr[colMap.part] || '')) : ''
    var pRemarks = colMap.remarks !== undefined ? String(dr[colMap.remarks] || '').trim().toUpperCase() : ''
    var pSize = colMap.size !== undefined ? up(String(dr[colMap.size] || '')) : ''
    var pMount = colMap.mounting !== undefined ? up(String(dr[colMap.mounting] || '')) : ''
    var pCanopy = colMap.canopy !== undefined ? up(String(dr[colMap.canopy] || '')) : ''

    var progress = {
      enclosure: colMap.enclosure !== undefined ? isCheck(dr[colMap.enclosure]) : false,
      assembled: colMap.assembled !== undefined ? isCheck(dr[colMap.assembled]) : false,
      ddcInstall: colMap.ddcInstall !== undefined ? isCheck(dr[colMap.ddcInstall]) : false,
      cablePull: colMap.cablePull !== undefined ? isCheck(dr[colMap.cablePull]) : false,
      termination: colMap.termination !== undefined ? isCheck(dr[colMap.termination]) : false,
      inspection: colMap.inspection !== undefined ? isCheck(dr[colMap.inspection]) : false
    }

    var existing = existingByName[pName]
    if (existing) {
      panelUpdates.push({
        panelId: existing.id,
        panelName: pName,
        location: pLocation || existing.location,
        floor: currentLevel || existing.floor,
        zone: pZone,
        part: pPart,
        progress: progress,
        remarks: pRemarks,
        size: pSize,
        mounting: pMount,
        canopy: pCanopy
      })
    } else {
      // Create new panel
      var floorFromName = ''
      var fm = pName.match(/DDC-([A-Z]+)-/)
      if (fm) floorFromName = fm[1]
      var newPanel = {
        id: panelSlug(pName),
        name: pName,
        location: pLocation,
        floor: currentLevel || floorFromName,
        zone: pZone,
        part: pPart,
        size: pSize,
        mounting: pMount,
        canopy: pCanopy,
        progress: progress,
        remarks: pRemarks
      }
      newPanels.push(newPanel)
    }
  }

  // ─── Parse per-panel sheets for pin-level termination data ───
  var terminationData = {}
  // Build full panel ID lookup (existing + new)
  var allPanelIds = {}
  existingPanels.forEach(function(p) { allPanelIds[up(p.name)] = p.id })
  newPanels.forEach(function(p) { allPanelIds[up(p.name)] = p.id })

  wb.SheetNames.forEach(function(sn) {
    if (sn === schedSheet) return  // skip overview sheet
    var sheetUp = up(sn)
    if (sheetUp.indexOf('DDC-') < 0) return  // only parse DDC-named sheets

    var pws = wb.Sheets[sn]
    var prows = window.XLSX.utils.sheet_to_json(pws, { header: 1, defval: '' })
    if (prows.length < 5) return

    // Row 1: panel name, Row 2: metadata, Row 3: controller model
    var sheetPanelName = up(String(prows[0][0] || sn))
    // Clean panel name - might have extra text
    var pnMatch = sheetPanelName.match(/(DDC-[A-Z]+-\d+)/)
    if (pnMatch) sheetPanelName = pnMatch[1]

    var panelId = allPanelIds[sheetPanelName]
    if (!panelId) {
      // Try matching sheet name directly
      var snMatch = sheetUp.match(/(DDC-[A-Z]+-\d+)/)
      if (snMatch) panelId = allPanelIds[snMatch[1]]
    }
    if (!panelId) { warnings.push('COULD NOT MATCH SHEET "' + sn + '" TO A PANEL'); return }

    // Try to detect controller model from first few rows
    var controllerModel = 'ME521'  // default
    for (var cr = 0; cr < Math.min(prows.length, 5); cr++) {
      var cRow = prows[cr]
      for (var cc = 0; cc < (cRow || []).length; cc++) {
        var cv = up(String(cRow[cc] || ''))
        if (cv.indexOf('ME521') >= 0) controllerModel = 'ME521'
        if (cv.indexOf('ME520') >= 0) controllerModel = 'ME520'
      }
    }

    // Parse pin rows - look for UNIVERSAL OUTPUT and UNIVERSAL INPUT sections
    // COLUMN MAP (col A is always empty in K&P termination sheets):
    //   B(1)=PIN name / module header   C(2)=COM   D(3)=System / section header
    //   E(4)=Point Description   F(5)=Object Instance   G(6)=Cable Number
    //   H(7)=Cable Description   I(8)=Sensor/MCC
    var pins = []
    var currentSection = ''
    var currentSectionLabel = ''
    var currentModuleSlot = 0
    var detectedModules = []

    for (var pr = 0; pr < prows.length; pr++) {
      var prow = prows[pr]
      var colB = up(String(prow[1] || ''))  // PIN name or module header
      var colD = up(String(prow[3] || ''))  // section header or system name

      // Detect module headers in column B: "Module-FBM-16I (1)", "Module-FBM-8I8O (2)"
      if (colB.indexOf('MODULE') >= 0 && colB.indexOf('FBM') >= 0) {
        var slotMatch = colB.match(/\((\d+)\)/)
        currentModuleSlot = slotMatch ? parseInt(slotMatch[1]) : (currentModuleSlot + 1)
        // Detect module type
        if (colB.indexOf('16I') >= 0 || colB.indexOf('16UI') >= 0) {
          detectedModules.push({ slot: currentModuleSlot, type: 'FB16UI' })
        } else if (colB.indexOf('8I8O') >= 0) {
          detectedModules.push({ slot: currentModuleSlot, type: 'FB8I8O' })
        }
        // Section will be set by the next header row
        continue
      }

      // Detect section headers - check column D first (e.g. "UNIVERSAL OUTPUT"), also column B
      var sectionSource = colD || colB
      if (sectionSource.indexOf('UNIVERSAL OUTPUT') >= 0 || (sectionSource.indexOf('OUTPUT') >= 0 && sectionSource.indexOf('MODULE') < 0 && sectionSource.indexOf('PIN') < 0)) {
        if (currentModuleSlot > 0) {
          currentSection = 'M' + currentModuleSlot + '-DO'
          currentSectionLabel = 'MODULE ' + currentModuleSlot + ' - DIGITAL OUTPUT'
        } else {
          currentSection = 'UO'
          currentSectionLabel = controllerModel + ' - UNIVERSAL OUTPUT'
        }
        continue
      }
      if (sectionSource.indexOf('UNIVERSAL INPUT') >= 0 || (sectionSource.indexOf('INPUT') >= 0 && sectionSource.indexOf('MODULE') < 0 && sectionSource.indexOf('PIN') < 0)) {
        if (currentModuleSlot > 0) {
          currentSection = 'M' + currentModuleSlot + '-DI'
          currentSectionLabel = 'MODULE ' + currentModuleSlot + ' - DIGITAL INPUT'
        } else {
          currentSection = 'UI'
          currentSectionLabel = controllerModel + ' - UNIVERSAL INPUT'
        }
        continue
      }

      // Skip header/label rows (PIN header, empty rows, metadata rows)
      if (colB === 'PIN' || colB === 'COM' || colB === '') continue
      if (colB.indexOf('CONTROLLER') >= 0 || colB.indexOf('BMS') >= 0 || colB.indexOf('BACNET') >= 0 || colB.indexOf('IP') >= 0) continue

      // Pin row detection: UO1-UO8, UI3-UI10, DO1-DO8, DI1-DI8, etc.
      if (currentSection && (colB.indexOf('UO') >= 0 || colB.indexOf('UI') >= 0 || colB.indexOf('DO') >= 0 || colB.indexOf('DI') >= 0)) {
        var pinName = colB
        // For module pins, prefix with module slot if not already prefixed
        if (currentSection.indexOf('M') === 0 && pinName.indexOf('M') < 0) {
          pinName = currentSection.split('-')[0] + '-' + pinName
        }

        var pdesc = up(String(prow[4] || ''))

        pins.push({
          section: currentSection.indexOf('M') === 0 ? currentSection.split('-')[0] : 'CONTROLLER',
          sectionLabel: currentSectionLabel,
          pin: pinName,
          pinType: currentSection.indexOf('O') >= 0 ? 'OUTPUT' : 'INPUT',
          com: up(String(prow[2] || '')),
          system: up(String(prow[3] || '')),
          pointDescription: pdesc || 'SPARE',
          objectInstance: up(String(prow[5] || '')),
          cableNumber: up(String(prow[6] || '')),
          cableDescription: up(String(prow[7] || '')),
          sensorMCC: up(String(prow[8] || '')),
          linkedPointId: null
        })
      }
    }

    if (pins.length > 0) {
      terminationData[panelId] = {
        controller: controllerModel,
        modules: detectedModules,
        pins: pins,
        sheetName: sn
      }
    }
  })

  var termPanelCount = Object.keys(terminationData).length

  return {
    docType: DOC_TYPES.DDC_TERMINATION,
    docLabel: 'DDC TERMINATION SHEET',
    sheetName: schedSheet,
    panelUpdates: panelUpdates,
    newPanels: newPanels,
    terminationData: terminationData,
    termPanelCount: termPanelCount,
    warnings: warnings,
    totalSheets: wb.SheetNames.length,
    target: 'panels'
  }
}

// ─── FCU Schedule Parser ─────────────────────────────────────────
function parseFCUSchedule(wb, existingAreas) {
  var sheetName = null
  wb.SheetNames.forEach(function(n) {
    if (n.toUpperCase().indexOf('FCU') >= 0 || n.toUpperCase().indexOf('TRACKER') >= 0) sheetName = n
  })
  if (!sheetName) sheetName = wb.SheetNames[wb.SheetNames.length - 1]
  var ws = wb.Sheets[sheetName]
  var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  var devices = [], areaList = [], skipped = [], warnings = []
  var devCounter = 1, currentFloor = '', floorAbbr = '', currentZone = '', zoneDevCount = 0, isSpecialSection = false

  var existingNames = {}
  existingAreas.forEach(function(a) { existingNames[up(a.name)] = true })

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r]
    var c0 = up(String(row[0] || '')), c1 = up(String(row[1] || ''))

    if (c0.indexOf('GROUND') >= 0) { currentFloor = 'GROUND FLOOR'; floorAbbr = 'GF'; isSpecialSection = false; currentZone = ''; continue }
    if (c0.indexOf('FIRST') >= 0) { currentFloor = 'FIRST FLOOR'; floorAbbr = 'FF'; isSpecialSection = false; currentZone = ''; continue }
    if (c0.indexOf('SECOND') >= 0) { currentFloor = 'SECOND FLOOR'; floorAbbr = 'SF'; isSpecialSection = false; currentZone = ''; continue }
    if (c0.indexOf('ROOF') >= 0) { currentFloor = 'ROOF'; floorAbbr = 'RF'; isSpecialSection = true; currentZone = ''; continue }
    if (c0 === 'EXTERNAL') { currentFloor = 'EXTERNAL'; floorAbbr = 'EX'; isSpecialSection = true; currentZone = ''; continue }
    if (c0 === 'ZONE' || c0 === 'LOCATION' || c0 === 'SR. NO.') continue
    if (c1.indexOf('TOTAL') >= 0) {
      var et = parseInt(row[2]) || 0
      if (et > 0 && zoneDevCount > 0 && zoneDevCount !== et) warnings.push(floorAbbr + ' Z' + currentZone + ': EXPECTED ' + et + ' BUT PARSED ' + zoneDevCount)
      zoneDevCount = 0; continue
    }
    if (c0.indexOf('TOTAL') >= 0 || c0.indexOf('GRAND') >= 0) continue
    if (c0 === 'GF' || c0 === 'FF' || c0 === 'SF' || c0 === 'RF' || c0 === 'EX') continue
    if (c0 === 'BMS' || c0 === 'DDC PANEL SCHEDULE') continue
    if (!currentFloor) continue

    var qtyRaw = up(String(row[2] || ''))
    if (qtyRaw === 'N/A' || qtyRaw === 'NA' || qtyRaw === '') continue
    var qty = parseInt(qtyRaw)
    if (!qty || qty <= 0 || isNaN(qty)) continue

    var commDone = parseInt(row[3]) || 0, ccDone = parseInt(row[4]) || 0, termDone = parseInt(row[5]) || 0
    var remarks = up(String(row[6] || ''))
    var areaName = ''
    if (isSpecialSection) { areaName = floorAbbr + ' - ' + c0 }
    else {
      if (c0 && !isNaN(parseInt(c0))) currentZone = c0
      var zone = currentZone, part = c1 || ''
      if (!zone && !part) continue
      part = part.replace(/\s*-\s*/g, '-').replace('PART', 'P').trim()
      areaName = floorAbbr + ' - Z' + zone + ' - ' + part
    }
    if (existingNames[areaName]) { skipped.push(areaName + ' (' + qty + ' DEVICES)'); continue }

    var areaId = gid('area'), areaDevIds = []
    for (var d = 0; d < qty; d++) {
      var devId = gid('dev'), num = devCounter++
      var tag = 'FCU-' + floorAbbr + '-' + String(num).padStart(3, '0')
      var hasComm = d < commDone, hasCtrl = d < ccDone, hasCont = hasComm && hasCtrl, hasTerm = d < termDone && hasCont
      devices.push({ id: devId, device_type: 'FCU THERMOSTAT', tag: tag, room_name: '', address: '',
        comm_cable: hasComm, control_cable: hasCtrl, continuity: hasCont, termination: hasTerm,
        device_installed: false, address_set: false, remarks: d === 0 && remarks ? remarks : '' })
      areaDevIds.push(devId)
    }
    zoneDevCount += qty; existingNames[areaName] = true
    areaList.push({ id: areaId, name: areaName, device_ids: areaDevIds })
  }

  return { docType: DOC_TYPES.FCU_SCHEDULE, docLabel: 'FCU SCHEDULE', sheetName: sheetName,
    devices: devices, areas: areaList, skipped: skipped, warnings: warnings, target: 'field-devices' }
}

// ─── VAV Schedule Parser (same structure as FCU) ─────────────────
function parseVAVSchedule(wb, existingAreas) {
  var result = parseFCUSchedule(wb, existingAreas)
  // Rebrand as VAV
  result.docType = DOC_TYPES.VAV_SCHEDULE
  result.docLabel = 'VAV SCHEDULE'
  result.devices.forEach(function(d) {
    d.device_type = 'VAV CONTROLLER'
    d.tag = d.tag.replace('FCU-', 'VAV-')
  })
  return result
}

// ─── Main entry point ─────────────────────────────────────────────
function smartParse(file, context, cb) {
  var reader = new FileReader()
  reader.onload = function(e) {
    var XLSX = window.XLSX
    if (!XLSX) { alert('SHEETJS NOT LOADED'); return }
    var wb = XLSX.read(e.target.result, { type: 'array' })
    var detection = detectDocType(wb)
    var result = null

    if (detection.type === DOC_TYPES.FCU_SCHEDULE) {
      result = parseFCUSchedule(wb, context.areas || [])
    } else if (detection.type === DOC_TYPES.VAV_SCHEDULE) {
      result = parseVAVSchedule(wb, context.areas || [])
    } else if (detection.type === DOC_TYPES.IO_LIST) {
      result = parseIOList(wb, context.panels || [], context.equipmentMap || {})
    } else if (detection.type === DOC_TYPES.DDC_TERMINATION) {
      result = parseDDCTermination(wb, context.panels || [])
    } else {
      result = { docType: DOC_TYPES.UNKNOWN, docLabel: 'UNKNOWN DOCUMENT', sheetName: wb.SheetNames[0],
        sheetNames: wb.SheetNames, warnings: ['COULD NOT DETECT DOCUMENT TYPE. SHEETS: ' + wb.SheetNames.join(', ')] }
    }
    result.fileName = file.name
    result.detection = detection
    cb(result)
  }
  reader.readAsArrayBuffer(file)
}

export { smartParse, DOC_TYPES, DOC_LABELS }
