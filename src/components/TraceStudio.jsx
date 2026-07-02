/* --- TraceStudio.jsx --- In-app loop tracing on the drawing ---
   The core inversion, made real:
     AI (optional) locates device tags -> pins on the drawing
     Human traces the loop with mouse/finger -> pins captured in path order
     Code resolves loops + sequence deterministically. Zero hallucination.
   Modes: PAN (move around), PINS (tap to add / drag to fix / tap to edit),
          TRACE (draw along the highlighted route; pins light up as captured). */

import { useState, useEffect, useRef } from 'react'
import { extractPins } from '../lib/analyzers/pinExtract'
import { putFile } from '../lib/fileStore'

var LOOP_COLORS = ['#22D3EE', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#EC4899']

var tsIdCounter = 0
function nid(prefix) {
  tsIdCounter++
  return prefix + '-' + Date.now() + '-' + tsIdCounter
}

function up(v) { return (v || '').toUpperCase().trim() }

/* Ramer-Douglas-Peucker polyline simplification (points: [{x,y}] in px) */
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
  if (len2 === 0) return Math.sqrt((p.x - a.x) * (p.x - a.x) + (p.y - a.y) * (p.y - a.y))
  var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  if (t < 0) t = 0
  if (t > 1) t = 1
  var px = a.x + t * dx
  var py = a.y + t * dy
  return Math.sqrt((p.x - px) * (p.x - px) + (p.y - py) * (p.y - py))
}

export default function TraceStudio(props) {
  // props: file (File), onCancel(), onComplete(result, drawingRecord)

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
  var modeState = useState('pan') // pan | pin | trace
  var mode = modeState[0]
  var setMode = modeState[1]
  var pinsState = useState([]) // {id,tag,thermostat,room,x,y,source,page}  x/y normalized 0-1
  var pins = pinsState[0]
  var setPins = pinsState[1]
  var loopsState = useState([]) // {id,name,color,page,deviceIds:[],strokes:[[{x,y}px]]}
  var loops = loopsState[0]
  var setLoops = loopsState[1]
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
  var floorState = useState('')
  var floorLabel = floorState[0]
  var setFloorLabel = floorState[1]
  var panelOpenState = useState(true)
  var panelOpen = panelOpenState[0]
  var setPanelOpen = panelOpenState[1]

  // ─── Refs (gesture + draw state, no re-render churn) ─────
  var canvasRef = useRef(null)
  var wrapRef = useRef(null)
  var pdfRef = useRef(null)
  var pageImgRef = useRef(null)     // offscreen canvas of rendered page
  var viewRef = useRef({ scale: 1, tx: 0, ty: 0 })
  var pointersRef = useRef({})      // pointerId -> {x,y}
  var gestureRef = useRef(null)     // {type:'pan'|'stroke'|'pinch'|'dragpin', ...}
  var strokeRef = useRef([])        // current stroke, page px
  var fileHashRef = useRef('')
  var rafRef = useRef(0)

  // Mirrors for the imperative draw loop
  var pinsRef = useRef(pins);            pinsRef.current = pins
  var loopsRef = useRef(loops);          loopsRef.current = loops
  var activeLoopRef = useRef(activeLoopId); activeLoopRef.current = activeLoopId
  var pageRef = useRef(pageNum);         pageRef.current = pageNum
  var modeRef = useRef(mode);            modeRef.current = mode

  // ─── Load PDF + render page ───────────────────────────────
  useEffect(function() {
    var cancelled = false
    if (!window.pdfjsLib) { setError('PDF.JS NOT LOADED'); setLoading(false); return }

    putFile(props.file).then(function(hash) {
      fileHashRef.current = hash
    }).catch(function() { /* cache is best-effort */ })

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

  // ─── Draw loop ─────────────────────────────────────────────
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

    // Strokes per loop
    loopsRef.current.forEach(function(loop) {
      if (loop.page !== page) return
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

    // Pin -> loop color lookup
    var pinLoop = {}
    loopsRef.current.forEach(function(loop) {
      loop.deviceIds.forEach(function(pid) { pinLoop[pid] = loop })
    })

    // Pins
    var r = 10 / v.scale
    var showLabels = v.scale * W > 1400 // only when zoomed in enough to read
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
        // sequence number inside captured pins
        var seq = lp.deviceIds.indexOf(pin.id) + 1
        ctx.fillStyle = '#0F172A'
        ctx.font = 'bold ' + (11 / v.scale) + 'px Inter, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(seq), px, py)
      }
      if (showLabels) {
        ctx.fillStyle = lp ? lp.color : '#22D3EE'
        ctx.font = 'bold ' + (12 / v.scale) + 'px Inter, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(pin.tag, px, py - r - 3 / v.scale)
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
      if (Math.sqrt(dx * dx + dy * dy) <= r) found = pin
    })
    return found
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
      strokes: []
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
      // Pinch takes over; abandon stroke in progress
      strokeRef.current = []
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

    // pan
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

    if (g.type === 'addpin') {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 8) g.moved = true
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

    if (g.type === 'stroke') {
      commitStroke()
      return
    }

    if (g.type === 'addpin' && !g.moved) {
      addPinAt(g.pt)
      return
    }

    if (g.type === 'dragpin' && !g.moved) {
      setEditPinId(g.pinId)
    }
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

    // Hit-test: walk the RAW stroke in order, capture pins within radius
    var captureR = 20 / viewRef.current.scale
    if (captureR < 14) captureR = 14 // page-px floor so fast strokes still catch pins
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
        if (Math.sqrt(dx * dx + dy * dy) <= captureR) {
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

  // Wheel zoom must be a non-passive listener (React's onWheel can be
  // passive, which blocks preventDefault and scrolls the page instead)
  useEffect(function() {
    var canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return function() { canvas.removeEventListener('wheel', onWheel) }
  }, [])

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

    // Downscale render for the API call
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
        if (res.floor && !floorLabel) setFloorLabel(res.floor)
        setAiBusy(false)
        setAiMsg(added + ' PINS PLACED — DRAG ANY MISPLACED PIN TO FIX, TAP TO EDIT')
        requestDraw()
      })
      .catch(function(err) {
        setAiBusy(false)
        setAiMsg('AI FAILED: ' + up(err.message).substring(0, 120))
      })
  }

  // ─── Pin edit helpers ──────────────────────────────────────
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
    // Recompute captured devices from remaining strokes is complex; simplest honest
    // undo: drop last stroke AND devices captured after the previous stroke count.
    // We track capture order, so drop devices not reachable — MVP: rebuild by re-hit-testing all remaining strokes.
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
          if (Math.sqrt(dx * dx + dy * dy) <= captureR) { already[pin.id] = true; ids.push(pin.id) }
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

  // ─── Finish: build import-preview result ───────────────────
  function handleDone() {
    var pinById = {}
    pins.forEach(function(p) { pinById[p.id] = p })

    var resultLoops = loops.filter(function(l) { return l.deviceIds.length > 0 }).map(function(l) {
      return {
        loopId: l.name,
        color: '',
        ddcPanel: '',
        devices: l.deviceIds.map(function(pid) {
          var p = pinById[pid] || {}
          return { tag: p.tag || '', room: p.room || '', thermostat: p.thermostat || '' }
        }),
        deviceCount: l.deviceIds.length
      }
    })

    var placed = {}
    loops.forEach(function(l) { l.deviceIds.forEach(function(pid) { placed[pid] = true }) })
    var unmatched = pins.filter(function(p) { return !placed[p.id] && /^(FCU|VAV|AHU|PAU|ERU)/i.test(p.tag) })
      .map(function(p) { return { tag: p.tag, room: p.room, thermostat: p.thermostat } })

    var result = {
      loops: resultLoops,
      ddcPanels: [],
      annotations: [],
      floorLabel: floorLabel,
      pdfStats: { totalDevices: pins.length, totalRooms: pins.filter(function(p) { return p.room }).length },
      unmatchedDevices: unmatched,
      sources: { traced: true }
    }

    var drawingRecord = {
      id: nid('dwg'),
      name: up(props.file.name || 'DRAWING').replace(/\.PDF$/, ''),
      fileHash: fileHashRef.current,
      fileName: props.file.name || '',
      pageCount: pageCount,
      floor: floorLabel,
      createdAt: new Date().toISOString(),
      tags: pins,
      traces: loops.map(function(l) {
        return { id: l.id, name: l.name, color: l.color, page: l.page, strokes: l.strokes, deviceTags: l.deviceIds.map(function(pid) { return (pinById[pid] || {}).tag || '' }) }
      })
    }

    props.onComplete(result, drawingRecord)
  }

  // ─── UI ────────────────────────────────────────────────────
  var activeLoop = loops.find(function(l) { return l.id === activeLoopId })
  var editPin = pins.find(function(p) { return p.id === editPinId })
  var pinById2 = {}
  pins.forEach(function(p) { pinById2[p.id] = p })
  var tracedCount = loops.reduce(function(s, l) { return s + l.deviceIds.length }, 0)

  function modeBtn(m, icon, label) {
    return (
      <button onClick={function() { setMode(m); setEditPinId(null) }}
        className={'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition ' + (mode === m ? 'bg-teal text-white' : 'bg-card2 text-dgray hover:text-white')}>
        <span>{icon}</span><span className="hidden md:inline">{label}</span>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-[110] bg-navy flex flex-col">
      {/* ─── Toolbar ─── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-card2 border-b border-border flex-wrap">
        <button onClick={props.onCancel} className="px-2 py-1.5 text-dgray hover:text-white text-xs">✕</button>
        <div className="text-[11px] font-extrabold uppercase text-teal hidden md:block">TRACE STUDIO</div>
        <div className="w-px h-5 bg-border mx-1"></div>
        {modeBtn('pan', '✋', 'PAN')}
        {modeBtn('pin', '📍', 'PINS')}
        {modeBtn('trace', '✏️', 'TRACE')}
        <div className="w-px h-5 bg-border mx-1"></div>
        <button onClick={function() { zoomBy(1.3) }} className="px-2.5 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">+</button>
        <button onClick={function() { zoomBy(1 / 1.3) }} className="px-2.5 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">−</button>
        <button onClick={fitView} className="px-2 py-1.5 bg-card2 text-dgray hover:text-white rounded text-[10px] uppercase">FIT</button>
        {pageCount > 1 && (
          <span className="flex items-center gap-1">
            <button onClick={function() { if (pageNum > 1) renderPage(pageNum - 1) }} className="px-2 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">‹</button>
            <span className="text-[10px] text-dgray uppercase">PG {pageNum}/{pageCount}</span>
            <button onClick={function() { if (pageNum < pageCount) renderPage(pageNum + 1) }} className="px-2 py-1.5 bg-card2 text-dgray hover:text-white rounded text-xs">›</button>
          </span>
        )}
        <div className="flex-1"></div>
        <button onClick={runAiPins} disabled={aiBusy || loading} className={'px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition ' + (aiBusy ? 'bg-card2 text-dgray cursor-wait' : 'bg-orange/20 text-orange hover:bg-orange/30')}>
          {aiBusy ? 'AI WORKING...' : '✨ AI PIN DEVICES'}
        </button>
        <button onClick={function() { setPanelOpen(!panelOpen) }} className="px-2 py-1.5 bg-card2 text-dgray hover:text-white rounded text-[10px] uppercase md:hidden">LOOPS</button>
        <button onClick={handleDone} disabled={tracedCount === 0} className={'px-4 py-1.5 rounded-md text-[10px] font-bold uppercase transition ' + (tracedCount > 0 ? 'bg-teal text-white hover:bg-teal/80' : 'bg-card2 text-dgray cursor-not-allowed')}>
          DONE ({tracedCount})
        </button>
      </div>

      {aiMsg && (
        <div className="px-3 py-1 bg-card border-b border-border text-[9px] text-orange uppercase">{aiMsg}</div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* ─── Canvas ─── */}
        <div ref={wrapRef} className="flex-1 relative overflow-hidden" style={{ touchAction: 'none' }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
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
          {!loading && !error && mode === 'trace' && (
            <div className="absolute bottom-3 left-3 bg-card/90 rounded-lg px-3 py-2 text-[9px] text-dgray uppercase pointer-events-none">
              DRAW ALONG THE LOOP ROUTE — PINS LIGHT UP AS CAPTURED. LIFT AND CONTINUE ANYTIME (SAME LOOP).
            </div>
          )}
          {!loading && !error && mode === 'pin' && (
            <div className="absolute bottom-3 left-3 bg-card/90 rounded-lg px-3 py-2 text-[9px] text-dgray uppercase pointer-events-none">
              TAP EMPTY SPOT = ADD PIN · DRAG PIN = MOVE · TAP PIN = EDIT
            </div>
          )}

          {/* Pin editor */}
          {editPin && (
            <div className="absolute top-3 left-3 bg-card border border-teal rounded-xl p-3 w-64 z-10">
              <div className="text-[9px] text-teal font-bold uppercase mb-2">EDIT PIN {editPin.source === 'ai' ? '(AI)' : ''}</div>
              <label className="text-[8px] text-dgray uppercase block mb-0.5">TAG</label>
              <input value={editPin.tag} onChange={function(e) { updatePin(editPin.id, { tag: up(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-2 outline-none focus:border-teal" />
              <label className="text-[8px] text-dgray uppercase block mb-0.5">ROOM</label>
              <input value={editPin.room} onChange={function(e) { updatePin(editPin.id, { room: up(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-3 outline-none focus:border-teal" />
              <div className="flex gap-2">
                <button onClick={function() { setEditPinId(null) }} className="flex-1 px-2 py-1 bg-teal text-white text-[9px] font-bold rounded uppercase">CLOSE</button>
                <button onClick={function() { deletePin(editPin.id) }} className="px-2 py-1 bg-red/20 text-red text-[9px] font-bold rounded uppercase">DELETE</button>
              </div>
            </div>
          )}
        </div>

        {/* ─── Loop panel ─── */}
        <div className={'w-64 bg-card2 border-l border-border flex-col overflow-y-auto ' + (panelOpen ? 'flex' : 'hidden') + ' max-md:absolute max-md:right-0 max-md:top-0 max-md:bottom-0 max-md:z-20'}>
          <div className="p-3 border-b border-border flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase text-white">LOOPS</div>
            <button onClick={newLoop} className="px-2 py-1 bg-teal/20 text-teal text-[9px] font-bold rounded uppercase hover:bg-teal/30">+ NEW LOOP</button>
          </div>
          <div className="p-2 text-[9px] text-dgray uppercase">{pins.length} PINS · {tracedCount} ON LOOPS</div>

          {loops.length === 0 && (
            <div className="p-3 text-[9px] text-dgray uppercase">SWITCH TO TRACE MODE AND DRAW — A LOOP IS CREATED AUTOMATICALLY.</div>
          )}

          {loops.map(function(loop) {
            var isActive = loop.id === activeLoopId
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
                      <div className="flex flex-wrap gap-1 mb-1">
                        {loop.deviceIds.map(function(pid, i) {
                          var p = pinById2[pid]
                          if (!p) return null
                          return (
                            <button key={pid} onClick={function(e) { e.stopPropagation(); removeFromLoop(loop.id, pid) }}
                              title="TAP TO REMOVE FROM LOOP"
                              className="px-1.5 py-0.5 rounded bg-card text-[8px] text-white uppercase hover:bg-red/20 hover:text-red transition">
                              {i + 1}. {p.tag}
                            </button>
                          )
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
        </div>
      </div>
    </div>
  )
}
