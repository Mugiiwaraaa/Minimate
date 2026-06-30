// Minimate Smart Parser v0.2
// Multi-sheet aware: scans each sheet independently, merges results
// Detects: DDC Panel Schedule, FCU/VAV Tracker, IO List, DDC Termination (per-panel pins)

var DOC_TYPES = {
  FCU_SCHEDULE: 'FCU_SCHEDULE',
  VAV_SCHEDULE: 'VAV_SCHEDULE',
  IO_LIST: 'IO_LIST',
  DDC_TERMINATION: 'DDC_TERMINATION',
  DDC_PANEL_SCHEDULE: 'DDC_PANEL_SCHEDULE',
  COMBINED: 'COMBINED',
  UNKNOWN: 'UNKNOWN'
}

var DOC_LABELS = {}
DOC_LABELS[DOC_TYPES.FCU_SCHEDULE] = 'FCU SCHEDULE'
DOC_LABELS[DOC_TYPES.VAV_SCHEDULE] = 'VAV SCHEDULE'
DOC_LABELS[DOC_TYPES.IO_LIST] = 'IO LIST'
DOC_LABELS[DOC_TYPES.DDC_TERMINATION] = 'DDC TERMINATION SHEET'
DOC_LABELS[DOC_TYPES.DDC_PANEL_SCHEDULE] = 'DDC PANEL SCHEDULE'
DOC_LABELS[DOC_TYPES.COMBINED] = 'COMBINED IMPORT'
DOC_LABELS[DOC_TYPES.UNKNOWN] = 'UNKNOWN DOCUMENT'

var _idCounters = { panel: 200, eq: 300, pt: 400, area: 500, dev: 1000 }
function gid(prefix) { return prefix + '-' + (_idCounters[prefix]++) }

function panelSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function up(v) { return (v || '').toUpperCase().trim() }

// Strip non-ASCII characters (handles Arabic diacriticals in sheet names)
function cleanStr(s) { return (s || '').replace(/[^\x00-\x7F]/g, '').trim() }

// ─── Per-sheet type detection ─────────────────────────────────────
function detectSheetType(wb, sheetName) {
  var ws = wb.Sheets[sheetName]
  if (!ws) return 'SKIP'
  var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  if (!rows || rows.length < 2) return 'SKIP'

  // Collect headers from first 15 rows
  var headers = []
  for (var r = 0; r < Math.min(rows.length, 15); r++) {
    for (var c = 0; c < Math.min((rows[r] || []).length, 30); c++) {
      headers.push(up(String(rows[r][c] || '')))
    }
  }
  var joined = headers.join(' ')
  var nameUp = up(cleanStr(sheetName))

  // Score each type
  var scores = { DDC_PANEL_SCHEDULE: 0, FCU_SCHEDULE: 0, VAV_SCHEDULE: 0, IO_LIST: 0, DDC_TERM_DETAIL: 0 }

  // ── DDC Panel Schedule (overview sheet with panel names, locations, zones)
  if (joined.indexOf('DDC PANEL SCHEDULE') >= 0) scores.DDC_PANEL_SCHEDULE += 8
  if (joined.indexOf('PANEL NAME') >= 0) scores.DDC_PANEL_SCHEDULE += 5
  if (joined.indexOf('CABLE PULLING') >= 0 && joined.indexOf('PANEL TERMINATION') >= 0) scores.DDC_PANEL_SCHEDULE += 4
  if (joined.indexOf('DDC INSTALLATION') >= 0) scores.DDC_PANEL_SCHEDULE += 3
  if (joined.indexOf('MOUNTING') >= 0 && joined.indexOf('CANOPY') >= 0) scores.DDC_PANEL_SCHEDULE += 2
  if (nameUp.indexOf('BMS') >= 0 || nameUp.indexOf('DDC') >= 0) scores.DDC_PANEL_SCHEDULE += 2

  // ── FCU Tracker
  if (nameUp.indexOf('FCU') >= 0 || nameUp.indexOf('TRACKER') >= 0) scores.FCU_SCHEDULE += 5
  if (joined.indexOf('FCU QTY') >= 0 || joined.indexOf('FCU QUANTITY') >= 0) scores.FCU_SCHEDULE += 6
  if (joined.indexOf('COMMUNICATION LOOP') >= 0 || joined.indexOf('COMM LOOP') >= 0) scores.FCU_SCHEDULE += 4
  if (joined.indexOf('CONTROL CABLE') >= 0 && joined.indexOf('TERMINATION') >= 0) scores.FCU_SCHEDULE += 3
  if (joined.indexOf('BALANCE CL') >= 0 || joined.indexOf('BALANCE CC') >= 0) scores.FCU_SCHEDULE += 4
  if (joined.indexOf('GROUND FLOOR') >= 0 && joined.indexOf('ZONE') >= 0 && joined.indexOf('PART') >= 0) scores.FCU_SCHEDULE += 3
  if (joined.indexOf('FAN COIL') >= 0) scores.FCU_SCHEDULE += 3

  // ── VAV Schedule
  if (nameUp.indexOf('VAV') >= 0) scores.VAV_SCHEDULE += 6
  if (joined.indexOf('VAV') >= 0 && joined.indexOf('QTY') >= 0) scores.VAV_SCHEDULE += 5

  // ── IO List
  if (joined.indexOf('IO LIST') >= 0 || joined.indexOf('I/O LIST') >= 0 || joined.indexOf('IO POINT') >= 0) scores.IO_LIST += 7
  if (joined.indexOf('IO SCHEDULE') >= 0 || joined.indexOf('I/O SCHEDULE') >= 0 || joined.indexOf('POINT SCHEDULE') >= 0) scores.IO_LIST += 7
  if (joined.indexOf('LOCATION OF EQUIPMENT') >= 0) scores.IO_LIST += 5
  if (joined.indexOf('DIGITAL INPUT') >= 0 || joined.indexOf('ANALOG') >= 0) scores.IO_LIST += 3
  if (joined.indexOf('DI-HARDWARE') >= 0 || joined.indexOf('DO-HARDWARE') >= 0) scores.IO_LIST += 5
  if (joined.indexOf('REQUIRED POINTS') >= 0) scores.IO_LIST += 4

  // ── DDC per-panel termination detail (sheet named like DDC-GF-01)
  if (nameUp.indexOf('DDC-') >= 0) scores.DDC_TERM_DETAIL += 6
  if (joined.indexOf('UNIVERSAL OUTPUT') >= 0 || joined.indexOf('UNIVERSAL INPUT') >= 0) scores.DDC_TERM_DETAIL += 5
  if (joined.indexOf('CONTROLLER') >= 0 && (joined.indexOf('ME52') >= 0 || joined.indexOf('BACNET') >= 0)) scores.DDC_TERM_DETAIL += 3

  // Pick the winner — minimum threshold of 5
  var best = 'SKIP'
  var bestScore = 4
  Object.keys(scores).forEach(function(k) {
    if (scores[k] > bestScore) { bestScore = scores[k]; best = k }
  })

  return best
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
  var first = parts[0]
  var prefixMatch = first.match(/^(.*?[\-\/\s])(\d+.*)$/)
  if (!prefixMatch) {
    return parts.filter(function(p) { return p.length > 0 })
  }
  var prefix = prefixMatch[1]
  var tags = [first]
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i].trim()
    if (!p) continue
    if (/^\d+/.test(p) && p.indexOf('-') < 0 && p.length < first.length) {
      tags.push(prefix + p)
    } else {
      tags.push(p)
    }
  }
  return tags
}

// ─── IO List Parser ──────────────────────────────────────────────
function parseIOList(wb, sheetName, existingPanels, existingEquipMap) {
  var ws = wb.Sheets[sheetName]
  var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  var panels = []
  var equipMap = {}
  var warnings = []
  var skipped = []
  var updated = []

  var existingByName = {}
  existingPanels.forEach(function(p) { existingByName[up(p.name)] = p })

  var currentPanel = null
  var currentPanelId = null
  var currentEquipList = []
  var currentGroup = null
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

    if (c1.indexOf('DDC-') === 0) {
      flushGroup()
      if (currentPanel && currentEquipList.length > 0) {
        equipMap[currentPanelId] = currentEquipList
      }

      var panelStr = c1
      var panelName = panelStr
      var panelLocation = ''
      var parenIdx = panelStr.indexOf('(')
      if (parenIdx >= 0) {
        panelName = panelStr.substring(0, parenIdx).trim()
        panelLocation = panelStr.substring(parenIdx + 1).replace(/\)$/, '').trim()
      }

      var floorMatch = panelName.match(/DDC-([A-Z]+)-/)
      var panelFloor = floorMatch ? floorMatch[1] : ''

      var existing = existingByName[panelName]
      if (existing) {
        currentPanelId = existing.id
        currentPanel = existing
        updated.push(panelName)
      } else {
        currentPanelId = panelSlug(panelName)
        currentPanel = { id: currentPanelId, name: panelName, location: panelLocation, floor: panelFloor }
        panels.push(currentPanel)
      }
      currentEquipList = []
      currentGroup = null
      r++
      continue
    }

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

    if (c0 === 'QTY' || c1 === 'LOCATION OF EQUIPMENT' || c1 === 'START FROM HERE') { r++; continue }

    if (currentPanel) {
      var qty = parseInt(c0)
      if (qty > 0 && c1 && c1.indexOf('DI-') < 0 && c1.indexOf('DO-') < 0) {
        flushGroup()
        currentGroup = { name: c1, qty: qty, idsStr: '', pointRows: [] }
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
            r++
          }
        }
        r++
        continue
      }

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

  flushGroup()
  if (currentPanel && currentEquipList.length > 0) {
    equipMap[currentPanelId] = currentEquipList
  }

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

// ─── DDC Panel Schedule Parser (overview with panel names) ───────
function parseDDCPanelSchedule(wb, sheetName, existingPanels) {
  var ws = wb.Sheets[sheetName]
  var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  var panelUpdates = []
  var warnings = []
  var newPanels = []

  var existingByName = {}
  existingPanels.forEach(function(p) { existingByName[up(p.name)] = p })

  // Find header row — scan for PANEL NAME column
  var headerRow = -1
  var colMap = {}
  for (var r = 0; r < Math.min(rows.length, 15); r++) {
    var row = rows[r]
    for (var c = 0; c < (row || []).length; c++) {
      var v = up(String(row[c] || ''))
      if (v === 'PANEL NAME' || v === 'PANEL') { colMap.name = c; headerRow = r }
      if (v === 'LOCATION') colMap.location = c
      if (v === 'LEVEL' || v === 'FLOOR') colMap.level = c
      if (v === 'ZONE') colMap.zone = c
      if (v === 'PART') colMap.part = c
      if (v.indexOf('SR') >= 0 && v.indexOf('NO') >= 0) colMap.srno = c
      if (v.indexOf('ENCLOSURE') >= 0) colMap.enclosure = c
      if (v.indexOf('ASSEMBLED') >= 0) colMap.assembled = c
      if (v === 'REMARKS') colMap.remarks = c
      if (v.indexOf('DDC INSTALLATION') >= 0 || v.indexOf('DDC INST') >= 0) colMap.ddcInstall = c
      if (v.indexOf('CABLE PULL') >= 0) colMap.cablePull = c
      if (v.indexOf('PANEL TERMINATION') >= 0) colMap.termination = c
      if (v.indexOf('INSPECTION') >= 0) colMap.inspection = c
      if (v.indexOf('MOUNTING') >= 0) colMap.mounting = c
      if (v.indexOf('CANOPY') >= 0) colMap.canopy = c
      if (v.indexOf('PANEL SIZE') >= 0 || (v === 'SIZE' && colMap.name === undefined)) colMap.size = c
    }
    if (headerRow >= 0) break
  }

  if (headerRow < 0 || colMap.name === undefined) {
    // Fallback: try to find DDC- panel names in any column
    for (var r2 = 0; r2 < rows.length; r2++) {
      var row2 = rows[r2]
      for (var c2 = 0; c2 < (row2 || []).length; c2++) {
        var v2 = up(String(row2[c2] || ''))
        if (v2.indexOf('DDC-') === 0 && v2.length < 20) {
          colMap.name = c2
          headerRow = r2 - 1
          break
        }
      }
      if (colMap.name !== undefined) break
    }
    if (colMap.name === undefined) {
      warnings.push('COULD NOT FIND PANEL NAME COLUMN IN SHEET "' + sheetName + '"')
      return { newPanels: [], panelUpdates: [], warnings: warnings }
    }
  }

  function isCheck(v) {
    var s = String(v || '').trim()
    return s === '✔️' || s === '✔' || s === '✓' || s === 'YES' || s === 'DONE' || s === 'Y' || s === '1' || s === 'TRUE' || s === 'X' || s === 'x' || s.indexOf('✔') >= 0
  }

  var currentLevel = ''
  for (var r3 = headerRow + 1; r3 < rows.length; r3++) {
    var dr = rows[r3]
    var pName = up(String(dr[colMap.name] || ''))
    if (!pName || pName.indexOf('DDC-') < 0) continue

    // Carry forward level for merged cells
    if (colMap.level !== undefined) {
      var lvl = up(String(dr[colMap.level] || ''))
      if (lvl) currentLevel = lvl
    }

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

    // Extract floor from panel name if not from column
    var floorFromName = ''
    var fm = pName.match(/DDC-([A-Z]+)-/)
    if (fm) floorFromName = fm[1]

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
      newPanels.push({
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
      })
    }
  }

  return { newPanels: newPanels, panelUpdates: panelUpdates, warnings: warnings }
}

// ─── DDC Termination Sheet Parser (per-panel pin detail) ─────────
function parseDDCTerminationSheets(wb, sheetNames, allPanelIds) {
  var terminationData = {}
  var warnings = []

  sheetNames.forEach(function(sn) {
    var pws = wb.Sheets[sn]
    var prows = window.XLSX.utils.sheet_to_json(pws, { header: 1, defval: '' })
    if (prows.length < 5) return

    var sheetPanelName = up(String(prows[0][0] || sn))
    var pnMatch = sheetPanelName.match(/(DDC-[A-Z]+-\d+)/)
    if (pnMatch) sheetPanelName = pnMatch[1]

    var panelId = allPanelIds[sheetPanelName]
    if (!panelId) {
      var snMatch = up(cleanStr(sn)).match(/(DDC-[A-Z]+-\d+)/)
      if (snMatch) panelId = allPanelIds[snMatch[1]]
    }
    if (!panelId) { warnings.push('COULD NOT MATCH SHEET "' + sn + '" TO A PANEL'); return }

    var controllerModel = 'ME521'
    for (var cr = 0; cr < Math.min(prows.length, 5); cr++) {
      var cRow = prows[cr]
      for (var cc = 0; cc < (cRow || []).length; cc++) {
        var cv = up(String(cRow[cc] || ''))
        if (cv.indexOf('ME521') >= 0) controllerModel = 'ME521'
        if (cv.indexOf('ME520') >= 0) controllerModel = 'ME520'
      }
    }

    var pins = []
    var currentSection = ''
    var currentSectionLabel = ''
    var currentModuleSlot = 0
    var detectedModules = []

    for (var pr = 0; pr < prows.length; pr++) {
      var prow = prows[pr]
      var colB = up(String(prow[1] || ''))
      var colD = up(String(prow[3] || ''))

      if (colB.indexOf('MODULE') >= 0 && colB.indexOf('FBM') >= 0) {
        var slotMatch = colB.match(/\((\d+)\)/)
        currentModuleSlot = slotMatch ? parseInt(slotMatch[1]) : (currentModuleSlot + 1)
        if (colB.indexOf('16I') >= 0 || colB.indexOf('16UI') >= 0) {
          detectedModules.push({ slot: currentModuleSlot, type: 'FB16UI' })
        } else if (colB.indexOf('8I8O') >= 0) {
          detectedModules.push({ slot: currentModuleSlot, type: 'FB8I8O' })
        }
        continue
      }

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

      if (colB === 'PIN' || colB === 'COM' || colB === '') continue
      if (colB.indexOf('CONTROLLER') >= 0 || colB.indexOf('BMS') >= 0 || colB.indexOf('BACNET') >= 0 || colB.indexOf('IP') >= 0) continue

      if (currentSection && (colB.indexOf('UO') >= 0 || colB.indexOf('UI') >= 0 || colB.indexOf('DO') >= 0 || colB.indexOf('DI') >= 0)) {
        var pinName = colB
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

  return { terminationData: terminationData, warnings: warnings }
}

// ─── FCU Schedule Parser ─────────────────────────────────────────
function parseFCUSchedule(wb, sheetName, existingAreas) {
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

// ─── Main entry point ─────────────────────────────────────────────
function smartParse(file, context, cb) {
  var reader = new FileReader()
  reader.onload = function(e) {
    var XLSX = window.XLSX
    if (!XLSX) { alert('SHEETJS NOT LOADED'); return }
    var wb = XLSX.read(e.target.result, { type: 'array' })

    // Step 1: Classify each sheet
    var sheetTypes = {}
    var typeLists = { DDC_PANEL_SCHEDULE: [], FCU_SCHEDULE: [], VAV_SCHEDULE: [], IO_LIST: [], DDC_TERM_DETAIL: [] }
    wb.SheetNames.forEach(function(sn) {
      var t = detectSheetType(wb, sn)
      sheetTypes[sn] = t
      if (typeLists[t]) typeLists[t].push(sn)
    })

    // Step 2: Parse each type found
    var panelResult = null
    var fcuResult = null
    var ioResult = null
    var termResult = null
    var allWarnings = []
    var foundTypes = []

    // ── DDC Panel Schedule sheets
    if (typeLists.DDC_PANEL_SCHEDULE.length > 0) {
      panelResult = parseDDCPanelSchedule(wb, typeLists.DDC_PANEL_SCHEDULE[0], context.panels || [])
      if (panelResult.newPanels.length > 0 || panelResult.panelUpdates.length > 0) {
        foundTypes.push('DDC_PANEL_SCHEDULE')
      }
      allWarnings = allWarnings.concat(panelResult.warnings)
    }

    // ── IO List sheets
    if (typeLists.IO_LIST.length > 0) {
      // Prefer "As per Site" or "Latest" or "Revised" variant
      var ioSheet = typeLists.IO_LIST[0]
      typeLists.IO_LIST.forEach(function(n) {
        var u = n.toUpperCase()
        if (u.indexOf('SITE') >= 0 || u.indexOf('LATEST') >= 0 || u.indexOf('REVISED') >= 0) ioSheet = n
      })
      ioResult = parseIOList(wb, ioSheet, context.panels || [], context.equipmentMap || {})
      if (ioResult.panels.length > 0 || Object.keys(ioResult.equipMap).length > 0) {
        foundTypes.push('IO_LIST')
      }
      allWarnings = allWarnings.concat(ioResult.warnings)
    }

    // ── FCU/VAV Tracker sheets
    if (typeLists.FCU_SCHEDULE.length > 0) {
      fcuResult = parseFCUSchedule(wb, typeLists.FCU_SCHEDULE[0], context.areas || [])
      if (fcuResult.devices.length > 0) {
        foundTypes.push('FCU_SCHEDULE')
      }
      allWarnings = allWarnings.concat(fcuResult.warnings)
    } else if (typeLists.VAV_SCHEDULE.length > 0) {
      fcuResult = parseFCUSchedule(wb, typeLists.VAV_SCHEDULE[0], context.areas || [])
      fcuResult.docType = DOC_TYPES.VAV_SCHEDULE
      fcuResult.docLabel = 'VAV SCHEDULE'
      fcuResult.devices.forEach(function(d) {
        d.device_type = 'VAV CONTROLLER'
        d.tag = d.tag.replace('FCU-', 'VAV-')
      })
      if (fcuResult.devices.length > 0) {
        foundTypes.push('VAV_SCHEDULE')
      }
      allWarnings = allWarnings.concat(fcuResult.warnings)
    }

    // ── DDC per-panel termination detail sheets
    if (typeLists.DDC_TERM_DETAIL.length > 0) {
      // Build panel ID lookup from existing + newly parsed panels
      var allPanelIds = {}
      ;(context.panels || []).forEach(function(p) { allPanelIds[up(p.name)] = p.id })
      if (panelResult) {
        panelResult.newPanels.forEach(function(p) { allPanelIds[up(p.name)] = p.id })
      }
      if (ioResult) {
        ioResult.panels.forEach(function(p) { allPanelIds[up(p.name)] = p.id })
      }
      termResult = parseDDCTerminationSheets(wb, typeLists.DDC_TERM_DETAIL, allPanelIds)
      if (Object.keys(termResult.terminationData).length > 0) {
        foundTypes.push('DDC_TERMINATION')
      }
      allWarnings = allWarnings.concat(termResult.warnings)
    }

    // Step 3: Build result
    var result = null

    if (foundTypes.length === 0) {
      // Nothing useful found
      result = {
        docType: DOC_TYPES.UNKNOWN,
        docLabel: 'UNKNOWN DOCUMENT',
        sheetName: wb.SheetNames[0],
        sheetNames: wb.SheetNames,
        warnings: allWarnings.length > 0 ? allWarnings : ['COULD NOT DETECT ANY USEFUL DATA. SHEETS: ' + wb.SheetNames.join(', ')]
      }
    } else if (foundTypes.length === 1) {
      // Single type — return in the original format for backward compatibility
      var ft = foundTypes[0]
      if (ft === 'DDC_PANEL_SCHEDULE') {
        result = {
          docType: DOC_TYPES.DDC_TERMINATION,
          docLabel: 'DDC PANEL SCHEDULE',
          sheetName: typeLists.DDC_PANEL_SCHEDULE[0],
          panelUpdates: panelResult.panelUpdates,
          newPanels: panelResult.newPanels,
          terminationData: termResult ? termResult.terminationData : {},
          termPanelCount: termResult ? Object.keys(termResult.terminationData).length : 0,
          warnings: allWarnings,
          totalSheets: wb.SheetNames.length,
          target: 'panels'
        }
      } else if (ft === 'IO_LIST') {
        result = ioResult
        result.warnings = allWarnings
      } else if (ft === 'FCU_SCHEDULE' || ft === 'VAV_SCHEDULE') {
        result = fcuResult
        result.warnings = allWarnings
      } else if (ft === 'DDC_TERMINATION') {
        result = {
          docType: DOC_TYPES.DDC_TERMINATION,
          docLabel: 'DDC TERMINATION SHEET',
          sheetName: wb.SheetNames[0],
          panelUpdates: [],
          newPanels: [],
          terminationData: termResult.terminationData,
          termPanelCount: Object.keys(termResult.terminationData).length,
          warnings: allWarnings,
          totalSheets: wb.SheetNames.length,
          target: 'panels'
        }
      }
    } else {
      // Multiple types found — COMBINED result
      result = {
        docType: DOC_TYPES.COMBINED,
        docLabel: 'COMBINED IMPORT',
        sheetName: wb.SheetNames[0],
        foundTypes: foundTypes,
        warnings: allWarnings,
        totalSheets: wb.SheetNames.length,
        // Panel data (from DDC panel schedule or IO list)
        newPanels: [],
        panelUpdates: [],
        panels: [],
        equipMap: {},
        totalPoints: 0,
        totalEquipment: 0,
        // Termination data
        terminationData: {},
        termPanelCount: 0,
        // Field device data
        devices: [],
        areas: [],
        target: 'combined'
      }

      if (panelResult) {
        result.newPanels = panelResult.newPanels
        result.panelUpdates = panelResult.panelUpdates
      }
      if (ioResult) {
        result.panels = ioResult.panels
        result.equipMap = ioResult.equipMap
        result.totalPoints = ioResult.totalPoints
        result.totalEquipment = ioResult.totalEquipment
        // If IO list also created panels and we have no panel schedule panels, use those
        if (result.newPanels.length === 0 && ioResult.panels.length > 0) {
          result.newPanels = ioResult.panels
        }
      }
      if (termResult) {
        result.terminationData = termResult.terminationData
        result.termPanelCount = Object.keys(termResult.terminationData).length
      }
      if (fcuResult) {
        result.devices = fcuResult.devices
        result.areas = fcuResult.areas
      }
    }

    result.fileName = file.name
    result.detection = { sheetTypes: sheetTypes, foundTypes: foundTypes }
    cb(result)
  }
  reader.readAsArrayBuffer(file)
}

export { smartParse, DOC_TYPES, DOC_LABELS }
