/* --- TraceStudio.jsx --- v2 --- In-app loop tracing on the drawing ---
   The core inversion: AI locates, human traces, code resolves.
   v2 adds: mobile toolbar, richer pins (serial/address/room), text picking
   (PDF text layer OR AI crop-read on scans/images), right-drag pan while
   tracing, image file support, orthogonal stroke straightening, zone
   rectangles, cable remarks between devices, reopen/edit saved drawings. */

import { useState, useEffect, useRef } from 'react'
import { extractPins } from '../lib/analyzers/pinExtract'
import { callGeminiWithImage } from '../lib/geminiClient'
import { putFile } from '../lib/fileStore'

var LOOP_COLORS = ['#22D3EE', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#EC4899']

var tsIdCounter = 0
function nid(prefix) {
  tsIdCounter++
  return prefix + '-' + Date.now() + '-' + tsIdCounter
}

function up(v) { return (v || '').toUpperCase().trim() }

function isImageFile(file) {
  return (file.type || '').indexOf('image/') === 0
}

/* Ramer-Douglas-Peucker polyline simplification (points in page px) */
function rdp(points, eps) {
  if (points.length < 3) return points
  var dmax = 0
  var index = 0
  var a = points[0]
  var b = points[points.length - 1]
  for (var i = 1; i < points.length - 1; i++) {
    var d = perpDist(points[i], a, b)
    if (d > dmax) { dmax = d; index = i }
  }
  if (dmax > eps) {
    var left = rdp(points.slice(0, index + 1), eps)
    var right = rdp(points.slice(index), eps)
    return left.slice(0, -1).concat(right)
  }
  return [a, b]
}

function perpDist(p, a, b) {
  var dx = b.x - a.x
  var dy = b.y - a.y
  var len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  if (t < 0) t = 0
  if (t > 1) t = 1
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/* Orthogonal straightening: snap each segment of a simplified polyline
   to the nearest 45-degree multiple when within tolerance. */
function straightenPolyline(points, tolDeg) {
  if (points.length < 2) return points
  var tol = (tolDeg || 15) * Math.PI / 180
  var out = [points[0]]
  for (var i = 1; i < points.length; i++) {
    var prev = out[i - 1]
    var cur = points[i]
    var dx = cur.x - prev.x
    var dy = cur.y - prev.y
    var r = Math.hypot(dx, dy)
    if (r === 0) { out.push(cur); continue }
    var ang = Math.atan2(dy, dx)
    var snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
    if (Math.abs(ang - snap) <= tol) {
      out.push({ x: prev.x + r * Math.cos(snap), y: prev.y + r * Math.sin(snap) })
    } else {
      out.push(cur)
    }
  }
  return out
}

/* Prompt for reading ONE small cropped label from a scan */
var CROP_READ_PROMPT = [
  'This is a small cropped region of a technical building drawing.',
  'Read the printed text in the crop. Return ONLY what is actually printed.',
  'If there are multiple short lines, join them with a single space.',
  'Do NOT invent, complete, or extrapolate text.',
  '{"text":"FCU-28-02"}'
].join('\n')

export default function TraceStudio(props) {
  // props: file (File), record (optional saved drawing to re-edit),
  //        onCancel(), onComplete(result, drawingRecord)
  var rec = props.record || null

  var loadingState = useState(true)
  var loading = loadingState[0]
  var setLoading = loadingState[1]
  var errState = useState(null)
  var error = errState[0]
  var setError = errState[1]
  var pageCountState = useState(1)
  var pageCount = pageCountState[0]
  var setPageCount = pageCountState[1]
  var pageNumState = useState(1)
  var pageNum = pageNumState[0]
  var setPageNum = pageNumState[1]
  var modeState = useState('pan') // pan | pin | trace | zone
  var mode = modeState[0]
  var setMode = modeState[1]
  var pinsState = useState(rec ? (rec.tags || []) : [])
  var pins = pinsState[0]
  var setPins = pinsState[1]
  var loopsState = useState(rec ? (rec.traces || []).map(function(t) {
    return { id: t.id, name: t.name, color: t.color, page: t.page || 1, strokes: t.strokes || [], deviceIds: t.deviceIds || [], remarks: t.remarks || [] }
  }) : [])
  var loops = loopsState[0]
  var setLoops = loopsState[1]
  var zonesState = useState(rec ? (rec.zones || []) : []) // {id,name,x1,y1,x2,y2,page} normalized
  var zones = zonesState[0]
  var setZones = zonesState[1]
  var metaState = useState({
    name: rec ? (rec.name || '') : up((props.file.name || 'DRAWING').replace(/\.(PDF|JPG|JPEG|PNG|WEBP)$/i, '')),
    floor: rec ? (rec.floor || '') : '',
    block: rec ? (rec.block || '') : '',
    zone: rec ? (rec.zone || '') : ''
  })
  var meta = metaState[0]
  var setMeta = metaState[1]
  var activeLoopState = useState(null)
  var activeLoopId = activeLoopState[0]
  var setActiveLoopId = activeLoopState[1]
  var aiBusyState = useState(false)
  var aiBusy = aiBusyState[0]
  var setAiBusy = aiBusyState[1]
  var aiMsgState = useState('')
  var aiMsg = aiMsgState[0]
  var setAiMsg = aiMsgState[1]
  var editPinState = useState(null)
  var editPinId = editPinState[0]
  var setEditPinId = editPinState[1]
  var editZoneState = useState(null)
  var editZoneId = editZoneState[0]
  var setEditZoneId = editZoneState[1]
  var editRemarkState = useState(null) // {loopId, afterIndex}
  var editRemark = editRemarkState[0]
  var setEditRemark = editRemarkState[1]
  var pickState = useState(null) // {pinId, field}
  var pickField = pickState[0]
  var setPickField = pickState[1]
  var straightenState = useState(true)
  var straighten = straightenState[0]
  var setStraighten = straightenState[1]
  var panelOpenState = useState(false)
  var panelOpen = panelOpenState[0]
  var setPanelOpen = panelOpenState[1]
  var hasTextLayerState = useState(false)
  var hasTextLayer = hasTextLayerState[0]
  var setHasTextLayer = hasTextLayerState[1]

  // ─── Refs ──────────────────────────────────────────────────
  var canvasRef = useRef(null)
  var wrapRef = useRef(null)
  var pdfRef = useRef(null)
  var pageImgRef = useRef(null)
  var textItemsRef = useRef([])     // [{str,x,y,page}] page px (text-layer PDFs only)
  var viewRef = useRef({ scale: 1, tx: 0, ty: 0 })
  var pointersRef = useRef({})
  var gestureRef = useRef(null)
  var strokeRef = useRef([])
  var tempZoneRef = useRef(null)    // live rectangle while dragging, page px
  var fileHashRef = useRef(rec ? (rec.fileHash || '') : '')
  var rafRef = useRef(0)

  var pinsRef = useRef(pins);               pinsRef.current = pins
  var loopsRef = useRef(loops);             loopsRef.current = loops
  var zonesRef = useRef(zones);             zonesRef.current = zones
  var activeLoopRef = useRef(activeLoopId); activeLoopRef.current = activeLoopId
  var pageRef = useRef(pageNum);            pageRef.current = pageNum
  var modeRef = useRef(mode);               modeRef.current = mode
  var pickRef = useRef(pickField);          pickRef.current = pickField

  // ─── Load file (PDF or image) + render ─────────────────────
  useEffect(function() {
    var cancelled = false

    putFile(props.file).then(function(hash) {
      fileHashRef.current = hash
    }).catch(function() { /* cache is best-effort */ })

    if (isImageFile(props.file)) {
      var reader = new FileReader()
      reader.onload = function() {
        var img = new Image()
        img.onload = function() {
          if (cancelled) return
          var off = document.createElement('canvas')
          off.width = img.width
          off.height = img.height
          off.getContext('2d').drawImage(img, 0, 0)
          pageImgRef.current = off
          setPageCount(1)
          setLoading(false)
          fitView()
        }
        img.onerror = function() { if (!cancelled) { setError('FAILED TO LOAD IMAGE'); setLoading(false) } }
        img.src = reader.result
      }
      reader.onerror = function() { if (!cancelled) { setError('FAILED TO READ IMAGE'); setLoading(false) } }
      reader.readAsDataURL(props.file)
      return function() { cancelled = true }
    }

    if (!window.pdfjsLib) { setError('PDF.JS NOT LOADED'); setLoading(false); return }
    props.file.arrayBuffer().then(function(buf) {
      return window.pdfjsLib.getDocument({ data: buf }).promise
    }).then(function(pdf) {
      if (cancelled) return
      pdfRef.current = pdf
      setPageCount(pdf.numPages)
      return renderPage(1)
    }).catch(function(err) {
      if (!cancelled) { setError(err.message || 'FAILED TO OPEN PDF'); setLoading(false) }
    })
    return function() { cancelled = true }
  }, [])

  function renderPage(n) {
    var pdf = pdfRef.current
    if (!pdf) return Promise.resolve()
    setLoading(true)
    return pdf.getPage(n).then(function(page) {
      var vp1 = page.getViewport({ scale: 1 })
      var maxDim = 4096
      var scale = Math.min(maxDim / vp1.width, maxDim / vp1.height)
      if (scale > 4) scale = 4
      var vp = page.getViewport({ scale: scale })
      var off = document.createElement('canvas')
      off.width = Math.round(vp.width)
      off.height = Math.round(vp.height)
      var ctx = off.getContext('2d')
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function() {
        pageImgRef.current = off
        // Text layer (true CAD PDFs) -> selectable labels
        return page.getTextContent().then(function(content) {
          var items = []
          ;(content.items || []).forEach(function(it) {
            if (!it.str || !it.str.trim()) return
            var p = vp.convertToViewportPoint(it.transform[4], it.transform[5])
            items.push({ str: it.str.trim(), x: p[0], y: p[1], page: n })
          })
          textItemsRef.current = textItemsRef.current.filter(function(t) { return t.page !== n }).concat(items)
          setHasTextLayer(items.length >= 25)
        }).catch(function() { setHasTextLayer(false) })
      }).then(function() {
        setPageNum(n)
        pageRef.current = n
        setLoading(false)
        fitView()
      })
    }).catch(function(err) {
      setError(err.message || 'PAGE RENDER FAILED')
      setLoading(false)
    })
  }

  function fitView() {
    var img = pageImgRef.current
    var canvas = canvasRef.current
    if (!img || !canvas) return
    var s = Math.min(canvas.width / img.width, canvas.height / img.height) * 0.97
    viewRef.current = {
      scale: s,
      tx: (canvas.width - img.width * s) / 2,
      ty: (canvas.height - img.height * s) / 2
    }
    requestDraw()
  }

  // ─── Canvas sizing ─────────────────────────────────────────
  useEffect(function() {
    function resize() {
      var canvas = canvasRef.current
      var wrap = wrapRef.current
      if (!canvas || !wrap) return
      canvas.width = wrap.clientWidth
      canvas.height = wrap.clientHeight
      requestDraw()
    }
    resize()
    window.addEventListener('resize', resize)
    return function() { window.removeEventListener('resize', resize) }
  }, [panelOpen])

  // Wheel zoom must be non-passive
  useEffect(function() {
    var canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return function() { canvas.removeEventListener('wheel', onWheel) }
  }, [])

  // ─── Draw ──────────────────────────────────────────────────
  function requestDraw() {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(function() {
      rafRef.current = 0
      draw()
    })
  }

  function draw() {
    var canvas = canvasRef.current
    var img = pageImgRef.current
    if (!canvas) return
    var ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#0F172A'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (!img) return

    var v = viewRef.current
    ctx.setTransform(v.scale, 0, 0, v.scale, v.tx, v.ty)
    ctx.drawImage(img, 0, 0)

    var W = img.width
    var H = img.height
    var page = pageRef.current

    // Zones (under strokes)
    zonesRef.current.forEach(function(z) {
      if ((z.page || 1) !== page) return
      var x = z.x1 * W
      var y = z.y1 * H
      var w = (z.x2 - z.x1) * W
      var h = (z.y2 - z.y1) * H
      ctx.fillStyle = 'rgba(139,92,246,0.10)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = '#8B5CF6'
      ctx.lineWidth = 2 / v.scale
      ctx.setLineDash([8 / v.scale, 6 / v.scale])
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([])
      ctx.fillStyle = '#8B5CF6'
      ctx.font = 'bold ' + (14 / v.scale) + 'px Inter, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(z.name, x + 6 / v.scale, y + 6 / v.scale)
    })

    // Live zone rectangle
    var tz = tempZoneRef.current
    if (tz) {
      ctx.strokeStyle = '#8B5CF6'
      ctx.lineWidth = 2 / v.scale
      ctx.setLineDash([8 / v.scale, 6 / v.scale])
      ctx.strokeRect(Math.min(tz.x1, tz.x2), Math.min(tz.y1, tz.y2), Math.abs(tz.x2 - tz.x1), Math.abs(tz.y2 - tz.y1))
      ctx.setLineDash([])
    }

    // Strokes per loop
    loopsRef.current.forEach(function(loop) {
      if ((loop.page || 1) !== page) return
      ctx.strokeStyle = loop.color
      ctx.globalAlpha = loop.id === activeLoopRef.current ? 0.85 : 0.45
      ctx.lineWidth = 5 / v.scale
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      loop.strokes.forEach(function(stroke) {
        if (stroke.length < 2) return
        ctx.beginPath()
        ctx.moveTo(stroke[0].x, stroke[0].y)
        for (var i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y)
        ctx.stroke()
      })
    })
    ctx.globalAlpha = 1

    // Current stroke
    var cur = strokeRef.current
    if (cur.length > 1) {
      var al = loopsRef.current.find(function(l) { return l.id === activeLoopRef.current })
      ctx.strokeStyle = al ? al.color : '#22D3EE'
      ctx.lineWidth = 5 / v.scale
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(cur[0].x, cur[0].y)
      for (var j = 1; j < cur.length; j++) ctx.lineTo(cur[j].x, cur[j].y)
      ctx.stroke()
    }

    // Pin -> loop lookup
    var pinLoop = {}
    loopsRef.current.forEach(function(loop) {
      loop.deviceIds.forEach(function(pid) { pinLoop[pid] = loop })
    })

    // Pins
    var r = 10 / v.scale
    var showLabels = v.scale * W > 1400
    pinsRef.current.forEach(function(pin) {
      if ((pin.page || 1) !== page) return
      var px = pin.x * W
      var py = pin.y * H
      var lp = pinLoop[pin.id]
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.fillStyle = lp ? lp.color : (pin.source === 'ai' ? 'rgba(34,211,238,0.9)' : 'rgba(248,250,252,0.9)')
      ctx.fill()
      ctx.lineWidth = 2 / v.scale
      ctx.strokeStyle = '#0F172A'
      ctx.stroke()
      if (lp) {
        var seq = lp.deviceIds.indexOf(pin.id) + 1
        ctx.fillStyle = '#0F172A'
        ctx.font = 'bold ' + (11 / v.scale) + 'px Inter, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(seq), px, py)
      }
      if (showLabels) {
        // Serial number is the on-drawing label (falls back to tag)
        var label = pin.serial || pin.tag
        ctx.fillStyle = lp ? lp.color : '#22D3EE'
        ctx.font = 'bold ' + (12 / v.scale) + 'px Inter, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(label, px, py - r - 3 / v.scale)
      }
    })
  }

  useEffect(function() { requestDraw() })

  // ─── Coordinate helpers ────────────────────────────────────
  function toPage(clientX, clientY) {
    var canvas = canvasRef.current
    var rect = canvas.getBoundingClientRect()
    var v = viewRef.current
    return {
      x: (clientX - rect.left - v.tx) / v.scale,
      y: (clientY - rect.top - v.ty) / v.scale
    }
  }

  function hitPin(pagePt) {
    var img = pageImgRef.current
    if (!img) return null
    var v = viewRef.current
    var r = 16 / v.scale
    var page = pageRef.current
    var found = null
    pinsRef.current.forEach(function(pin) {
      if ((pin.page || 1) !== page) return
      var dx = pin.x * img.width - pagePt.x
      var dy = pin.y * img.height - pagePt.y
      if (Math.hypot(dx, dy) <= r) found = pin
    })
    return found
  }

  // ─── Text picking (text layer OR AI crop-read) ─────────────
  function pickTextAt(pagePt) {
    var pf = pickRef.current
    if (!pf) return
    var page = pageRef.current

    // 1) Text layer: nearest item wins (instant, free)
    var items = textItemsRef.current.filter(function(t) { return t.page === page })
    if (items.length >= 25) {
      var best = null
      var bestD = 60 / viewRef.current.scale
      items.forEach(function(t) {
        var d = Math.hypot(t.x - pagePt.x, t.y - pagePt.y)
        if (d < bestD) { bestD = d; best = t }
      })
      setPickField(null)
      if (best) {
        updatePin(pf.pinId, pickPatch(pf.field, best.str))
        setAiMsg('PICKED: ' + up(best.str))
      } else {
        setAiMsg('NO TEXT NEAR TAP — ZOOM IN AND TRY AGAIN')
      }
      return
    }

    // 2) Scan/image: crop around the tap and AI-read the pixels
    var img = pageImgRef.current
    if (!img) return
    var apiKey = localStorage.getItem('minimate_gemini_key') || ''
    if (!apiKey) { setPickField(null); setAiMsg('NO GEMINI KEY — SET IT VIA IMPORT DRAWINGS'); return }

    var cw = 440
    var ch = 220
    var x0 = Math.max(0, Math.min(img.width - cw, pagePt.x - cw / 2))
    var y0 = Math.max(0, Math.min(img.height - ch, pagePt.y - ch / 2))
    var c = document.createElement('canvas')
    c.width = cw * 2
    c.height = ch * 2
    var cctx = c.getContext('2d')
    cctx.imageSmoothingEnabled = false
    cctx.drawImage(img, x0, y0, cw, ch, 0, 0, cw * 2, ch * 2)
    var base64 = c.toDataURL('image/jpeg', 0.92).split(',')[1]

    setPickField(null)
    setAiBusy(true)
    setAiMsg('AI READING LABEL FROM PIXELS...')
    callGeminiWithImage(apiKey, CROP_READ_PROMPT, base64, 'image/jpeg', null)
      .then(function(res) {
        setAiBusy(false)
        var text = res && res.text ? up(res.text) : ''
        if (!text || res.parse_error) { setAiMsg('COULD NOT READ TEXT THERE — ZOOM IN OR TYPE IT'); return }
        updatePin(pf.pinId, pickPatch(pf.field, text))
        setAiMsg('READ FROM DRAWING: ' + text)
        setEditPinId(pf.pinId)
      })
      .catch(function(err) {
        setAiBusy(false)
        setAiMsg('READ FAILED: ' + up(err.message).substring(0, 100))
      })
  }

  function pickPatch(field, raw) {
    var patch = {}
    patch[field] = up(raw)
    return patch
  }

  // ─── Loop management ───────────────────────────────────────
  function newLoop() {
    var idx = loopsRef.current.length
    var loop = {
      id: nid('tloop'),
      name: 'LOOP-' + (idx + 1 < 10 ? '0' : '') + (idx + 1),
      color: LOOP_COLORS[idx % LOOP_COLORS.length],
      page: pageRef.current,
      deviceIds: [],
      strokes: [],
      remarks: []
    }
    loopsRef.current = loopsRef.current.concat([loop])
    setLoops(loopsRef.current)
    setActiveLoopId(loop.id)
    activeLoopRef.current = loop.id
    return loop
  }

  function ensureActiveLoop() {
    var al = loopsRef.current.find(function(l) { return l.id === activeLoopRef.current })
    if (al) return al
    return newLoop()
  }

  // ─── Gestures ──────────────────────────────────────────────
  function onPointerDown(e) {
    var canvas = canvasRef.current
    canvas.setPointerCapture(e.pointerId)
    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY }
    var ids = Object.keys(pointersRef.current)

    if (ids.length === 2) {
      strokeRef.current = []
      tempZoneRef.current = null
      var p1 = pointersRef.current[ids[0]]
      var p2 = pointersRef.current[ids[1]]
      gestureRef.current = {
        type: 'pinch',
        d0: Math.hypot(p2.x - p1.x, p2.y - p1.y),
        c0: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        v0: Object.assign({}, viewRef.current)
      }
      return
    }

    var pt = toPage(e.clientX, e.clientY)

    // Right-drag pans in ANY mode (navigate mid-trace on desktop)
    if (e.button === 2) {
      gestureRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, v0: Object.assign({}, viewRef.current) }
      return
    }

    // Text picking intercepts the next tap in any mode
    if (pickRef.current) {
      gestureRef.current = { type: 'picktap', pt: pt, moved: false, startX: e.clientX, startY: e.clientY }
      return
    }

    var m = modeRef.current

    if (m === 'pin') {
      var hit = hitPin(pt)
      if (hit) {
        gestureRef.current = { type: 'dragpin', pinId: hit.id, moved: false }
      } else {
        gestureRef.current = { type: 'addpin', pt: pt, moved: false, startX: e.clientX, startY: e.clientY }
      }
      return
    }

    if (m === 'trace') {
      ensureActiveLoop()
      gestureRef.current = { type: 'stroke' }
      strokeRef.current = [pt]
      return
    }

    if (m === 'zone') {
      gestureRef.current = { type: 'zone', start: pt }
      tempZoneRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
      return
    }

    gestureRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, v0: Object.assign({}, viewRef.current) }
  }

  function onPointerMove(e) {
    if (!pointersRef.current[e.pointerId]) return
    pointersRef.current[e.pointerId] = { x: e.clientX, y: e.clientY }
    var g = gestureRef.current
    if (!g) return

    if (g.type === 'pinch') {
      var ids = Object.keys(pointersRef.current)
      if (ids.length < 2) return
      var p1 = pointersRef.current[ids[0]]
      var p2 = pointersRef.current[ids[1]]
      var d = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      var c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
      var k = g.d0 > 0 ? d / g.d0 : 1
      var ns = Math.max(0.05, Math.min(12, g.v0.scale * k))
      var rect = canvasRef.current.getBoundingClientRect()
      var cx = g.c0.x - rect.left
      var cy = g.c0.y - rect.top
      viewRef.current = {
        scale: ns,
        tx: cx - (cx - g.v0.tx) * (ns / g.v0.scale) + (c.x - g.c0.x),
        ty: cy - (cy - g.v0.ty) * (ns / g.v0.scale) + (c.y - g.c0.y)
      }
      requestDraw()
      return
    }

    if (g.type === 'pan') {
      viewRef.current = {
        scale: g.v0.scale,
        tx: g.v0.tx + (e.clientX - g.startX),
        ty: g.v0.ty + (e.clientY - g.startY)
      }
      requestDraw()
      return
    }

    if (g.type === 'dragpin') {
      var pt = toPage(e.clientX, e.clientY)
      var img = pageImgRef.current
      if (!img) return
      g.moved = true
      pinsRef.current = pinsRef.current.map(function(p) {
        if (p.id !== g.pinId) return p
        return Object.assign({}, p, { x: pt.x / img.width, y: pt.y / img.height })
      })
      setPins(pinsRef.current)
      requestDraw()
      return
    }

    if (g.type === 'addpin' || g.type === 'picktap') {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 8) g.moved = true
      return
    }

    if (g.type === 'zone') {
      var zp = toPage(e.clientX, e.clientY)
      tempZoneRef.current = { x1: g.start.x, y1: g.start.y, x2: zp.x, y2: zp.y }
      requestDraw()
      return
    }

    if (g.type === 'stroke') {
      var pt2 = toPage(e.clientX, e.clientY)
      var s = strokeRef.current
      var last = s[s.length - 1]
      var minStep = 3 / viewRef.current.scale
      if (!last || Math.hypot(pt2.x - last.x, pt2.y - last.y) >= minStep) {
        s.push(pt2)
        requestDraw()
      }
    }
  }

  function onPointerUp(e) {
    delete pointersRef.current[e.pointerId]
    var g = gestureRef.current
    if (!g) return
    if (Object.keys(pointersRef.current).length > 0 && g.type === 'pinch') return
    gestureRef.current = null

    if (g.type === 'stroke') { commitStroke(); return }
    if (g.type === 'addpin' && !g.moved) { addPinAt(g.pt); return }
    if (g.type === 'dragpin' && !g.moved) { setEditPinId(g.pinId); return }
    if (g.type === 'picktap' && !g.moved) { pickTextAt(g.pt); return }
    if (g.type === 'picktap' && g.moved) { return }
    if (g.type === 'zone') { commitZone(); return }
  }

  function commitZone() {
    var img = pageImgRef.current
    var tz = tempZoneRef.current
    tempZoneRef.current = null
    if (!img || !tz) { requestDraw(); return }
    var x1 = Math.min(tz.x1, tz.x2)
    var x2 = Math.max(tz.x1, tz.x2)
    var y1 = Math.min(tz.y1, tz.y2)
    var y2 = Math.max(tz.y1, tz.y2)
    if ((x2 - x1) < 40 || (y2 - y1) < 40) { requestDraw(); return } // too small = accidental tap
    var zone = {
      id: nid('zone'),
      name: 'ZONE ' + (zonesRef.current.length + 1),
      x1: x1 / img.width, y1: y1 / img.height,
      x2: x2 / img.width, y2: y2 / img.height,
      page: pageRef.current
    }
    zonesRef.current = zonesRef.current.concat([zone])
    setZones(zonesRef.current)
    setEditZoneId(zone.id)
    requestDraw()
  }

  function commitStroke() {
    var raw = strokeRef.current
    strokeRef.current = []
    if (raw.length < 2) { requestDraw(); return }
    var img = pageImgRef.current
    if (!img) return

    var loop = ensureActiveLoop()
    var eps = 2.5 / viewRef.current.scale
    var simplified = rdp(raw, eps)
    if (straighten) simplified = straightenPolyline(simplified, 15)

    var captureR = 20 / viewRef.current.scale
    if (captureR < 14) captureR = 14
    var page = pageRef.current
    var already = {}
    loop.deviceIds.forEach(function(pid) { already[pid] = true })
    var capturedIds = []
    raw.forEach(function(pt) {
      pinsRef.current.forEach(function(pin) {
        if ((pin.page || 1) !== page) return
        if (already[pin.id]) return
        var dx = pin.x * img.width - pt.x
        var dy = pin.y * img.height - pt.y
        if (Math.hypot(dx, dy) <= captureR) {
          already[pin.id] = true
          capturedIds.push(pin.id)
        }
      })
    })

    loopsRef.current = loopsRef.current.map(function(l) {
      if (l.id !== loop.id) return l
      return Object.assign({}, l, {
        strokes: l.strokes.concat([simplified]),
        deviceIds: l.deviceIds.concat(capturedIds)
      })
    })
    setLoops(loopsRef.current)
    requestDraw()
  }

  function addPinAt(pt) {
    var img = pageImgRef.current
    if (!img) return
    var count = pinsRef.current.length + 1
    var pin = {
      id: nid('pin'),
      tag: 'PIN-' + count,
      serial: '',
      address: '',
      thermostat: '',
      room: '',
      x: pt.x / img.width,
      y: pt.y / img.height,
      source: 'manual',
      page: pageRef.current
    }
    pinsRef.current = pinsRef.current.concat([pin])
    setPins(pinsRef.current)
    setEditPinId(pin.id)
    requestDraw()
  }

  function onWheel(e) {
    e.preventDefault()
    var v = viewRef.current
    var k = e.deltaY < 0 ? 1.15 : 1 / 1.15
    var ns = Math.max(0.05, Math.min(12, v.scale * k))
    var rect = canvasRef.current.getBoundingClientRect()
    var cx = e.clientX - rect.left
    var cy = e.clientY - rect.top
    viewRef.current = {
      scale: ns,
      tx: cx - (cx - v.tx) * (ns / v.scale),
      ty: cy - (cy - v.ty) * (ns / v.scale)
    }
    requestDraw()
  }

  function zoomBy(k) {
    var canvas = canvasRef.current
    var v = viewRef.current
    var ns = Math.max(0.05, Math.min(12, v.scale * k))
    var cx = canvas.width / 2
    var cy = canvas.height / 2
    viewRef.current = {
      scale: ns,
      tx: cx - (cx - v.tx) * (ns / v.scale),
      ty: cy - (cy - v.ty) * (ns / v.scale)
    }
    requestDraw()
  }

  // ─── AI pin extraction ─────────────────────────────────────
  function runAiPins() {
    var img = pageImgRef.current
    if (!img || aiBusy) return
    var apiKey = localStorage.getItem('minimate_gemini_key') || ''
    if (!apiKey) { setAiMsg('NO GEMINI KEY — SET IT VIA IMPORT DRAWINGS FIRST'); return }

    var maxDim = 3000
    var k = Math.min(maxDim / img.width, maxDim / img.height, 1)
    var c = document.createElement('canvas')
    c.width = Math.round(img.width * k)
    c.height = Math.round(img.height * k)
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
    var base64 = c.toDataURL('image/jpeg', 0.85).split(',')[1]

    setAiBusy(true)
    setAiMsg('AI LOCATING DEVICE TAGS...')
    extractPins(base64, apiKey, function(msg) { setAiMsg(up(msg)) })
      .then(function(res) {
        var existing = {}
        pinsRef.current.forEach(function(p) { existing[p.tag] = true })
        var page = pageRef.current
        var added = 0
        var newPins = pinsRef.current.slice()
        res.pins.forEach(function(p) {
          if (existing[p.tag]) return
          newPins.push({
            id: nid('pin'),
            tag: p.tag,
            serial: '',
            address: '',
            thermostat: p.thermostat,
            room: p.room,
            x: p.x,
            y: p.y,
            source: 'ai',
            page: page
          })
          added++
        })
        pinsRef.current = newPins
        setPins(newPins)
        if (res.floor && !meta.floor) setMeta(Object.assign({}, meta, { floor: res.floor }))
        setAiBusy(false)
        setAiMsg(added + ' PINS PLACED — DRAG MISPLACED PINS TO FIX, TAP TO EDIT')
        requestDraw()
      })
      .catch(function(err) {
        setAiBusy(false)
        setAiMsg('AI FAILED: ' + up(err.message).substring(0, 120))
      })
  }

  // ─── Pin / zone / remark helpers ───────────────────────────
  function updatePin(pinId, fields) {
    pinsRef.current = pinsRef.current.map(function(p) {
      return p.id === pinId ? Object.assign({}, p, fields) : p
    })
    setPins(pinsRef.current)
    requestDraw()
  }

  function deletePin(pinId) {
    pinsRef.current = pinsRef.current.filter(function(p) { return p.id !== pinId })
    setPins(pinsRef.current)
    loopsRef.current = loopsRef.current.map(function(l) {
      return Object.assign({}, l, { deviceIds: l.deviceIds.filter(function(id) { return id !== pinId }) })
    })
    setLoops(loopsRef.current)
    setEditPinId(null)
    requestDraw()
  }

  function updateZone(zoneId, fields) {
    zonesRef.current = zonesRef.current.map(function(z) {
      return z.id === zoneId ? Object.assign({}, z, fields) : z
    })
    setZones(zonesRef.current)
    requestDraw()
  }

  function deleteZone(zoneId) {
    zonesRef.current = zonesRef.current.filter(function(z) { return z.id !== zoneId })
    setZones(zonesRef.current)
    setEditZoneId(null)
    requestDraw()
  }

  function setRemark(loopId, afterIndex, text) {
    loopsRef.current = loopsRef.current.map(function(l) {
      if (l.id !== loopId) return l
      var remarks = (l.remarks || []).filter(function(r) { return r.afterIndex !== afterIndex })
      if (text && text.trim()) remarks = remarks.concat([{ afterIndex: afterIndex, text: up(text) }])
      return Object.assign({}, l, { remarks: remarks })
    })
    setLoops(loopsRef.current)
  }

  function removeFromLoop(loopId, pinId) {
    loopsRef.current = loopsRef.current.map(function(l) {
      if (l.id !== loopId) return l
      return Object.assign({}, l, { deviceIds: l.deviceIds.filter(function(id) { return id !== pinId }) })
    })
    setLoops(loopsRef.current)
    requestDraw()
  }

  function undoLastStroke() {
    var loop = loopsRef.current.find(function(l) { return l.id === activeLoopRef.current })
    if (!loop || loop.strokes.length === 0) return
    var img = pageImgRef.current
    if (!img) return
    var remaining = loop.strokes.slice(0, -1)
    var captureR = 14
    var page = pageRef.current
    var already = {}
    var ids = []
    remaining.forEach(function(stroke) {
      stroke.forEach(function(pt) {
        pinsRef.current.forEach(function(pin) {
          if ((pin.page || 1) !== page) return
          if (already[pin.id]) return
          var dx = pin.x * img.width - pt.x
          var dy = pin.y * img.height - pt.y
          if (Math.hypot(dx, dy) <= captureR) { already[pin.id] = true; ids.push(pin.id) }
        })
      })
    })
    loopsRef.current = loopsRef.current.map(function(l) {
      if (l.id !== loop.id) return l
      return Object.assign({}, l, { strokes: remaining, deviceIds: ids })
    })
    setLoops(loopsRef.current)
    requestDraw()
  }

  function deleteLoop(loopId) {
    loopsRef.current = loopsRef.current.filter(function(l) { return l.id !== loopId })
    setLoops(loopsRef.current)
    if (activeLoopRef.current === loopId) {
      var next = loopsRef.current.length > 0 ? loopsRef.current[loopsRef.current.length - 1].id : null
      setActiveLoopId(next)
      activeLoopRef.current = next
    }
    requestDraw()
  }

  // ─── Finish ────────────────────────────────────────────────
  function handleDone() {
    var pinById = {}
    pins.forEach(function(p) { pinById[p.id] = p })

    var resultLoops = loops.filter(function(l) { return l.deviceIds.length > 0 }).map(function(l) {
      var devs = l.deviceIds.map(function(pid) {
        var p = pinById[pid] || {}
        return { tag: p.tag || '', room: p.room || '', thermostat: p.thermostat || '', address: p.address || '', serial: p.serial || '' }
      })
      var cableRemarks = (l.remarks || []).map(function(r) {
        var from = pinById[l.deviceIds[r.afterIndex]] || {}
        var to = pinById[l.deviceIds[r.afterIndex + 1]] || {}
        return { from: from.tag || '', to: to.tag || '', text: r.text }
      })
      return {
        loopId: l.name,
        color: '',
        ddcPanel: '',
        devices: devs,
        deviceCount: devs.length,
        cableRemarks: cableRemarks
      }
    })

    var placed = {}
    loops.forEach(function(l) { l.deviceIds.forEach(function(pid) { placed[pid] = true }) })
    var unmatched = pins.filter(function(p) { return !placed[p.id] && /^(FCU|VAV|AHU|PAU|ERU)/i.test(p.tag) })
      .map(function(p) { return { tag: p.tag, room: p.room, thermostat: p.thermostat, address: p.address, serial: p.serial } })

    // Zones -> device groupings for the location view
    var zoneGroups = zones.map(function(z) {
      var tags = pins.filter(function(p) {
        return (p.page || 1) === (z.page || 1) && p.x >= z.x1 && p.x <= z.x2 && p.y >= z.y1 && p.y <= z.y2
      }).map(function(p) { return p.tag })
      return { name: z.name, deviceTags: tags }
    }).filter(function(g) { return g.deviceTags.length > 0 })

    var drawingId = rec ? rec.id : nid('dwg')

    var result = {
      loops: resultLoops,
      ddcPanels: [],
      annotations: [],
      floorLabel: meta.floor,
      pdfStats: { totalDevices: pins.length, totalRooms: pins.filter(function(p) { return p.room }).length },
      unmatchedDevices: unmatched,
      zoneGroups: zoneGroups,
      drawingId: drawingId,
      sources: { traced: true }
    }

    var drawingRecord = {
      id: drawingId,
      name: meta.name || 'DRAWING',
      floor: meta.floor,
      block: meta.block,
      zone: meta.zone,
      fileHash: fileHashRef.current,
      fileName: props.file.name || '',
      fileKind: isImageFile(props.file) ? 'image' : 'pdf',
      pageCount: pageCount,
      createdAt: rec ? (rec.createdAt || new Date().toISOString()) : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: pins,
      traces: loops.map(function(l) {
        var pb = pinById
        return {
          id: l.id, name: l.name, color: l.color, page: l.page,
          strokes: l.strokes, deviceIds: l.deviceIds, remarks: l.remarks || [],
          deviceTags: l.deviceIds.map(function(pid) { return (pb[pid] || {}).tag || '' })
        }
      }),
      zones: zones
    }

    props.onComplete(result, drawingRecord)
  }

  // ─── UI ────────────────────────────────────────────────────
  var editPin = pins.find(function(p) { return p.id === editPinId })
  var editZone = zones.find(function(z) { return z.id === editZoneId })
  var pinById2 = {}
  pins.forEach(function(p) { pinById2[p.id] = p })
  var tracedCount = loops.reduce(function(s, l) { return s + l.deviceIds.length }, 0)

  function modeBtn(m, icon, label) {
    return (
      <button onClick={function() { setMode(m); setEditPinId(null); setEditZoneId(null); setPickField(null) }}
        className={'flex items-center justify-center gap-1.5 px-3 py-2 md:py-1.5 rounded-md text-[11px] md:text-[10px] font-bold uppercase transition flex-1 md:flex-none ' + (mode === m ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>
        <span>{icon}</span><span>{label}</span>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-[110] bg-navy flex flex-col">
      {/* ─── Top bar ─── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-card2 border-b border-border">
        <button onClick={props.onCancel} className="px-2 py-1.5 text-dgray hover:text-white text-sm">✕</button>
        <div className="text-[11px] font-extrabold uppercase text-teal truncate">{meta.name || 'TRACE STUDIO'}</div>
        <div className="hidden md:flex items-center gap-2 ml-2">
          {modeBtn('pan', '✋', 'PAN')}
          {modeBtn('pin', '📍', 'PINS')}
          {modeBtn('trace', '✏️', 'TRACE')}
          {modeBtn('zone', '▭', 'ZONE')}
          <div className="w-px h-5 bg-border mx-1"></div>
          <button onClick={function() { zoomBy(1.3) }} className="px-2.5 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">+</button>
          <button onClick={function() { zoomBy(1 / 1.3) }} className="px-2.5 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">−</button>
          <button onClick={fitView} className="px-2 py-1.5 bg-card2 text-dgray hover:text-white rounded text-[10px] uppercase">FIT</button>
          <button onClick={function() { setStraighten(!straighten) }} title="SNAP TRACE LINES TO STRAIGHT ANGLES" className={'px-2 py-1.5 rounded text-[10px] uppercase font-bold transition ' + (straighten ? 'bg-teal/20 text-teal' : 'bg-card2 text-dgray')}>⊾ STRAIGHT</button>
        </div>
        {pageCount > 1 && (
          <span className="flex items-center gap-1">
            <button onClick={function() { if (pageNum > 1) renderPage(pageNum - 1) }} className="px-2 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">‹</button>
            <span className="text-[10px] text-dgray uppercase">PG {pageNum}/{pageCount}</span>
            <button onClick={function() { if (pageNum < pageCount) renderPage(pageNum + 1) }} className="px-2 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">›</button>
          </span>
        )}
        <div className="flex-1"></div>
        <button onClick={runAiPins} disabled={aiBusy || loading} className={'px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition ' + (aiBusy ? 'bg-card2 text-dgray cursor-wait' : 'bg-orange/20 text-orange hover:bg-orange/30')}>
          {aiBusy ? 'AI...' : '✨ AI PINS'}
        </button>
        <button onClick={handleDone} disabled={tracedCount === 0} className={'px-4 py-1.5 rounded-md text-[10px] font-bold uppercase transition ' + (tracedCount > 0 ? 'bg-teal text-white hover:bg-teal/80' : 'bg-card2 text-dgray cursor-not-allowed')}>
          DONE ({tracedCount})
        </button>
      </div>

      {aiMsg && (
        <div className="px-3 py-1 bg-card border-b border-border text-[9px] text-orange uppercase truncate">{aiMsg}</div>
      )}
      {pickField && (
        <div className="px-3 py-1.5 bg-teal/20 border-b border-teal text-[10px] text-teal font-bold uppercase">
          TAP THE TEXT ON THE DRAWING TO FILL {pickField.field === 'tag' ? 'EQUIPMENT NAME' : pickField.field.toUpperCase()} {hasTextLayer ? '(TEXT LAYER)' : '(AI READS THE PIXELS)'}
          <button onClick={function() { setPickField(null) }} className="ml-3 text-white/70 hover:text-white">CANCEL</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {/* ─── Canvas ─── */}
        <div ref={wrapRef} className="flex-1 relative overflow-hidden" style={{ touchAction: 'none' }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onContextMenu={function(e) { e.preventDefault() }}
            className={mode === 'pan' ? 'cursor-grab' : mode === 'pin' ? 'cursor-copy' : 'cursor-crosshair'}
          />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-navy/80">
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                <div className="text-[10px] text-dgray uppercase">RENDERING DRAWING...</div>
              </div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="bg-red/10 border border-red/30 rounded-lg p-4 text-xs text-red uppercase">{error}</div>
            </div>
          )}
          {!loading && !error && !pickField && (
            <div className="absolute bottom-16 md:bottom-3 left-3 bg-card/90 rounded-lg px-3 py-2 text-[9px] text-dgray uppercase pointer-events-none max-w-[75%]">
              {mode === 'trace' && 'DRAW ALONG THE LOOP — PINS CAPTURE IN ORDER. RIGHT-DRAG OR TWO FINGERS TO MOVE AROUND.'}
              {mode === 'pin' && 'TAP EMPTY = ADD PIN · DRAG PIN = MOVE · TAP PIN = EDIT'}
              {mode === 'zone' && 'DRAG A RECTANGLE AROUND AN AREA TO NAME IT AS A ZONE'}
              {mode === 'pan' && 'DRAG TO MOVE · WHEEL / PINCH TO ZOOM'}
            </div>
          )}

          {/* Pin editor */}
          {editPin && (
            <div className="absolute top-3 left-3 bg-card border border-teal rounded-xl p-3 w-72 z-10 max-h-[70%] overflow-y-auto">
              <div className="text-[9px] text-teal font-bold uppercase mb-2">EDIT DEVICE PIN {editPin.source === 'ai' ? '(AI)' : ''}</div>

              <label className="text-[8px] text-dgray uppercase block mb-0.5">EQUIPMENT NAME (TAG)</label>
              <div className="flex gap-1 mb-2">
                <input value={editPin.tag} onChange={function(e) { updatePin(editPin.id, { tag: up(e.target.value) }) }}
                  className="flex-1 bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase outline-none focus:border-teal" />
                <button onClick={function() { setPickField({ pinId: editPin.id, field: 'tag' }) }} title="PICK FROM DRAWING" className="px-2 py-1 bg-teal/20 text-teal text-[9px] font-bold rounded uppercase hover:bg-teal/30">PICK</button>
              </div>

              <label className="text-[8px] text-dgray uppercase block mb-0.5">DEVICE SERIAL NO. (SHOWN ON DRAWING)</label>
              <input value={editPin.serial || ''} onChange={function(e) { updatePin(editPin.id, { serial: up(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-2 outline-none focus:border-teal" />

              <label className="text-[8px] text-dgray uppercase block mb-0.5">ADDRESS NO.</label>
              <input value={editPin.address || ''} onChange={function(e) { updatePin(editPin.id, { address: up(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-2 outline-none focus:border-teal" />

              <label className="text-[8px] text-dgray uppercase block mb-0.5">ROOM NAME</label>
              <div className="flex gap-1 mb-3">
                <input value={editPin.room || ''} onChange={function(e) { updatePin(editPin.id, { room: up(e.target.value) }) }}
                  className="flex-1 bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase outline-none focus:border-teal" />
                <button onClick={function() { setPickField({ pinId: editPin.id, field: 'room' }) }} title="PICK FROM DRAWING" className="px-2 py-1 bg-teal/20 text-teal text-[9px] font-bold rounded uppercase hover:bg-teal/30">PICK</button>
              </div>

              <div className="flex gap-2">
                <button onClick={function() { setEditPinId(null) }} className="flex-1 px-2 py-1.5 bg-teal text-white text-[9px] font-bold rounded uppercase">CLOSE</button>
                <button onClick={function() { deletePin(editPin.id) }} className="px-2 py-1.5 bg-red/20 text-red text-[9px] font-bold rounded uppercase">DELETE</button>
              </div>
            </div>
          )}

          {/* Zone editor */}
          {editZone && (
            <div className="absolute top-3 left-3 bg-card border border-purple rounded-xl p-3 w-64 z-10">
              <div className="text-[9px] text-purple font-bold uppercase mb-2">EDIT ZONE</div>
              <label className="text-[8px] text-dgray uppercase block mb-0.5">ZONE NAME</label>
              <input value={editZone.name} onChange={function(e) { updateZone(editZone.id, { name: up(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-3 outline-none focus:border-purple" />
              <div className="text-[8px] text-dgray uppercase mb-3">DEVICES INSIDE THIS RECTANGLE WILL FORM A GROUP IN THE LOCATION VIEW.</div>
              <div className="flex gap-2">
                <button onClick={function() { setEditZoneId(null) }} className="flex-1 px-2 py-1.5 bg-purple text-white text-[9px] font-bold rounded uppercase">CLOSE</button>
                <button onClick={function() { deleteZone(editZone.id) }} className="px-2 py-1.5 bg-red/20 text-red text-[9px] font-bold rounded uppercase">DELETE</button>
              </div>
            </div>
          )}

          {/* Remark editor */}
          {editRemark && (function() {
            var loop = loops.find(function(l) { return l.id === editRemark.loopId })
            if (!loop) return null
            var existing = (loop.remarks || []).find(function(r) { return r.afterIndex === editRemark.afterIndex })
            var fromPin = pinById2[loop.deviceIds[editRemark.afterIndex]] || {}
            var toPin = pinById2[loop.deviceIds[editRemark.afterIndex + 1]] || {}
            return (
              <div className="absolute top-3 left-3 bg-card border border-orange rounded-xl p-3 w-72 z-10">
                <div className="text-[9px] text-orange font-bold uppercase mb-2">CABLE REMARK</div>
                <div className="text-[8px] text-dgray uppercase mb-2">{fromPin.tag || '?'} → {toPin.tag || '?'}</div>
                <input autoFocus defaultValue={existing ? existing.text : ''} id="ts-remark-input" placeholder="E.G. CABLE DAMAGED NEAR RISER"
                  className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-3 outline-none focus:border-orange" />
                <div className="flex gap-2">
                  <button onClick={function() {
                    var inp = document.getElementById('ts-remark-input')
                    setRemark(editRemark.loopId, editRemark.afterIndex, inp ? inp.value : '')
                    setEditRemark(null)
                  }} className="flex-1 px-2 py-1.5 bg-orange text-white text-[9px] font-bold rounded uppercase">SAVE</button>
                  <button onClick={function() { setEditRemark(null) }} className="px-2 py-1.5 bg-card2 text-dgray text-[9px] rounded uppercase hover:text-white">CANCEL</button>
                </div>
              </div>
            )
          })()}
        </div>

        {/* ─── Loop panel ─── */}
        <div className={'w-72 bg-card2 border-l border-border flex-col overflow-y-auto z-20 ' + (panelOpen ? 'flex absolute right-0 top-0 bottom-0 md:static' : 'hidden md:flex')}>
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-bold uppercase text-white">DRAWING INFO</div>
              <button onClick={function() { setPanelOpen(false) }} className="md:hidden text-dgray hover:text-white text-xs">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <input value={meta.name} onChange={function(e) { setMeta(Object.assign({}, meta, { name: up(e.target.value) })) }} placeholder="NAME" className="col-span-2 bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
              <input value={meta.floor} onChange={function(e) { setMeta(Object.assign({}, meta, { floor: up(e.target.value) })) }} placeholder="FLOOR" className="bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
              <input value={meta.block} onChange={function(e) { setMeta(Object.assign({}, meta, { block: up(e.target.value) })) }} placeholder="BLOCK" className="bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
              <input value={meta.zone} onChange={function(e) { setMeta(Object.assign({}, meta, { zone: up(e.target.value) })) }} placeholder="ZONE/AREA" className="col-span-2 bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
            </div>
          </div>

          <div className="p-3 border-b border-border flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase text-white">LOOPS</div>
            <button onClick={newLoop} className="px-2 py-1 bg-teal/20 text-teal text-[9px] font-bold rounded uppercase hover:bg-teal/30">+ NEW LOOP</button>
          </div>
          <div className="px-3 py-2 text-[9px] text-dgray uppercase">{pins.length} PINS · {tracedCount} ON LOOPS · {zones.length} ZONES</div>

          {loops.length === 0 && (
            <div className="p-3 text-[9px] text-dgray uppercase">SWITCH TO TRACE MODE AND DRAW — A LOOP IS CREATED AUTOMATICALLY.</div>
          )}

          {loops.map(function(loop) {
            var isActive = loop.id === activeLoopId
            var remarkByIndex = {}
            ;(loop.remarks || []).forEach(function(r) { remarkByIndex[r.afterIndex] = r })
            return (
              <div key={loop.id} className={'m-2 rounded-lg border p-2 cursor-pointer transition ' + (isActive ? 'border-teal bg-teal/5' : 'border-border hover:border-dgray')}
                onClick={function() { setActiveLoopId(loop.id); activeLoopRef.current = loop.id; requestDraw() }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: loop.color }}></span>
                  <input value={loop.name}
                    onClick={function(e) { e.stopPropagation() }}
                    onChange={function(e) {
                      var v = up(e.target.value)
                      loopsRef.current = loopsRef.current.map(function(l) { return l.id === loop.id ? Object.assign({}, l, { name: v }) : l })
                      setLoops(loopsRef.current)
                    }}
                    className="flex-1 min-w-0 bg-transparent text-[11px] font-bold text-white uppercase outline-none border-b border-transparent focus:border-teal" />
                  <span className="text-[9px] text-dgray">{loop.deviceIds.length}</span>
                  <button onClick={function(e) { e.stopPropagation(); deleteLoop(loop.id) }} className="text-dgray hover:text-red text-[10px]">✕</button>
                </div>
                {isActive && (
                  <div>
                    {loop.deviceIds.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 mb-1">
                        {loop.deviceIds.map(function(pid, i) {
                          var p = pinById2[pid]
                          if (!p) return null
                          var rem = remarkByIndex[i]
                          return (
                            <span key={pid} className="flex items-center gap-1">
                              <button onClick={function(e) { e.stopPropagation(); removeFromLoop(loop.id, pid) }}
                                title="TAP TO REMOVE FROM LOOP"
                                className="px-1.5 py-0.5 rounded bg-card text-[8px] text-white uppercase hover:bg-red/20 hover:text-red transition">
                                {i + 1}. {p.tag}
                              </button>
                              {i < loop.deviceIds.length - 1 && (
                                <button onClick={function(e) { e.stopPropagation(); setEditRemark({ loopId: loop.id, afterIndex: i }) }}
                                  title={rem ? rem.text : 'ADD CABLE REMARK BETWEEN THESE DEVICES'}
                                  className={'text-[9px] px-0.5 transition ' + (rem ? 'text-orange' : 'text-dgray/40 hover:text-orange')}>
                                  {rem ? '⚠' : '·'}
                                </button>
                              )}
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {(loop.remarks || []).length > 0 && (
                      <div className="mb-1">
                        {(loop.remarks || []).map(function(r) {
                          var fp = pinById2[loop.deviceIds[r.afterIndex]] || {}
                          var tp = pinById2[loop.deviceIds[r.afterIndex + 1]] || {}
                          return <div key={r.afterIndex} className="text-[8px] text-orange uppercase">⚠ {fp.tag}→{tp.tag}: {r.text}</div>
                        })}
                      </div>
                    )}
                    {loop.strokes.length > 0 && (
                      <button onClick={function(e) { e.stopPropagation(); undoLastStroke() }} className="text-[8px] text-orange uppercase hover:text-white">↩ UNDO LAST STROKE</button>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {zones.length > 0 && (
            <div className="p-3 border-t border-border">
              <div className="text-[10px] font-bold uppercase text-purple mb-2">ZONES</div>
              {zones.map(function(z) {
                return (
                  <div key={z.id} className="flex items-center justify-between py-1">
                    <span className="text-[10px] text-white uppercase">{z.name}</span>
                    <span className="flex gap-2">
                      <button onClick={function() { setEditZoneId(z.id) }} className="text-[9px] text-dgray hover:text-white uppercase">EDIT</button>
                      <button onClick={function() { deleteZone(z.id) }} className="text-[9px] text-dgray hover:text-red">✕</button>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ─── Mobile bottom bar ─── */}
      <div className="md:hidden flex items-center gap-1.5 px-2 py-2 bg-card2 border-t border-border">
        {modeBtn('pan', '✋', 'PAN')}
        {modeBtn('pin', '📍', 'PIN')}
        {modeBtn('trace', '✏️', 'TRACE')}
        {modeBtn('zone', '▭', 'ZONE')}
        <button onClick={function() { setStraighten(!straighten) }} className={'px-2.5 py-2 rounded-md text-[11px] font-bold transition ' + (straighten ? 'bg-teal/20 text-teal' : 'bg-card2 text-dgray')}>⊾</button>
        <button onClick={function() { setPanelOpen(!panelOpen) }} className="px-2.5 py-2 bg-card2 text-dgray rounded-md text-[11px] font-bold uppercase">☰</button>
      </div>
    </div>
  )
}
