/* --- analyzers/sequence.js --- Zoomed photo sequence analyzer ---
   The supervisor walks ONE loop taking N zoomed photos in path order.
   Each photo is analyzed with sequence context; seams are deduped in
   CODE (not AI) by tag match at the boundary. */

import { compressImage, callGeminiWithImage } from '../geminiClient'

function buildSequencePrompt(photoIndex, photoCount, prevTags) {
  var lines = [
    'You are analyzing a ZOOMED-IN photo of a BMS shop drawing. It is photo ' + (photoIndex + 1) + ' of ' + photoCount + ',',
    'all following ONE SINGLE communication loop that a site supervisor highlighted with a marker.',
    'The photos were taken IN ORDER along the loop path.',
    '',
    'WHAT YOU SEE:',
    '- A highlighted path (any color) passing through FCU devices',
    '- FCU tags in small labeled boxes, e.g. "FCU-28-02"',
    '- Circled sequence numbers (1, 2, 3...) in red/dark ink next to devices',
    '- Possibly a room label box near each device, e.g. "LOBBY SF-078"',
    ''
  ]
  if (prevTags && prevTags.length > 0) {
    lines.push('CONTEXT: The previous photo ended at these devices (in order): ' + prevTags.join(', ') + '.')
    lines.push('This photo may OVERLAP with the previous one — the first device(s) you see may repeat the tags above. Report them anyway; overlap is removed later.')
    lines.push('')
  }
  lines = lines.concat([
    'YOUR TASK:',
    '1. Follow the highlighted path through this photo.',
    '2. List every device ON the path, IN PATH ORDER.',
    '3. For each device record: tag (exactly as printed), circled sequence number if visible, room label if visible.',
    '4. If a tag is not readable, use "MARKER-N" where N is the circled number, or "UNREADABLE" if no number.',
    '',
    'CRITICAL RULES:',
    '- ONLY report tags you can ACTUALLY READ. Do NOT invent or extrapolate sequential numbers.',
    '- Room names come from labeled boxes, NOT made-up names.',
    '- Devices NOT on the highlighted path must be ignored.',
    '',
    '{"devices":[{"tag":"FCU-28-02","seq":4,"room":"LOBBY SF-078"}],"ddc_panels":[],"floor":""}'
  ])
  return lines.join('\n')
}

/* Dedupe the seam between two consecutive photo segments.
   The last 1-2 tags of the previous segment may reappear at the start
   of the next. Match on cleaned tag. */
function dedupeSeam(allDevices, segment) {
  if (allDevices.length === 0) return segment
  var tailTags = allDevices.slice(-3).map(function(d) { return d.tag })
  var out = segment.slice()
  // Drop leading devices of the new segment that already appear in the tail
  while (out.length > 0 && tailTags.indexOf(out[0].tag) >= 0) {
    out.shift()
  }
  return out
}

function cleanTag(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

/* Analyze an ORDERED list of zoomed photos following one loop.
   Returns photo-result shape so the merge step treats it like any
   other loop source:
   { loops:[{loop_id:'LOOP-SEQ', color:'', ddc_panel, devices:[tags], rooms:{tag:room}}],
     ddc_panels:[], annotations:[], floor:'' } */
function analyzeSequence(files, apiKey, onProgress) {
  var progress = onProgress || function() {}
  var allDevices = []   // [{tag, seq, room}]
  var ddcPanels = []
  var floor = ''

  function processPhoto(idx) {
    if (idx >= files.length) return Promise.resolve()
    var file = files[idx]
    progress('Sequence photo ' + (idx + 1) + '/' + files.length + ': compressing...')
    return compressImage(file, 3000, 0.85).then(function(img) {
      var prevTags = allDevices.slice(-2).map(function(d) { return d.tag })
      var prompt = buildSequencePrompt(idx, files.length, prevTags)
      progress('Sequence photo ' + (idx + 1) + '/' + files.length + ': analyzing...')
      return callGeminiWithImage(apiKey, prompt, img.base64, img.mimeType, progress)
    }).then(function(result) {
      if (result && result.parse_error) {
        throw new Error('Photo ' + (idx + 1) + ' analysis failed: ' + result.parse_error)
      }
      var segment = (result.devices || []).map(function(d) {
        return { tag: cleanTag(d.tag), seq: d.seq || null, room: d.room || '' }
      }).filter(function(d) { return d.tag })

      var deduped = dedupeSeam(allDevices, segment)
      progress('Photo ' + (idx + 1) + ': ' + segment.length + ' devices (' + (segment.length - deduped.length) + ' overlap removed)')

      allDevices = allDevices.concat(deduped)
      ;(result.ddc_panels || []).forEach(function(p) {
        if (p && ddcPanels.indexOf(p) < 0) ddcPanels.push(p)
      })
      if (!floor && result.floor) floor = result.floor

      return processPhoto(idx + 1)
    })
  }

  return processPhoto(0).then(function() {
    // Cap at BMS physical maximum
    if (allDevices.length > 32) {
      console.warn('[SEQUENCE] ' + allDevices.length + ' devices - capping at 32')
      allDevices = allDevices.slice(0, 32)
    }
    progress('Sequence complete: ' + allDevices.length + ' devices on loop')

    // Room info discovered from zoomed photos rides along per tag
    var rooms = {}
    allDevices.forEach(function(d) { if (d.room) rooms[d.tag] = d.room })

    return {
      loops: [{
        loop_id: 'LOOP-SEQ',
        color: '',
        ddc_panel: ddcPanels[0] || '',
        devices: allDevices.map(function(d) { return d.tag }),
        rooms: rooms
      }],
      ddc_panels: ddcPanels,
      annotations: [],
      floor: floor
    }
  })
}

export { analyzeSequence }
