/* ─── drawingParser.js ─── Shop Drawing Import Engine ─── */
/* Combines digital PDF (OCR → device tags, rooms) with highlighted photo (Gemini → loop routing) */

/* ════════════════════════════════════════════════════════
   1.  PDF TILING + TESSERACT OCR
   ════════════════════════════════════════════════════════ */

function tilePDF(pdfFile, onProgress) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader()
    reader.onload = function() {
      var typedArray = new Uint8Array(reader.result)
      var pdfjsLib = window.pdfjsLib
      if (!pdfjsLib) { reject(new Error('pdf.js not loaded')); return }

      pdfjsLib.getDocument({ data: typedArray }).promise.then(function(pdf) {
        if (onProgress) onProgress('PDF loaded — ' + pdf.numPages + ' page(s)')
        // We process page 1 (drawings are single-page per floor)
        pdf.getPage(1).then(function(page) {
          var scale = 4 // 4x zoom for readable OCR
          var vp = page.getViewport({ scale: scale })
          var canvas = document.createElement('canvas')
          canvas.width = vp.width
          canvas.height = vp.height
          var ctx = canvas.getContext('2d')

          if (onProgress) onProgress('Rendering PDF at ' + scale + 'x zoom (' + vp.width + 'x' + vp.height + ')')

          page.render({ canvasContext: ctx, viewport: vp }).promise.then(function() {
            // Tile the rendered image into chunks for Tesseract
            var tileW = 1200
            var tileH = 1200
            var cols = Math.ceil(vp.width / tileW)
            var rows = Math.ceil(vp.height / tileH)
            var tiles = []

            for (var r = 0; r < rows; r++) {
              for (var c = 0; c < cols; c++) {
                var x = c * tileW
                var y = r * tileH
                var w = Math.min(tileW, vp.width - x)
                var h = Math.min(tileH, vp.height - y)

                var tileCanvas = document.createElement('canvas')
                tileCanvas.width = w
                tileCanvas.height = h
                var tileCtx = tileCanvas.getContext('2d')
                tileCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h)

                tiles.push({
                  row: r, col: c,
                  x: x, y: y, w: w, h: h,
                  fullW: vp.width, fullH: vp.height,
                  dataUrl: tileCanvas.toDataURL('image/png')
                })
              }
            }

            if (onProgress) onProgress('Created ' + tiles.length + ' tiles (' + cols + 'x' + rows + ')')
            resolve({ tiles: tiles, fullWidth: vp.width, fullHeight: vp.height, scale: scale })
          }).catch(reject)
        }).catch(reject)
      }).catch(reject)
    }
    reader.onerror = function() { reject(new Error('Failed to read PDF file')) }
    reader.readAsArrayBuffer(pdfFile)
  })
}

function ocrTiles(tiles, onProgress) {
  var Tesseract = window.Tesseract
  if (!Tesseract) return Promise.reject(new Error('Tesseract.js not loaded'))

  var allItems = []
  var done = 0
  var total = tiles.length

  return tiles.reduce(function(chain, tile) {
    return chain.then(function() {
      if (onProgress) onProgress('OCR tile ' + (done + 1) + '/' + total)
      return Tesseract.recognize(tile.dataUrl, 'eng', {
        logger: function() {} // silent
      }).then(function(result) {
        var words = result.data.words || []
        words.forEach(function(w) {
          if (w.confidence < 40) return // skip low-confidence junk
          allItems.push({
            text: w.text,
            confidence: w.confidence,
            // Convert tile-local coords to full-image coords
            x: tile.x + w.bbox.x0,
            y: tile.y + w.bbox.y0,
            x1: tile.x + w.bbox.x1,
            y1: tile.y + w.bbox.y1,
            tileRow: tile.row,
            tileCol: tile.col
          })
        })
        done++
      })
    })
  }, Promise.resolve()).then(function() {
    if (onProgress) onProgress('OCR complete — ' + allItems.length + ' words extracted')
    return allItems
  })
}

/* ════════════════════════════════════════════════════════
   2.  EXTRACT STRUCTURED DATA FROM OCR WORDS
   ════════════════════════════════════════════════════════ */

function extractDevicesFromOCR(words) {
  // Sort words left-to-right, top-to-bottom for line reconstruction
  var sorted = words.slice().sort(function(a, b) {
    var rowDiff = Math.floor(a.y / 30) - Math.floor(b.y / 30) // ~30px per text line at 4x
    if (rowDiff !== 0) return rowDiff
    return a.x - b.x
  })

  // Reconstruct lines by grouping words with similar Y
  var lines = []
  var currentLine = []
  var currentY = -999

  sorted.forEach(function(w) {
    if (Math.abs(w.y - currentY) > 20) {
      if (currentLine.length > 0) lines.push(currentLine)
      currentLine = [w]
      currentY = w.y
    } else {
      currentLine.push(w)
    }
  })
  if (currentLine.length > 0) lines.push(currentLine)

  // Extract FCU/VAV tags, room names, thermostat refs, loop labels
  var devices = []
  var rooms = []
  var loops = []
  var thermostats = []

  // Patterns
  var fcuPattern = /^(FCU|VAV|AHU|PAU|ERU|CWP|HWP|CHW|CT|CHWP)[-_]?\d+[-_]?\d*/i
  var trPattern = /^(TR|TSTAT|T)[-_]?\d+[-_]?\d*/i
  var loopPattern = /LOOP[-_ ]?\d+/i
  var ddcPattern = /^DDC[-_]?\w+[-_]?\d+/i
  var roomPatterns = [
    /CLASSROOM/i, /OFFICE/i, /CORRIDOR/i, /LOBBY/i, /TOILET/i, /STORE/i,
    /KITCHEN/i, /HALL/i, /RECEPTION/i, /MEETING/i, /SERVER/i, /ELECTRICAL/i,
    /PANTRY/i, /PRAYER/i, /STAIR/i, /LIFT/i, /ENTRANCE/i, /LIBRARY/i,
    /LABORATORY/i, /LAB/i, /CLINIC/i, /NURSE/i, /STAFF/i, /ROOM/i,
    /SCIENCE/i, /HEALTH/i, /COMPUTER/i, /WORKSHOP/i, /CAFETERIA/i
  ]

  lines.forEach(function(line) {
    var lineText = line.map(function(w) { return w.text }).join(' ')
    var lineX = line[0].x
    var lineY = line[0].y
    var lineX1 = line[line.length - 1].x1
    var lineY1 = line[line.length - 1].y1
    var midX = (lineX + lineX1) / 2
    var midY = (lineY + lineY1) / 2

    // Check each word for device tags
    line.forEach(function(w) {
      var txt = w.text.trim()
      if (fcuPattern.test(txt)) {
        // Check if next word is .TR (thermostat association)
        var assocTR = ''
        var wIdx = line.indexOf(w)
        if (wIdx < line.length - 1) {
          var nextTxt = line[wIdx + 1].text.trim()
          if (/^\.?TR/i.test(nextTxt)) {
            assocTR = nextTxt.replace(/^\./, '')
          }
        }
        devices.push({
          tag: txt.toUpperCase(),
          x: w.x, y: w.y, x1: w.x1, y1: w.y1,
          midX: (w.x + w.x1) / 2,
          midY: (w.y + w.y1) / 2,
          thermostat: assocTR.toUpperCase()
        })
      }

      if (trPattern.test(txt)) {
        thermostats.push({
          tag: txt.toUpperCase(),
          x: w.x, y: w.y, x1: w.x1, y1: w.y1,
          midX: (w.x + w.x1) / 2,
          midY: (w.y + w.y1) / 2
        })
      }

      if (ddcPattern.test(txt)) {
        devices.push({
          tag: txt.toUpperCase(),
          type: 'DDC',
          x: w.x, y: w.y, x1: w.x1, y1: w.y1,
          midX: (w.x + w.x1) / 2,
          midY: (w.y + w.y1) / 2
        })
      }
    })

    // Check for loop labels
    var loopMatch = lineText.match(loopPattern)
    if (loopMatch) {
      loops.push({
        label: loopMatch[0].toUpperCase().replace(/\s+/g, '-'),
        text: lineText,
        x: lineX, y: lineY,
        midX: midX, midY: midY
      })
    }

    // Check for room names
    for (var ri = 0; ri < roomPatterns.length; ri++) {
      if (roomPatterns[ri].test(lineText) && lineText.length > 3) {
        rooms.push({
          name: lineText.toUpperCase().trim(),
          x: lineX, y: lineY, x1: lineX1, y1: lineY1,
          midX: midX, midY: midY
        })
        break
      }
    }
  })

  return { devices: devices, rooms: rooms, loops: loops, thermostats: thermostats }
}

/* ════════════════════════════════════════════════════════
   3.  GEMINI VISION — HIGHLIGHTED PHOTO ANALYSIS
   ════════════════════════════════════════════════════════ */

function compressImage(file, maxDim, quality) {
  maxDim = maxDim || 2048
  quality = quality || 0.7
  return new Promise(function(resolve, reject) {
    var reader = new FileReader()
    reader.onload = function() {
      var img = new Image()
      img.onload = function() {
        var w = img.width
        var h = img.height
        // Scale down if larger than maxDim
        if (w > maxDim || h > maxDim) {
          var ratio = Math.min(maxDim / w, maxDim / h)
          w = Math.round(w * ratio)
          h = Math.round(h * ratio)
        }
        var canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        var ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        var dataUrl = canvas.toDataURL('image/jpeg', quality)
        var base64 = dataUrl.split(',')[1]
        var sizeKB = Math.round(base64.length * 0.75 / 1024)
        resolve({ base64: base64, mimeType: 'image/jpeg', width: w, height: h, sizeKB: sizeKB })
      }
      img.onerror = function() { reject(new Error('Failed to load image')) }
      img.src = reader.result
    }
    reader.onerror = function() { reject(new Error('Failed to read image file')) }
    reader.readAsDataURL(file)
  })
}

function callGemini(apiKey, body, model) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function analyzeHighlightedDrawing(imageFile, apiKey, onProgress) {
  if (!apiKey) return Promise.reject(new Error('Gemini API key required'))

  if (onProgress) onProgress('Compressing image for Gemini...')

  return compressImage(imageFile, 2048, 0.7).then(function(compressed) {
    if (onProgress) onProgress('Compressed to ' + compressed.width + 'x' + compressed.height + ' (' + compressed.sizeKB + ' KB)')
    var mimeType = compressed.mimeType
    var base64 = compressed.base64

    var prompt = [
      'You are analyzing a BMS (Building Management System) highlighted shop drawing from a site supervisor.',
      'The drawing shows actual as-built loop routing with colored highlights, circled device numbers, and handwritten annotations.',
      '',
      'Extract ALL of the following information and return it as JSON:',
      '',
      '1. LOOPS: Each highlighted/colored path is a communication loop. Identify:',
      '   - loop_id: The loop label if visible (e.g. "LOOP-01", "LOOP-07")',
      '   - color: The highlight color used (pink, yellow, green, blue, etc.)',
      '   - ddc_panel: Which DDC panel this loop connects to (e.g. "DDC-FF-02")',
      '',
      '2. DEVICES on each loop: FCU tags, VAV tags, or other devices that are circled/marked on each loop path:',
      '   - tag: The device tag (e.g. "FCU-20-45", "VAV-12-03")',
      '   - loop_id: Which loop this device belongs to',
      '   - relative_position: approximate position description (e.g. "top-left", "center-right", "bottom")',
      '',
      '3. DDC PANELS: Any DDC panel references visible:',
      '   - panel_id: e.g. "DDC-FF-02", "DDC-GF-01"',
      '   - position: relative position on the drawing',
      '',
      '4. ANNOTATIONS: Any handwritten notes, checkmarks, or symbols and what they indicate',
      '',
      'Return ONLY valid JSON in this format:',
      '{',
      '  "loops": [{"loop_id":"LOOP-01","color":"pink","ddc_panel":"DDC-FF-02","devices":["FCU-20-45","FCU-20-46"]}],',
      '  "devices": [{"tag":"FCU-20-45","loop_id":"LOOP-01","relative_position":"top-left"}],',
      '  "ddc_panels": [{"panel_id":"DDC-FF-02","position":"bottom-right"}],',
      '  "annotations": [{"type":"checkmark","near_device":"FCU-20-45","meaning":"commissioned"}],',
      '  "floor_label": "SECOND FLOOR" or null if not visible',
      '}'
    ].join('\n')

    var body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192
      }
    }

    if (onProgress) onProgress('Sending to Gemini Vision API...')

    var models = ['gemini-2.5-flash', 'gemini-2.0-flash-001', 'gemini-1.5-flash']

    function tryModel(idx) {
      if (idx >= models.length) return Promise.reject(new Error('All Gemini models failed — try again in a few minutes'))
      var model = models[idx]
      if (onProgress && idx > 0) onProgress('Retrying with ' + model + '...')

      return callGemini(apiKey, body, model).then(function(resp) {
        if (resp.status === 429 && idx < models.length - 1) {
          if (onProgress) onProgress(model + ' rate-limited, trying next model...')
          return tryModel(idx + 1)
        }
        if (!resp.ok) {
          return resp.text().then(function(errText) {
            if (idx < models.length - 1) {
              if (onProgress) onProgress(model + ' failed, trying next model...')
              return tryModel(idx + 1)
            }
            throw new Error('Gemini API error (' + resp.status + '): ' + errText)
          })
        }
        return resp.json()
      })
    }

    return tryModel(0).then(function(data) {
      if (onProgress) onProgress('Gemini response received — parsing...')

      // Extract JSON from response
      var text = ''
      if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        var parts = data.candidates[0].content.parts || []
        parts.forEach(function(p) { if (p.text) text += p.text })
      }

      // Try to parse JSON from the response (may be wrapped in ```json blocks)
      var jsonStr = text
      var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) jsonStr = jsonMatch[1]

      // Clean up common issues
      jsonStr = jsonStr.trim()

      try {
        var parsed = JSON.parse(jsonStr)
        if (onProgress) onProgress('Gemini analysis complete — ' + (parsed.loops || []).length + ' loops, ' + (parsed.devices || []).length + ' devices found')
        return parsed
      } catch (e) {
        console.warn('Gemini JSON parse failed, raw text:', text)
        // Return what we can
        return { loops: [], devices: [], ddc_panels: [], annotations: [], raw_text: text, parse_error: e.message }
      }
    })
  })
}

/* ════════════════════════════════════════════════════════
   4.  POSITION MATCHING — COMBINE PDF + PHOTO DATA
   ════════════════════════════════════════════════════════ */

function combineDrawingData(pdfData, geminiData, onProgress) {
  if (onProgress) onProgress('Combining PDF OCR data with Gemini analysis...')

  var pdfDevices = pdfData.devices || []
  var pdfRooms = pdfData.rooms || []
  var geminiLoops = geminiData.loops || []
  var geminiDevices = geminiData.devices || []
  var geminiPanels = geminiData.ddc_panels || []

  // Build a lookup of PDF devices by tag for enrichment
  var pdfDeviceMap = {}
  pdfDevices.forEach(function(d) {
    var cleanTag = d.tag.replace(/[^A-Z0-9-]/g, '')
    pdfDeviceMap[cleanTag] = d
  })

  // For each Gemini-identified loop, enrich devices with PDF data (room, position)
  var enrichedLoops = geminiLoops.map(function(loop) {
    var loopDevices = (loop.devices || []).map(function(tag) {
      var cleanTag = tag.replace(/[^A-Z0-9-]/g, '')
      var pdfDev = pdfDeviceMap[cleanTag]

      // Find nearest room from PDF OCR
      var nearestRoom = ''
      if (pdfDev && pdfRooms.length > 0) {
        var bestDist = Infinity
        pdfRooms.forEach(function(room) {
          var dx = pdfDev.midX - room.midX
          var dy = pdfDev.midY - room.midY
          var dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < bestDist) {
            bestDist = dist
            nearestRoom = room.name
          }
        })
      }

      // Find thermostat association from PDF
      var thermostat = ''
      if (pdfDev && pdfDev.thermostat) {
        thermostat = pdfDev.thermostat
      }

      return {
        tag: cleanTag,
        room: nearestRoom,
        thermostat: thermostat,
        hasPosition: !!pdfDev,
        geminiPosition: (geminiDevices.find(function(gd) {
          return gd.tag.replace(/[^A-Z0-9-]/g, '') === cleanTag
        }) || {}).relative_position || ''
      }
    })

    return {
      loopId: loop.loop_id || 'LOOP-?',
      color: loop.color || '',
      ddcPanel: loop.ddc_panel || '',
      devices: loopDevices,
      deviceCount: loopDevices.length
    }
  })

  // Find devices in PDF that weren't matched to any Gemini loop
  var matchedTags = {}
  enrichedLoops.forEach(function(loop) {
    loop.devices.forEach(function(d) { matchedTags[d.tag] = true })
  })

  var unmatchedPdfDevices = pdfDevices.filter(function(d) {
    return !d.type && !matchedTags[d.tag] // skip DDC panels, only FCU/VAV
  })

  var result = {
    loops: enrichedLoops,
    ddcPanels: geminiPanels,
    annotations: geminiData.annotations || [],
    floorLabel: geminiData.floor_label || '',
    pdfStats: {
      totalDevices: pdfDevices.length,
      totalRooms: pdfRooms.length,
      totalWords: 0 // filled by caller
    },
    unmatchedDevices: unmatchedPdfDevices.map(function(d) {
      return { tag: d.tag, thermostat: d.thermostat || '' }
    }),
    geminiRaw: geminiData
  }

  if (onProgress) {
    onProgress('Combined: ' + enrichedLoops.length + ' loops, ' +
      enrichedLoops.reduce(function(s, l) { return s + l.deviceCount }, 0) + ' matched devices, ' +
      unmatchedPdfDevices.length + ' unmatched PDF devices')
  }

  return result
}

/* ════════════════════════════════════════════════════════
   5.  MAIN ENTRY POINT
   ════════════════════════════════════════════════════════ */

function parseDrawings(pdfFile, photoFile, apiKey, onProgress) {
  var progress = onProgress || function() {}

  progress('Starting Drawing Import...')

  // Step 1: Tile + OCR the PDF
  return tilePDF(pdfFile, progress)
    .then(function(tileResult) {
      return ocrTiles(tileResult.tiles, progress).then(function(words) {
        return { words: words, tileResult: tileResult }
      })
    })
    .then(function(ocrResult) {
      // Step 2: Extract structured data from OCR
      progress('Extracting devices, rooms, and loop labels from PDF...')
      var pdfData = extractDevicesFromOCR(ocrResult.words)
      pdfData.wordCount = ocrResult.words.length
      progress('PDF extraction: ' + pdfData.devices.length + ' devices, ' + pdfData.rooms.length + ' rooms, ' + pdfData.loops.length + ' loop labels')

      // Step 3: Analyze highlighted photo with Gemini
      return analyzeHighlightedDrawing(photoFile, apiKey, progress).then(function(geminiData) {
        // Step 4: Combine both data sources
        var combined = combineDrawingData(pdfData, geminiData, progress)
        combined.pdfStats.totalWords = ocrResult.words.length

        progress('Drawing import analysis complete!')
        return combined
      })
    })
}

/* ════════════════════════════════════════════════════════
   6.  EXPORTS
   ════════════════════════════════════════════════════════ */

export { parseDrawings, tilePDF, ocrTiles, extractDevicesFromOCR, analyzeHighlightedDrawing, combineDrawingData }
