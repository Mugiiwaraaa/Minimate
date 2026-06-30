/* ─── drawingParser.js ─── Shop Drawing Import Engine ─── */
/* Dual Gemini Vision: PDF → device/room extraction, Photo → loop routing */

/* ════════════════════════════════════════════════════════
   1.  IMAGE HELPERS
   ════════════════════════════════════════════════════════ */

function compressImage(file, maxDim, quality) {
  maxDim = maxDim || 2048
  quality = quality || 0.8
  return new Promise(function(resolve, reject) {
    var reader = new FileReader()
    reader.onload = function() {
      var img = new Image()
      img.onload = function() {
        var w = img.width
        var h = img.height
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
    reader.onerror = function() { reject(new Error('Failed to read file')) }
    reader.readAsDataURL(file)
  })
}

function pdfToImage(pdfFile, scale, onProgress) {
  scale = scale || 2
  return new Promise(function(resolve, reject) {
    var reader = new FileReader()
    reader.onload = function() {
      var typedArray = new Uint8Array(reader.result)
      var pdfjsLib = window.pdfjsLib
      if (!pdfjsLib) { reject(new Error('pdf.js not loaded')); return }

      pdfjsLib.getDocument({ data: typedArray }).promise.then(function(pdf) {
        if (onProgress) onProgress('PDF loaded — ' + pdf.numPages + ' page(s)')
        pdf.getPage(1).then(function(page) {
          var vp = page.getViewport({ scale: scale })
          // Limit canvas to 4096px max dimension (browser limits)
          var maxPx = 4096
          var actualScale = scale
          if (vp.width > maxPx || vp.height > maxPx) {
            var downRatio = Math.min(maxPx / vp.width, maxPx / vp.height)
            actualScale = scale * downRatio
            vp = page.getViewport({ scale: actualScale })
          }
          var canvas = document.createElement('canvas')
          canvas.width = vp.width
          canvas.height = vp.height
          var ctx = canvas.getContext('2d')
          if (onProgress) onProgress('Rendering PDF (' + Math.round(vp.width) + 'x' + Math.round(vp.height) + ')')

          page.render({ canvasContext: ctx, viewport: vp }).promise.then(function() {
            // Convert to JPEG for Gemini
            var dataUrl = canvas.toDataURL('image/jpeg', 0.85)
            var base64 = dataUrl.split(',')[1]
            var sizeKB = Math.round(base64.length * 0.75 / 1024)
            if (onProgress) onProgress('PDF rendered — ' + sizeKB + ' KB image')
            resolve({ base64: base64, mimeType: 'image/jpeg', width: vp.width, height: vp.height, sizeKB: sizeKB })
          }).catch(reject)
        }).catch(reject)
      }).catch(reject)
    }
    reader.onerror = function() { reject(new Error('Failed to read PDF')) }
    reader.readAsArrayBuffer(pdfFile)
  })
}

/* ════════════════════════════════════════════════════════
   2.  GEMINI API CALLER WITH MODEL FALLBACK
   ════════════════════════════════════════════════════════ */

var MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-001', 'gemini-1.5-flash']

function callGemini(apiKey, prompt, imageBase64, imageMime, onProgress) {
  var body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: imageMime, data: imageBase64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192
    }
  }

  function tryModel(idx) {
    if (idx >= MODELS.length) return Promise.reject(new Error('All Gemini models failed'))
    var model = MODELS[idx]
    if (idx > 0 && onProgress) onProgress('Trying ' + model + '...')

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(resp) {
      if (!resp.ok) {
        return resp.text().then(function(errText) {
          if (idx < MODELS.length - 1) {
            if (onProgress) onProgress(model + ' failed (' + resp.status + '), trying next...')
            return tryModel(idx + 1)
          }
          throw new Error('Gemini API error (' + resp.status + '): ' + errText)
        })
      }
      return resp.json()
    })
  }

  return tryModel(0).then(function(data) {
    var text = ''
    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      var parts = data.candidates[0].content.parts || []
      parts.forEach(function(p) { if (p.text) text += p.text })
    }
    // Extract JSON
    var jsonStr = text
    var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) jsonStr = jsonMatch[1]
    jsonStr = jsonStr.trim()
    try {
      return JSON.parse(jsonStr)
    } catch (e) {
      console.warn('Gemini JSON parse error. Raw text:', text)
      return { raw_text: text, parse_error: e.message }
    }
  })
}

/* ════════════════════════════════════════════════════════
   3.  PDF ANALYSIS — DEVICE TAGS, ROOMS, AREAS
   ════════════════════════════════════════════════════════ */

var PDF_PROMPT = [
  'You are analyzing a BMS (Building Management System) shop drawing / floor plan PDF.',
  'This is a CAD/engineering drawing showing FCU units, thermostats, conduit routing, and room layouts for one floor.',
  '',
  'Extract ALL of the following and return as JSON:',
  '',
  '1. DEVICES: Every FCU, VAV, AHU, PAU, ERU tag visible (e.g. "FCU-20-45", "VAV-12-03")',
  '   - Include the associated thermostat if shown nearby (e.g. "FCU-20-45.TR" means TR is the thermostat)',
  '2. ROOMS: Every room name/label visible (e.g. "CLASSROOM SF01", "OFFICE 201", "CORRIDOR")',
  '3. DDC PANELS: Any DDC panel references (e.g. "DDC-FF-02", "DDC-GF-01")',
  '4. LOOP LABELS: Any loop references like "LOOP-01", "FCU BMS/MBTP LOOP-07"',
  '5. FLOOR: The floor name if visible',
  '',
  'For each device, note which room it appears to be in or nearest to.',
  '',
  'Return ONLY valid JSON:',
  '{',
  '  "devices": [{"tag":"FCU-20-45","thermostat":"TR-20-45","room":"CLASSROOM SF01","area":"ZONE A"}],',
  '  "rooms": ["CLASSROOM SF01","OFFICE 201"],',
  '  "ddc_panels": ["DDC-FF-02"],',
  '  "loop_labels": ["LOOP-07","LOOP-08"],',
  '  "floor": "SECOND FLOOR"',
  '}'
].join('\n')

/* ════════════════════════════════════════════════════════
   4.  PHOTO ANALYSIS — HIGHLIGHTED LOOP ROUTING
   ════════════════════════════════════════════════════════ */

var PHOTO_PROMPT = [
  'You are analyzing a highlighted BMS shop drawing photo from a site supervisor.',
  'The supervisor has manually marked up this drawing with colored highlights to show actual as-built communication loop routing.',
  'Colored highlight paths show which devices are connected on the same communication loop.',
  'Circled numbers, handwritten annotations, and checkmarks indicate commissioning status.',
  '',
  'Extract ALL of the following and return as JSON:',
  '',
  '1. LOOPS: Each colored highlight path is a communication loop.',
  '   - loop_id: Label if visible (e.g. "LOOP-01", "LOOP-07"), or generate one like "LOOP-A", "LOOP-B"',
  '   - color: The highlight color (pink, yellow, green, blue, orange, etc.)',
  '   - ddc_panel: Which DDC panel this loop connects to if visible',
  '   - devices: List of device tags (FCU/VAV numbers) on this highlighted path',
  '',
  '2. DEVICE TAGS: Every FCU/VAV/device number you can read, even partially',
  '',
  '3. DDC PANELS: Any DDC panel references',
  '',
  '4. ANNOTATIONS: Checkmarks, circled items, handwritten notes',
  '',
  'IMPORTANT: Try hard to read device numbers even if partially obscured by highlights.',
  'If you can see "FCU-20-" followed by something, give your best guess.',
  '',
  'Return ONLY valid JSON:',
  '{',
  '  "loops": [{"loop_id":"LOOP-01","color":"pink","ddc_panel":"DDC-FF-02","devices":["FCU-20-45","FCU-20-46"]}],',
  '  "all_devices": ["FCU-20-45","FCU-20-46","FCU-20-47"],',
  '  "ddc_panels": [{"panel_id":"DDC-FF-02","position":"bottom-right"}],',
  '  "annotations": [{"type":"checkmark","near":"FCU-20-45","meaning":"done"}],',
  '  "floor": "SECOND FLOOR"',
  '}'
].join('\n')

/* ════════════════════════════════════════════════════════
   5.  COMBINE PDF + PHOTO DATA
   ════════════════════════════════════════════════════════ */

function combineResults(pdfResult, photoResult, onProgress) {
  if (onProgress) onProgress('Combining PDF data with highlighted photo analysis...')

  var pdfDevices = pdfResult.devices || []
  var pdfRooms = pdfResult.rooms || []
  var photoLoops = photoResult.loops || []
  var photoPanels = photoResult.ddc_panels || []

  // Build device lookup from PDF (tag → room, thermostat)
  var deviceInfo = {}
  pdfDevices.forEach(function(d) {
    var tag = (d.tag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
    if (tag) {
      deviceInfo[tag] = {
        room: d.room || '',
        thermostat: d.thermostat || '',
        area: d.area || ''
      }
    }
  })

  // Enrich photo loops with PDF device info
  var enrichedLoops = photoLoops.map(function(loop) {
    var loopDevices = (loop.devices || []).map(function(rawTag) {
      var tag = (rawTag || '').toUpperCase().replace(/[^A-Z0-9-.]/g, '')
      var info = deviceInfo[tag] || {}

      // Try fuzzy match if exact match fails
      if (!info.room) {
        var tagKeys = Object.keys(deviceInfo)
        for (var i = 0; i < tagKeys.length; i++) {
          if (tagKeys[i].indexOf(tag) >= 0 || tag.indexOf(tagKeys[i]) >= 0) {
            info = deviceInfo[tagKeys[i]]
            break
          }
        }
      }

      return {
        tag: tag,
        room: info.room || '',
        thermostat: info.thermostat || '',
        area: info.area || ''
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

  // Find PDF devices NOT in any photo loop
  var matchedTags = {}
  enrichedLoops.forEach(function(loop) {
    loop.devices.forEach(function(d) { matchedTags[d.tag] = true })
  })

  var unmatchedDevices = pdfDevices.filter(function(d) {
    var tag = (d.tag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
    return tag && !matchedTags[tag] && /^(FCU|VAV|AHU|PAU|ERU)/i.test(tag)
  }).map(function(d) {
    var tag = (d.tag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
    return { tag: tag, room: d.room || '', thermostat: d.thermostat || '' }
  })

  var totalMatched = enrichedLoops.reduce(function(s, l) { return s + l.deviceCount }, 0)
  if (onProgress) onProgress('Result: ' + enrichedLoops.length + ' loops, ' + totalMatched + ' matched, ' + unmatchedDevices.length + ' unmatched')

  return {
    loops: enrichedLoops,
    ddcPanels: photoPanels,
    annotations: photoResult.annotations || [],
    floorLabel: photoResult.floor || pdfResult.floor || '',
    pdfStats: {
      totalDevices: pdfDevices.length,
      totalRooms: pdfRooms.length,
      loopLabels: pdfResult.loop_labels || []
    },
    unmatchedDevices: unmatchedDevices,
    pdfRaw: pdfResult,
    photoRaw: photoResult
  }
}

/* ════════════════════════════════════════════════════════
   6.  MAIN ENTRY POINT
   ════════════════════════════════════════════════════════ */

function parseDrawings(pdfFile, photoFile, apiKey, onProgress) {
  var progress = onProgress || function() {}

  progress('Starting Drawing Import...')

  // Step 1: Convert PDF page to image
  return pdfToImage(pdfFile, 3, progress)
    .then(function(pdfImage) {
      // Step 2: Compress the highlighted photo
      progress('Compressing highlighted photo...')
      return compressImage(photoFile, 3000, 0.85).then(function(photoImage) {
        progress('Photo compressed — ' + photoImage.width + 'x' + photoImage.height + ' (' + photoImage.sizeKB + ' KB)')

        // Step 3: Send PDF image to Gemini for device/room extraction
        progress('Analyzing PDF drawing with Gemini...')
        return callGemini(apiKey, PDF_PROMPT, pdfImage.base64, pdfImage.mimeType, progress).then(function(pdfResult) {
          var devCount = (pdfResult.devices || []).length
          var roomCount = (pdfResult.rooms || []).length
          progress('PDF analysis: ' + devCount + ' devices, ' + roomCount + ' rooms found')

          // Step 4: Send highlighted photo to Gemini for loop routing
          progress('Analyzing highlighted drawing with Gemini...')
          return callGemini(apiKey, PHOTO_PROMPT, photoImage.base64, photoImage.mimeType, progress).then(function(photoResult) {
            var loopCount = (photoResult.loops || []).length
            var allDevs = (photoResult.all_devices || []).length
            progress('Photo analysis: ' + loopCount + ' loops, ' + allDevs + ' devices found')

            // Step 5: Combine both results
            var combined = combineResults(pdfResult, photoResult, progress)
            progress('Drawing import analysis complete!')
            return combined
          })
        })
      })
    })
}

/* ════════════════════════════════════════════════════════
   7.  EXPORTS
   ════════════════════════════════════════════════════════ */

export { parseDrawings, pdfToImage, compressImage, callGemini, combineResults }
