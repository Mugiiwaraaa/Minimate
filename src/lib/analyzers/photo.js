/* --- analyzers/photo.js --- Marked photo / scanned page analyzer ---
   Traces highlighted loop paths in a full-sheet photo or a rasterized
   scanned page. Prompt carried over from drawingParser.js v5 PHOTO_PROMPT. */

import { compressImage, callGeminiWithImage } from '../geminiClient'

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

/* Analyze one full-sheet marked photo (File object).
   Returns: { loops:[{loop_id,color,ddc_panel,devices:[]}], ddc_panels:[], annotations:[], floor:'' } */
function analyzePhoto(file, apiKey, onProgress) {
  var progress = onProgress || function() {}
  progress('Compressing photo ' + (file.name || '') + '...')
  return compressImage(file, 3000, 0.85).then(function(img) {
    progress('Photo: ' + img.width + 'x' + img.height + ' (' + img.sizeKB + ' KB)')
    return analyzePhotoBase64(img.base64, img.mimeType, apiKey, progress)
  })
}

/* Analyze an already-rasterized page (base64). Used by MARKED_SCAN pdfs. */
function analyzePhotoBase64(base64, mimeType, apiKey, onProgress) {
  var progress = onProgress || function() {}
  progress('Analyzing marked sheet with Gemini...')
  return callGeminiWithImage(apiKey, PHOTO_PROMPT, base64, mimeType, progress)
    .then(function(result) {
      if (result && result.parse_error) {
        throw new Error('Photo analysis failed: ' + result.parse_error)
      }
      var lc = (result.loops || []).length
      progress('Marked sheet: ' + lc + ' loops found')
      return result
    })
}

export { analyzePhoto, analyzePhotoBase64, PHOTO_PROMPT }
