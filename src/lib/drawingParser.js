/* ─── drawingParser.js ─── Shop Drawing Import Engine v3 ─── */
/* Gemini File API for large PDFs + Vision API for highlighted photo */

/* ════════════════════════════════════════════════════════
   1.  IMAGE COMPRESSION HELPER
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

/* ════════════════════════════════════════════════════════
   2.  GEMINI FILE UPLOAD API (for large PDFs)
   ════════════════════════════════════════════════════════ */

function uploadToGemini(file, apiKey, onProgress) {
  if (onProgress) onProgress('Uploading PDF to Gemini (' + Math.round(file.size/1024/1024) + ' MB)...')

  return new Promise(function(resolve, reject) {
    var reader = new FileReader()
    reader.onload = function() {
      var arrayBuffer = reader.result

      // Step 1: Start resumable upload
      var startUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + apiKey
      var metadata = {
        file: {
          display_name: file.name || 'drawing.pdf'
        }
      }

      fetch(startUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': arrayBuffer.byteLength.toString(),
          'X-Goog-Upload-Header-Content-Type': file.type || 'application/pdf',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(metadata)
      }).then(function(startResp) {
        if (!startResp.ok) {
          return startResp.text().then(function(t) { throw new Error('Upload start failed: ' + t) })
        }
        var uploadUrl = startResp.headers.get('X-Goog-Upload-URL')
        if (!uploadUrl) throw new Error('No upload URL returned')

        if (onProgress) onProgress('Uploading PDF data...')

        // Step 2: Upload the actual bytes
        return fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0',
            'Content-Type': file.type || 'application/pdf'
          },
          body: arrayBuffer
        })
      }).then(function(uploadResp) {
        if (!uploadResp.ok) {
          return uploadResp.text().then(function(t) { throw new Error('Upload failed: ' + t) })
        }
        return uploadResp.json()
      }).then(function(fileInfo) {
        console.log('[DRAWING] File uploaded:', fileInfo)
        var fileUri = fileInfo.file && fileInfo.file.uri
        if (!fileUri) throw new Error('No file URI in upload response')
        if (onProgress) onProgress('PDF uploaded successfully')

        // Step 3: Wait for file processing
        function checkState() {
          var name = fileInfo.file.name
          return fetch('https://generativelanguage.googleapis.com/v1beta/' + name + '?key=' + apiKey)
            .then(function(r) { return r.json() })
            .then(function(info) {
              console.log('[DRAWING] File state:', info.state)
              if (info.state === 'ACTIVE') {
                return fileUri
              } else if (info.state === 'PROCESSING') {
                if (onProgress) onProgress('PDF processing on Gemini servers...')
                return new Promise(function(res) { setTimeout(res, 2000) }).then(checkState)
              } else {
                throw new Error('File processing failed: ' + info.state)
              }
            })
        }
        return checkState()
      }).then(resolve).catch(reject)
    }
    reader.onerror = function() { reject(new Error('Failed to read PDF file')) }
    reader.readAsArrayBuffer(file)
  })
}

/* ════════════════════════════════════════════════════════
   3.  GEMINI API WITH MODEL FALLBACK
   ════════════════════════════════════════════════════════ */

var MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro']

function callGeminiWithFile(apiKey, prompt, fileUri, fileMime, onProgress) {
  var body = {
    contents: [{
      parts: [
        { text: prompt },
        { file_data: { mime_type: fileMime, file_uri: fileUri } }
      ]
    }],
    generationConfig: { temperature: 0.1 }
  }
  return callGeminiRaw(apiKey, body, onProgress)
}

function callGeminiWithImage(apiKey, prompt, imageBase64, imageMime, onProgress) {
  var body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: imageMime, data: imageBase64 } }
      ]
    }],
    generationConfig: { temperature: 0.1 }
  }
  return callGeminiRaw(apiKey, body, onProgress)
}

function callGeminiRaw(apiKey, body, onProgress) {
  function tryCall(model, attempt) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(resp) {
      if (resp.status === 503 && attempt < 3) {
        var wait = (attempt + 1) * 3
        if (onProgress) onProgress('Server busy — retrying in ' + wait + 's (attempt ' + (attempt + 1) + '/3)...')
        return new Promise(function(res) { setTimeout(res, wait * 1000) }).then(function() {
          return tryCall(model, attempt + 1)
        })
      }
      if (resp.status === 429 && attempt < 3) {
        var w2 = (attempt + 1) * 5
        if (onProgress) onProgress('Rate limited — retrying in ' + w2 + 's...')
        return new Promise(function(res) { setTimeout(res, w2 * 1000) }).then(function() {
          return tryCall(model, attempt + 1)
        })
      }
      if (!resp.ok) {
        return resp.text().then(function(errText) {
          throw new Error('Gemini API error (' + resp.status + '): ' + errText.substring(0, 300))
        })
      }
      return resp.json()
    })
  }

  function tryModel(idx) {
    if (idx >= MODELS.length) return Promise.reject(new Error('All Gemini models failed'))
    var model = MODELS[idx]
    if (idx > 0 && onProgress) onProgress('Trying ' + model + '...')

    return tryCall(model, 0).catch(function(err) {
      console.warn('[DRAWING] ' + model + ' failed:', err.message.substring(0, 200))
      if (idx < MODELS.length - 1) {
        if (onProgress) onProgress(model + ' failed, trying next...')
        return tryModel(idx + 1)
      }
      throw err
    })
  }

  return tryModel(0).then(function(data) {
    // Debug: log full response structure
    console.log('[DRAWING] Full API response keys:', Object.keys(data))
    if (onProgress) onProgress('DEBUG: response keys=' + Object.keys(data).join(','))

    if (data.candidates) {
      console.log('[DRAWING] Candidates count:', data.candidates.length)
      if (onProgress) onProgress('DEBUG: ' + data.candidates.length + ' candidate(s)')
    } else {
      console.log('[DRAWING] NO candidates in response!', JSON.stringify(data).substring(0, 500))
      if (onProgress) onProgress('DEBUG: NO candidates! resp=' + JSON.stringify(data).substring(0, 200))
    }

    // Extract text from response
    var text = ''
    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      var parts = data.candidates[0].content.parts || []
      parts.forEach(function(p) { if (p.text) text += p.text })
    }
    console.log('[DRAWING] Gemini text length:', text.length)
    console.log('[DRAWING] Gemini raw (first 1000):', text.substring(0, 1000))
    if (onProgress) onProgress('DEBUG: text length=' + text.length + ' chars')
    if (text.length > 0 && onProgress) onProgress('DEBUG: first 150 chars=' + text.substring(0, 150))

    if (text.length === 0) {
      if (onProgress) onProgress('DEBUG: EMPTY response from Gemini!')
      return { parse_error: 'empty_response', raw_data: data }
    }

    // Extract JSON — always use brace extraction (most reliable)
    var firstBrace = text.indexOf('{')
    var lastBrace = text.lastIndexOf('}')
    var jsonStr = ''
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = text.substring(firstBrace, lastBrace + 1)
    } else {
      jsonStr = text.trim()
    }

    try {
      var parsed = JSON.parse(jsonStr)
      console.log('[DRAWING] Parsed keys:', Object.keys(parsed))
      if (onProgress) onProgress('DEBUG: parsed OK, keys=' + Object.keys(parsed).join(','))
      return parsed
    } catch (e) {
      console.error('[DRAWING] JSON parse failed:', e.message, 'Text:', text)
      if (onProgress) onProgress('DEBUG: JSON parse FAILED: ' + e.message)
      return { raw_text: text, parse_error: e.message }
    }
  })
}

/* ════════════════════════════════════════════════════════
   4.  PROMPTS
   ════════════════════════════════════════════════════════ */

var PDF_PROMPT = [
  'You are analyzing a BMS (Building Management System) shop drawing / floor plan.',
  'This is a CAD/engineering drawing showing FCU units, thermostats, conduit routing, and room layouts.',
  '',
  'Extract ALL of the following and return as JSON:',
  '',
  '1. DEVICES: Every FCU, VAV, AHU, PAU, ERU tag visible (e.g. "FCU-20-45", "VAV-12-03")',
  '   - Include the associated thermostat if shown (e.g. "FCU-20-45.TR")',
  '2. ROOMS: Every room name/label visible (e.g. "CLASSROOM SF01", "OFFICE 201")',
  '3. DDC PANELS: Any DDC panel references (e.g. "DDC-FF-02")',
  '4. LOOP LABELS: Any loop references like "LOOP-01", "FCU BMS/MBTP LOOP-07"',
  '5. FLOOR: The floor name if visible',
  '',
  'For each device, note which room it appears to be in or nearest to.',
  '',
  'Return ONLY valid JSON:',
  '{',
  '  "devices": [{"tag":"FCU-20-45","thermostat":"TR-20-45","room":"CLASSROOM SF01"}],',
  '  "rooms": ["CLASSROOM SF01","OFFICE 201"],',
  '  "ddc_panels": ["DDC-FF-02"],',
  '  "loop_labels": ["LOOP-07"],',
  '  "floor": "SECOND FLOOR"',
  '}'
].join('\n')

var PHOTO_PROMPT = [
  'You are analyzing a highlighted BMS shop drawing photo from a site supervisor.',
  'The supervisor has marked up this drawing with colored highlights showing actual as-built loop routing.',
  'Each colored path = one communication loop connecting devices to a DDC panel.',
  '',
  'Extract ALL of the following and return as JSON:',
  '',
  '1. LOOPS: Each colored highlight path is a communication loop.',
  '   - loop_id: Label if visible (e.g. "LOOP-01") or generate "LOOP-A","LOOP-B"',
  '   - color: Highlight color (pink, yellow, green, blue, etc.)',
  '   - ddc_panel: Which DDC panel this loop connects to',
  '   - devices: List of FCU/VAV tag numbers on this path',
  '',
  '2. ALL DEVICE TAGS: Every FCU/VAV number you can read, even partially',
  '',
  '3. DDC PANELS visible',
  '',
  '4. ANNOTATIONS: Checkmarks, circles, handwritten notes',
  '',
  'Try HARD to read device numbers even if partially obscured by highlights.',
  '',
  'Return ONLY valid JSON:',
  '{',
  '  "loops": [{"loop_id":"LOOP-01","color":"pink","ddc_panel":"DDC-FF-02","devices":["FCU-20-45","FCU-20-46"]}],',
  '  "all_devices": ["FCU-20-45","FCU-20-46"],',
  '  "ddc_panels": [{"panel_id":"DDC-FF-02","position":"bottom-right"}],',
  '  "annotations": [{"type":"checkmark","near":"FCU-20-45","meaning":"done"}],',
  '  "floor": "SECOND FLOOR"',
  '}'
].join('\n')

/* ════════════════════════════════════════════════════════
   5.  COMBINE PDF + PHOTO RESULTS
   ════════════════════════════════════════════════════════ */

function combineResults(pdfResult, photoResult, onProgress) {
  if (onProgress) onProgress('Combining PDF data with photo analysis...')

  var pdfDevices = pdfResult.devices || []
  var photoLoops = photoResult.loops || []

  // Build lookup: tag → {room, thermostat}
  var deviceInfo = {}
  pdfDevices.forEach(function(d) {
    var tag = (d.tag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
    if (tag) deviceInfo[tag] = { room: d.room || '', thermostat: d.thermostat || '' }
  })

  // Enrich photo loops with PDF info
  var enrichedLoops = photoLoops.map(function(loop) {
    var loopDevices = (loop.devices || []).map(function(rawTag) {
      var tag = (rawTag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
      var info = deviceInfo[tag] || {}
      // Fuzzy match
      if (!info.room) {
        Object.keys(deviceInfo).forEach(function(k) {
          if (k.indexOf(tag) >= 0 || tag.indexOf(k) >= 0) info = deviceInfo[k]
        })
      }
      return { tag: tag, room: info.room || '', thermostat: info.thermostat || '' }
    })
    return {
      loopId: loop.loop_id || 'LOOP-?',
      color: loop.color || '',
      ddcPanel: loop.ddc_panel || '',
      devices: loopDevices,
      deviceCount: loopDevices.length
    }
  })

  // Unmatched PDF devices
  var matchedTags = {}
  enrichedLoops.forEach(function(l) { l.devices.forEach(function(d) { matchedTags[d.tag] = true }) })
  var unmatchedDevices = pdfDevices.filter(function(d) {
    var tag = (d.tag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
    return tag && !matchedTags[tag] && /^(FCU|VAV|AHU|PAU|ERU)/i.test(tag)
  }).map(function(d) {
    return { tag: (d.tag||'').toUpperCase().replace(/[^A-Z0-9-]/g,''), room: d.room||'', thermostat: d.thermostat||'' }
  })

  var totalMatched = enrichedLoops.reduce(function(s,l){return s+l.deviceCount},0)
  if (onProgress) onProgress(enrichedLoops.length + ' loops, ' + totalMatched + ' matched, ' + unmatchedDevices.length + ' unmatched')

  return {
    loops: enrichedLoops,
    ddcPanels: photoResult.ddc_panels || [],
    annotations: photoResult.annotations || [],
    floorLabel: photoResult.floor || pdfResult.floor || '',
    pdfStats: { totalDevices: pdfDevices.length, totalRooms: (pdfResult.rooms||[]).length },
    unmatchedDevices: unmatchedDevices,
    pdfRaw: pdfResult,
    photoRaw: photoResult
  }
}

/* ════════════════════════════════════════════════════════
   6.  MAIN ENTRY — ORCHESTRATOR
   ════════════════════════════════════════════════════════ */

function parseDrawings(pdfFile, photoFile, apiKey, onProgress) {
  var progress = onProgress || function() {}
  progress('Starting Drawing Import...')

  // Step 1: Upload PDF to Gemini File API
  return uploadToGemini(pdfFile, apiKey, progress)
    .then(function(fileUri) {
      // Step 2: Compress photo
      progress('Compressing highlighted photo...')
      return compressImage(photoFile, 3000, 0.85).then(function(photoImg) {
        progress('Photo: ' + photoImg.width + 'x' + photoImg.height + ' (' + photoImg.sizeKB + ' KB)')

        // Step 3: Analyze PDF via Gemini (using uploaded file)
        progress('Analyzing PDF with Gemini Vision...')
        return callGeminiWithFile(apiKey, PDF_PROMPT, fileUri, 'application/pdf', progress)
          .then(function(pdfResult) {
            var dc = (pdfResult.devices||[]).length
            var rc = (pdfResult.rooms||[]).length
            progress('PDF: ' + dc + ' devices, ' + rc + ' rooms found')

            // Step 4: Analyze highlighted photo via Gemini
            progress('Analyzing highlighted photo with Gemini Vision...')
            return callGeminiWithImage(apiKey, PHOTO_PROMPT, photoImg.base64, photoImg.mimeType, progress)
              .then(function(photoResult) {
                var lc = (photoResult.loops||[]).length
                progress('Photo: ' + lc + ' loops found')

                // Step 5: Combine
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

export { parseDrawings, uploadToGemini, compressImage, callGeminiWithFile, callGeminiWithImage, combineResults }
