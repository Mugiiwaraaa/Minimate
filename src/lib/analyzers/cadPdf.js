/* --- analyzers/cadPdf.js --- CAD PDF analyzer ---
   Extracts device tags, thermostats, rooms, panels from a clean CAD PDF.
   Prompt carried over from drawingParser.js v5 PDF_PROMPT. */

import { uploadToGemini, callGeminiWithFile } from '../geminiClient'

var PDF_PROMPT = [
  'You are analyzing a BMS (Building Management System) CAD shop drawing.',
  '',
  'PRIMARY GOAL: Read every BMS device tag (FCU, VAV, AHU, PAU, ERU, PMU power meters, WM water meters, BTU energy meters) and identify which room it serves.',
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

/* Analyze one CAD PDF file.
   Returns: { devices:[{tag,thermostat,room}], rooms:[], ddc_panels:[], loop_labels:[], floor:'' } */
function analyzeCadPdf(file, apiKey, onProgress) {
  var progress = onProgress || function() {}
  return uploadToGemini(file, apiKey, progress).then(function(fileUri) {
    progress('Analyzing CAD PDF ' + (file.name || '') + '...')
    return callGeminiWithFile(apiKey, PDF_PROMPT, fileUri, 'application/pdf', progress)
      .then(function(result) {
        if (result && result.parse_error) {
          throw new Error('CAD PDF analysis failed: ' + result.parse_error)
        }
        var dc = (result.devices || []).length
        var rc = (result.rooms || []).length
        progress('CAD PDF: ' + dc + ' devices, ' + rc + ' rooms found')
        return result
      })
  })
}

export { analyzeCadPdf, PDF_PROMPT }
