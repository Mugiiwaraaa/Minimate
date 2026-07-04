/* --- analyzers/pinExtract.js --- Device pin extraction with coordinates ---
   Runs on the RENDERED PAGE IMAGE (works for scans AND true CAD PDFs).
   Returns device tags + normalized center coordinates so Trace Studio
   can drop pins on the drawing. The human verifies/corrects the pins;
   the AI never decides loops. */

import { callGeminiWithImage } from '../geminiClient'

var PIN_PROMPT = [
  'You are analyzing one page of a BMS (Building Management System) shop drawing image.',
  '',
  'GOAL: Locate every BMS device tag printed on the drawing, WITH its position.',
  'Device families: FCU, VAV, AHU, PAU, ERU, PMU (power meter), WM (water meter), BTU (energy meter).',
  '',
  'How to find devices:',
  '- Device tags appear in small labeled boxes, e.g. "FCU-28-02", "PMU-03", "WM-12", "BTU-05". A thermostat tag like "FCU-28-02-TR" is often below it.',
  '- Near each device there may be a ROOM LABEL BOX with the room name, e.g. "LOBBY SF-078".',
  '',
  'For each device report:',
  '- tag: the exact device tag as printed',
  '- thermostat: the thermostat tag if visible (often ends in -TR), else ""',
  '- room: the room name from the nearest labeled room box, else ""',
  '- box: [ymin, xmin, ymax, xmax] of the printed TAG TEXT, integers normalized to 0-1000 of the image',
  '',
  'RULES:',
  '- ONLY report tags you can ACTUALLY READ. Do NOT invent or extrapolate sequential numbers.',
  '- The box must TIGHTLY enclose the tag text only, not the whole device or region.',
  '- Room names come from labeled boxes, NOT made-up names.',
  '- If you cannot read a tag clearly, skip it entirely.',
  '',
  '{"devices":[{"tag":"FCU-28-02","thermostat":"FCU-28-02-TR","room":"LOBBY SF-078","box":[412,118,428,161]}],"floor":"SECOND FLOOR"}'
].join('\n')

function cleanTag(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

/* imageBase64: JPEG of the rendered page.
   Returns { pins:[{tag,thermostat,room,x,y}], floor } with x/y normalized 0-1 (tag center). */
function extractPins(imageBase64, apiKey, onProgress) {
  var progress = onProgress || function() {}
  progress('AI locating device tags on the drawing...')

  return callGeminiWithImage(apiKey, PIN_PROMPT, imageBase64, 'image/jpeg', progress)
    .then(function(result) {
      if (result && result.parse_error) {
        throw new Error('Pin extraction failed: ' + result.parse_error)
      }
      var raw = result.devices || []
      var pins = []
      var seen = {}

      raw.forEach(function(d) {
        var tag = cleanTag(d.tag)
        if (!tag || seen[tag]) return
        var box = d.box
        if (!Array.isArray(box) || box.length !== 4) return
        var ymin = Number(box[0]); var xmin = Number(box[1])
        var ymax = Number(box[2]); var xmax = Number(box[3])
        if (!(isFinite(ymin) && isFinite(xmin) && isFinite(ymax) && isFinite(xmax))) return
        if (ymax <= ymin || xmax <= xmin) return
        // Sanity: a tag label is tiny. Reject hallucinated region-sized boxes (>2% of page area).
        var area = ((ymax - ymin) / 1000) * ((xmax - xmin) / 1000)
        if (area > 0.02) return
        seen[tag] = true
        pins.push({
          tag: tag,
          thermostat: (d.thermostat || '').toUpperCase().trim(),
          room: (d.room || '').toUpperCase().trim(),
          x: ((xmin + xmax) / 2) / 1000,
          y: ((ymin + ymax) / 2) / 1000
        })
      })

      progress('AI found ' + pins.length + ' device tags (' + (raw.length - pins.length) + ' rejected by sanity checks)')
      return { pins: pins, floor: (result.floor || '').toUpperCase() }
    })
}

export { extractPins, PIN_PROMPT }
