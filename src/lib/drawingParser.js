/* --- drawingParser.js --- Shop Drawing Import Engine v5 --- */
/* Spatial correlation: follow colored paths, find numbered markers, cross-reference PDF */

/* ================================================================
   0.  UTILITIES
   ================================================================ */

function normalizeKeys(obj) {
  if (Array.isArray(obj)) return obj.map(function(item) { return normalizeKeys(item) })
  if (obj && typeof obj === 'object') {
    var result = {}
    Object.keys(obj).forEach(function(k) {
      result[k.toLowerCase()] = normalizeKeys(obj[k])
    })
    return result
  }
  return obj
}

function repairJSON(str) {
  var s = str.trim()

  /* Walk the string tracking nesting and find the position after the last
     COMPLETE value (closing bracket/brace or comma between elements).
     Then truncate there and close any remaining open brackets in correct order. */

  var stack = []
  var inString = false
  var escaped = false
  var lastSafePos = 0   // position AFTER last complete value

  for (var i = 0; i < s.length; i++) {
    var ch = s[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inString) { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue

    if (ch === '{') {
      stack.push('}')
    } else if (ch === '[') {
      stack.push(']')
    } else if (ch === '}' || ch === ']') {
      if (stack.length > 0) stack.pop()
      lastSafePos = i + 1     // after a closing bracket = complete
    } else if (ch === ',') {
      lastSafePos = i         // just before comma = element before it is complete
    }
  }

  // If we're mid-value (string not closed, or trailing incomplete element),
  // truncate to last safe position
  if (lastSafePos > 0 && lastSafePos < s.length) {
    s = s.substring(0, lastSafePos)
  }

  // Remove trailing comma if present
  s = s.replace(/,\s*$/, '')

  // Re-scan to get accurate stack after truncation
  stack = []
  inString = false
  escaped = false
  for (var j = 0; j < s.length; j++) {
    var c = s[j]
    if (escaped) { escaped = false; continue }
    if (c === '\\' && inString) { escaped = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') { if (stack.length > 0) stack.pop() }
  }

  // Close in correct reverse nesting order
  while (stack.length > 0) { s += stack.pop() }

  return s
}

function extractJSON(text) {
  var clean = text
  if (clean.indexOf('```') >= 0) {
    clean = clean.replace(/^[^{]*```(?:json)?\s*/i, '')
    clean = clean.replace(/\s*```\s*$/, '')
  }
  var firstBrace = clean.indexOf('{')
  if (firstBrace < 0) return null
  var lastBrace = clean.lastIndexOf('}')
  if (lastBrace > firstBrace) return clean.substring(firstBrace, lastBrace + 1)
  return clean.substring(firstBrace)
}

/* ================================================================
   1.  IMAGE COMPRESSION HELPER
   ================================================================ */

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

/* ================================================================
   2.  GEMINI FILE UPLOAD API (for large PDFs)
   ================================================================ */

function uploadToGemini(file, apiKey, onProgress) {
  if (onProgress) onProgress('Uploading PDF to Gemini (' + Math.round(file.size/1024/1024) + ' MB)...')

  return new Promise(function(resolve, reject) {
    var reader = new FileReader()
    reader.onload = function() {
      var arrayBuffer = reader.result
      var startUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + apiKey
      var metadata = { file: { display_name: file.name || 'drawing.pdf' } }

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

        function checkState() {
          var name = fileInfo.file.name
          return fetch('https://generativelanguage.googleapis.com/v1beta/' + name + '?key=' + apiKey)
            .then(function(r) { return r.json() })
            .then(function(info) {
              console.log('[DRAWING] File state:', info.state)
              if (info.state === 'ACTIVE') return fileUri
              if (info.state === 'PROCESSING') {
                if (onProgress) onProgress('PDF processing on Gemini servers...')
                return new Promise(function(res) { setTimeout(res, 2000) }).then(checkState)
              }
              throw new Error('File processing failed: ' + info.state)
            })
        }
        return checkState()
      }).then(resolve).catch(reject)
    }
    reader.onerror = function() { reject(new Error('Failed to read PDF file')) }
    reader.readAsArrayBuffer(file)
  })
}

/* ================================================================
   3.  GEMINI API WITH MODEL FALLBACK + RETRY
   ================================================================ */

var MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro']

function callGeminiWithFile(apiKey, prompt, fileUri, fileMime, onProgress) {
  var body = {
    contents: [{
      parts: [
        { text: prompt },
        { file_data: { mime_type: fileMime, file_uri: fileUri } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      maxOutputTokens: 65536
    }
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
    generationConfig: {
      temperature: 0.0,
      responseMimeType: 'application/json',
      maxOutputTokens: 65536
    }
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
        if (onProgress) onProgress('Server busy - retrying in ' + wait + 's (attempt ' + (attempt + 1) + '/3)...')
        return new Promise(function(res) { setTimeout(res, wait * 1000) }).then(function() {
          return tryCall(model, attempt + 1)
        })
      }
      if (resp.status === 429 && attempt < 3) {
        var w2 = (attempt + 1) * 5
        if (onProgress) onProgress('Rate limited - retrying in ' + w2 + 's...')
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
    console.log('[DRAWING] Response keys:', Object.keys(data))

    var text = ''
    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      var parts = data.candidates[0].content.parts || []
      parts.forEach(function(p) { if (p.text) text += p.text })
    }
    console.log('[DRAWING] Text length:', text.length)
    console.log('[DRAWING] First 500 chars:', text.substring(0, 500))

    if (text.length === 0) {
      if (onProgress) onProgress('Empty response from Gemini')
      return { parse_error: 'empty_response', raw_data: data }
    }

    var jsonStr = extractJSON(text)
    if (!jsonStr) {
      if (onProgress) onProgress('No JSON object found in response')
      return { parse_error: 'no_json_found', raw_text: text.substring(0, 500) }
    }

    console.log('[DRAWING] Extracted JSON length:', jsonStr.length)

    try {
      var parsed = JSON.parse(jsonStr)
      console.log('[DRAWING] Parsed OK, keys:', Object.keys(parsed))
      if (onProgress) onProgress('Parsed OK: ' + Object.keys(parsed).join(', '))
      return normalizeKeys(parsed)
    } catch (e) {
      console.warn('[DRAWING] Parse failed, repairing...')
      if (onProgress) onProgress('Repairing truncated response...')

      var repaired = repairJSON(jsonStr)
      try {
        var parsed2 = JSON.parse(repaired)
        console.log('[DRAWING] Repair succeeded, keys:', Object.keys(parsed2))
        if (onProgress) onProgress('Repaired OK: ' + Object.keys(parsed2).join(', '))
        return normalizeKeys(parsed2)
      } catch (e2) {
        console.error('[DRAWING] Repair failed:', e2.message)
        console.error('[DRAWING] Repaired tail:', repaired.substring(repaired.length - 200))
        if (onProgress) onProgress('JSON repair failed - response too truncated')
        return { parse_error: e.message, raw_text: text.substring(0, 500) }
      }
    }
  })
}

/* ================================================================
   4.  PROMPTS — FCU-ROOM MAPPING + LOOP GROUPING
   ================================================================ */

var PDF_PROMPT = [
  'You are analyzing a BMS (Building Management System) CAD shop drawing.',
  '',
  'PRIMARY GOAL: Read every FCU device tag and identify which room it serves.',
  '',
  'How to find devices:',
  '- FCU tags appear in small labeled boxes (often yellow/highlighted), e.g. "FCU-28-02"',
  '- Below or near each FCU box is a thermostat tag, e.g. "FCU-28-02-TR"',
  '- Additional info may include AIR FLOW and B.O.U values — ignore these',
  '- Near each device is a ROOM LABEL BOX showing the room name and number, e.g. "LOBBY SF-078"',
  '',
  'For each device, record:',
  '- tag: the exact FCU/VAV/AHU tag as printed',
  '- thermostat: the thermostat tag (often ends in -TR)',
  '- room: the room name from the nearest labeled room box',
  '',
  'Also extract: ddc_panels, loop_labels (e.g. "LOOP-06"), floor name.',
  '',
  'RULES:',
  '- ONLY include tags you can READ. Do NOT invent or extrapolate sequential numbers.',
  '- Room names come from labeled boxes (e.g. "LOBBY SF-078", "HEALTH NEEDLES LIFE SKILLS COOKING"), NOT made-up names like "OFFICE 201".',
  '- If you cannot read a tag clearly, skip it.',
  '',
  '{"devices":[{"tag":"FCU-28-02","thermostat":"FCU-28-02-TR","room":"LOBBY SF-078"}],"rooms":["LOBBY SF-078"],"ddc_panels":["DDC-FF-04"],"loop_labels":["LOOP-06"],"floor":"SECOND FLOOR"}'
].join('\n')

var PHOTO_PROMPT = [
  'You are analyzing a HIGHLIGHTED BMS shop drawing photo from a site supervisor.',
  'The supervisor has drawn highlighted paths showing how communication cable loops are routed between FCU devices.',
  '',
  'UNDERSTANDING THE DRAWING:',
  '- Highlighted paths (often yellow, but could be any color) trace the physical cable routing for communication loops',
  '- A LOOP is a continuous highlighted path connecting multiple FCU devices to a DDC panel',
  '- The supervisor may use the SAME color for ALL loops. What separates loops is PATH CONTINUITY — two separate highlighted paths that do not connect are two different loops.',
  '- Along each path, the supervisor has written CIRCLED NUMBERS (1, 2, 3...) in red/dark ink next to each FCU device. These numbers show the device sequence on that loop.',
  '- A single loop typically has between 1 and 32 devices.',
  '',
  'YOUR TASK:',
  '1. Trace each continuous highlighted path. Each separate path = one loop.',
  '2. Along each path, find the circled sequence numbers (1, 2, 3...).',
  '3. At each numbered position, try to read the FCU tag printed on the drawing (e.g. "FCU-28-02").',
  '4. If you cannot read the FCU tag at a position, report "MARKER-N" where N is the circled number.',
  '5. Look for DDC panel labels — these are where loops originate/terminate.',
  '',
  'CRITICAL RULES:',
  '- ONLY report FCU tags you can ACTUALLY READ. Do NOT generate sequential numbers.',
  '- If you see circled numbers 1 through 22 but can only read 8 FCU tags, report 8 readable tags and the rest as MARKER-N.',
  '- Maximum 32 devices per loop.',
  '',
  '{"loops":[{"loop_id":"LOOP-01","color":"yellow","ddc_panel":"DDC-FF-04","devices":["FCU-28-02","FCU-28-03","MARKER-3","FCU-28-05"]}],"ddc_panels":["DDC-FF-04"],"annotations":[],"floor":"SECOND FLOOR"}'
].join('\n')

/* ================================================================
   5.  COMBINE PDF + PHOTO RESULTS (spatial matching)
   ================================================================ */

function combineResults(pdfResult, photoResult, onProgress) {
  if (onProgress) onProgress('Combining PDF data with photo analysis...')

  var pdfDevices = pdfResult.devices || []
  var photoLoops = photoResult.loops || []

  // Build lookup: tag -> {room, thermostat, pos}
  var deviceInfo = {}
  pdfDevices.forEach(function(d) {
    var tag = (d.tag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
    if (tag) deviceInfo[tag] = {
      room: d.room || '',
      thermostat: d.thermostat || ''
    }
  })

  // Enrich photo loops with PDF info
  var enrichedLoops = photoLoops.map(function(loop) {
    var rawDevices = loop.devices || []

    // Cap at 32 per loop (BMS physical limit)
    if (rawDevices.length > 32) {
      console.warn('[DRAWING] Loop ' + (loop.loop_id||'?') + ' has ' + rawDevices.length + ' devices - capping at 32')
      rawDevices = rawDevices.slice(0, 32)
    }

    var loopDevices = rawDevices.map(function(rawTag) {
      var tag = (rawTag || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
      var info = deviceInfo[tag] || {}

      // Fuzzy match if no exact match and not a MARKER placeholder
      if (!info.room && tag.indexOf('MARKER') < 0) {
        Object.keys(deviceInfo).forEach(function(k) {
          if (k.indexOf(tag) >= 0 || tag.indexOf(k) >= 0) info = deviceInfo[k]
        })
      }

      return { tag: tag, room: info.room || '', thermostat: info.thermostat || '' }
    })

    return {
      loopId: loop.loop_id || loop.loopid || 'LOOP-?',
      color: loop.color || '',
      ddcPanel: loop.ddc_panel || loop.ddcpanel || '',
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
    return {
      tag: (d.tag||'').toUpperCase().replace(/[^A-Z0-9-]/g,''),
      room: d.room||'',
      thermostat: d.thermostat||''
    }
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

/* ================================================================
   6.  MAIN ENTRY
   ================================================================ */

function parseDrawings(pdfFile, photoFile, apiKey, onProgress) {
  var progress = onProgress || function() {}
  progress('Starting Drawing Import...')

  return uploadToGemini(pdfFile, apiKey, progress)
    .then(function(fileUri) {
      progress('Compressing highlighted photo...')
      return compressImage(photoFile, 3000, 0.85).then(function(photoImg) {
        progress('Photo: ' + photoImg.width + 'x' + photoImg.height + ' (' + photoImg.sizeKB + ' KB)')

        progress('Analyzing PDF with Gemini...')
        return callGeminiWithFile(apiKey, PDF_PROMPT, fileUri, 'application/pdf', progress)
          .then(function(pdfResult) {
            var dc = (pdfResult.devices||[]).length
            var rc = (pdfResult.rooms||[]).length
            progress('PDF: ' + dc + ' devices, ' + rc + ' rooms found')

            progress('Analyzing highlighted photo with Gemini...')
            return callGeminiWithImage(apiKey, PHOTO_PROMPT, photoImg.base64, photoImg.mimeType, progress)
              .then(function(photoResult) {
                var lc = (photoResult.loops||[]).length
                progress('Photo: ' + lc + ' loops found')

                var combined = combineResults(pdfResult, photoResult, progress)
                progress('Drawing import complete!')
                return combined
              })
          })
      })
    })
}

/* ================================================================
   7.  EXPORTS
   ================================================================ */

export { parseDrawings, uploadToGemini, compressImage, callGeminiWithFile, callGeminiWithImage, combineResults }
