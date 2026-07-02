/* --- importEngine.js --- Unified Drawing Import Orchestrator ---
   One import session takes ANY mix of files:
     CAD_PDF        - clean CAD file with text layer (tags + rooms source)
     MARKED_SCAN    - scanned PDF of supervisor-marked sheets (no text layer)
     MARKED_PHOTO   - full-sheet photo of a marked drawing
     PHOTO_SEQUENCE - ordered zoomed photos following ONE loop
   Classification is a hint - the user can override per file in the modal. */

import { analyzeCadPdf } from './analyzers/cadPdf'
import { analyzePhoto, analyzePhotoBase64 } from './analyzers/photo'
import { analyzeSequence } from './analyzers/sequence'

var FILE_KINDS = {
  CAD_PDF: 'CAD_PDF',
  MARKED_SCAN: 'MARKED_SCAN',
  MARKED_PHOTO: 'MARKED_PHOTO',
  PHOTO_SEQUENCE: 'PHOTO_SEQUENCE'
}

var KIND_LABELS = {
  CAD_PDF: 'CAD PDF',
  MARKED_SCAN: 'MARKED SCAN',
  MARKED_PHOTO: 'MARKED PHOTO',
  PHOTO_SEQUENCE: 'LOOP PHOTO SEQ'
}

/* Kinds a file can be toggled between in the UI, by underlying type */
var PDF_KIND_CYCLE = ['CAD_PDF', 'MARKED_SCAN']
var IMAGE_KIND_CYCLE = ['MARKED_PHOTO', 'PHOTO_SEQUENCE']

function isPdf(file) {
  return (file.type === 'application/pdf') || /\.pdf$/i.test(file.name || '')
}

/* ================================================================
   CLASSIFICATION - text layer check via PDF.js (already CDN-loaded)
   ================================================================ */

function classifyFile(file) {
  if (!isPdf(file)) {
    // Images default to MARKED_PHOTO; App upgrades 2+ images to sequence
    return Promise.resolve(FILE_KINDS.MARKED_PHOTO)
  }
  if (!window.pdfjsLib) return Promise.resolve(FILE_KINDS.CAD_PDF)

  return new Promise(function(resolve) {
    var reader = new FileReader()
    reader.onload = function() {
      var loadTask = window.pdfjsLib.getDocument({ data: reader.result })
      loadTask.promise.then(function(pdf) {
        return pdf.getPage(1).then(function(page) {
          return page.getTextContent()
        })
      }).then(function(content) {
        var items = (content && content.items) || []
        // A real CAD export has hundreds of text items on page 1.
        // A scanner-produced PDF has none (or a handful of metadata strings).
        resolve(items.length >= 25 ? FILE_KINDS.CAD_PDF : FILE_KINDS.MARKED_SCAN)
      }).catch(function() {
        resolve(FILE_KINDS.CAD_PDF) // unreadable? let user override
      })
    }
    reader.onerror = function() { resolve(FILE_KINDS.CAD_PDF) }
    reader.readAsArrayBuffer(file)
  })
}

/* ================================================================
   RASTERIZE - scanned PDF pages -> JPEG base64 for the photo pipeline
   ================================================================ */

function rasterizePdfPages(file, maxDim, onProgress) {
  maxDim = maxDim || 3000
  if (!window.pdfjsLib) return Promise.reject(new Error('PDF.JS NOT LOADED'))

  return new Promise(function(resolve, reject) {
    var reader = new FileReader()
    reader.onload = function() {
      var loadTask = window.pdfjsLib.getDocument({ data: reader.result })
      loadTask.promise.then(function(pdf) {
        var pages = []
        function renderPage(i) {
          if (i > pdf.numPages) { resolve(pages); return }
          if (onProgress) onProgress('Rasterizing page ' + i + '/' + pdf.numPages + '...')
          pdf.getPage(i).then(function(page) {
            var vp1 = page.getViewport({ scale: 1 })
            var scale = Math.min(maxDim / vp1.width, maxDim / vp1.height)
            if (scale > 4) scale = 4
            var vp = page.getViewport({ scale: scale })
            var canvas = document.createElement('canvas')
            canvas.width = Math.round(vp.width)
            canvas.height = Math.round(vp.height)
            var ctx = canvas.getContext('2d')
            page.render({ canvasContext: ctx, viewport: vp }).promise.then(function() {
              var dataUrl = canvas.toDataURL('image/jpeg', 0.85)
              pages.push({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', pageNum: i })
              renderPage(i + 1)
            }).catch(reject)
          }).catch(reject)
        }
        renderPage(1)
      }).catch(reject)
    }
    reader.onerror = function() { reject(new Error('Failed to read PDF')) }
    reader.readAsArrayBuffer(file)
  })
}

/* ================================================================
   MERGE - combine all analyzer outputs into one preview result
   (evolution of drawingParser.js combineResults)
   ================================================================ */

function cleanTag(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

function mergeResults(cadResults, loopResults, onProgress) {
  if (onProgress) onProgress('Combining results from all files...')

  // 1. Device info from ALL CAD PDFs: tag -> {room, thermostat}
  var deviceInfo = {}
  var totalCadDevices = 0
  var totalRooms = 0
  var floorLabel = ''
  cadResults.forEach(function(r) {
    totalCadDevices += (r.devices || []).length
    totalRooms += (r.rooms || []).length
    if (!floorLabel && r.floor) floorLabel = r.floor
    ;(r.devices || []).forEach(function(d) {
      var tag = cleanTag(d.tag)
      if (tag) deviceInfo[tag] = { room: d.room || '', thermostat: d.thermostat || '' }
    })
  })

  // 2. Loops from ALL marked sources, renaming collisions
  var rawLoops = []
  var seenIds = {}
  var ddcPanels = []
  var annotations = []
  loopResults.forEach(function(r) {
    if (!floorLabel && r.floor) floorLabel = r.floor
    ;(r.ddc_panels || []).forEach(function(p) {
      if (p && ddcPanels.indexOf(p) < 0) ddcPanels.push(p)
    })
    annotations = annotations.concat(r.annotations || [])
    ;(r.loops || []).forEach(function(loop) {
      var id = loop.loop_id || loop.loopid || 'LOOP-?'
      var unique = id
      var n = 2
      while (seenIds[unique]) { unique = id + '-' + n; n++ }
      seenIds[unique] = true
      rawLoops.push(Object.assign({}, loop, { loop_id: unique }))
    })
  })

  // 3. Enrich loop devices with CAD info (CAD room wins; sequence-photo room is fallback)
  var enrichedLoops = rawLoops.map(function(loop) {
    var rawDevices = loop.devices || []
    if (rawDevices.length > 32) {
      console.warn('[IMPORT] Loop ' + loop.loop_id + ' has ' + rawDevices.length + ' devices - capping at 32')
      rawDevices = rawDevices.slice(0, 32)
    }
    var photoRooms = loop.rooms || {}

    var loopDevices = rawDevices.map(function(rawTag) {
      var tag = cleanTag(rawTag)
      var info = deviceInfo[tag] || {}

      // Fuzzy match if no exact match and not a MARKER placeholder
      if (!info.room && tag.indexOf('MARKER') < 0 && tag !== 'UNREADABLE') {
        Object.keys(deviceInfo).forEach(function(k) {
          if (k.indexOf(tag) >= 0 || tag.indexOf(k) >= 0) info = deviceInfo[k]
        })
      }

      return {
        tag: tag,
        room: info.room || photoRooms[tag] || '',
        thermostat: info.thermostat || ''
      }
    })

    return {
      loopId: loop.loop_id,
      color: loop.color || '',
      ddcPanel: loop.ddc_panel || loop.ddcpanel || '',
      devices: loopDevices,
      deviceCount: loopDevices.length
    }
  })

  // 4. CAD devices not placed on any loop -> unmatched (go to UNASSIGNED)
  var matchedTags = {}
  enrichedLoops.forEach(function(l) { l.devices.forEach(function(d) { matchedTags[d.tag] = true }) })
  var unmatchedDevices = []
  Object.keys(deviceInfo).forEach(function(tag) {
    if (!matchedTags[tag] && /^(FCU|VAV|AHU|PAU|ERU)/i.test(tag)) {
      unmatchedDevices.push({ tag: tag, room: deviceInfo[tag].room, thermostat: deviceInfo[tag].thermostat })
    }
  })

  var totalMatched = enrichedLoops.reduce(function(s, l) { return s + l.deviceCount }, 0)
  if (onProgress) onProgress(enrichedLoops.length + ' loops, ' + totalMatched + ' matched, ' + unmatchedDevices.length + ' unmatched')

  return {
    loops: enrichedLoops,
    ddcPanels: ddcPanels,
    annotations: annotations,
    floorLabel: floorLabel,
    pdfStats: { totalDevices: totalCadDevices, totalRooms: totalRooms },
    unmatchedDevices: unmatchedDevices
  }
}

/* ================================================================
   MAIN ENTRY - run one import session
   items: [{ file: File, kind: FILE_KINDS.* }] in UI order
   ================================================================ */

function runImportSession(items, apiKey, onProgress) {
  var progress = onProgress || function() {}
  progress('Starting import: ' + items.length + ' file(s)...')

  var cadItems = items.filter(function(it) { return it.kind === FILE_KINDS.CAD_PDF })
  var scanItems = items.filter(function(it) { return it.kind === FILE_KINDS.MARKED_SCAN })
  var photoItems = items.filter(function(it) { return it.kind === FILE_KINDS.MARKED_PHOTO })
  var seqItems = items.filter(function(it) { return it.kind === FILE_KINDS.PHOTO_SEQUENCE })

  var cadResults = []
  var loopResults = []

  // Sequential processing keeps us under Gemini free-tier rate limits
  function processCad(idx) {
    if (idx >= cadItems.length) return Promise.resolve()
    return analyzeCadPdf(cadItems[idx].file, apiKey, progress).then(function(r) {
      cadResults.push(r)
      return processCad(idx + 1)
    })
  }

  function processScans(idx) {
    if (idx >= scanItems.length) return Promise.resolve()
    var file = scanItems[idx].file
    progress('Scanned drawing: ' + (file.name || '') + '...')
    return rasterizePdfPages(file, 3000, progress).then(function(pages) {
      function processPage(p) {
        if (p >= pages.length) return Promise.resolve()
        progress('Analyzing scanned page ' + (p + 1) + '/' + pages.length + '...')
        return analyzePhotoBase64(pages[p].base64, pages[p].mimeType, apiKey, progress).then(function(r) {
          loopResults.push(r)
          return processPage(p + 1)
        })
      }
      return processPage(0)
    }).then(function() {
      return processScans(idx + 1)
    })
  }

  function processPhotos(idx) {
    if (idx >= photoItems.length) return Promise.resolve()
    return analyzePhoto(photoItems[idx].file, apiKey, progress).then(function(r) {
      loopResults.push(r)
      return processPhotos(idx + 1)
    })
  }

  function processSequence() {
    if (seqItems.length === 0) return Promise.resolve()
    var files = seqItems.map(function(it) { return it.file })
    return analyzeSequence(files, apiKey, progress).then(function(r) {
      loopResults.push(r)
    })
  }

  return processCad(0)
    .then(function() { return processScans(0) })
    .then(function() { return processPhotos(0) })
    .then(function() { return processSequence() })
    .then(function() {
      var combined = mergeResults(cadResults, loopResults, progress)
      combined.sources = {
        cadPdfs: cadItems.length,
        markedScans: scanItems.length,
        markedPhotos: photoItems.length,
        sequencePhotos: seqItems.length
      }
      progress('Import analysis complete!')
      return combined
    })
}

export { FILE_KINDS, KIND_LABELS, PDF_KIND_CYCLE, IMAGE_KIND_CYCLE, isPdf, classifyFile, rasterizePdfPages, runImportSession, mergeResults }
