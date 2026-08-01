/* --- TraceStudio.jsx --- v2 --- In-app loop tracing on the drawing ---
   The core inversion: AI locates, human traces, code resolves.
   v2 adds: mobile toolbar, richer pins (serial/address/room), text picking
   (PDF text layer; scans/images require typing manually), right-drag pan
   while tracing, image file support, orthogonal stroke straightening, zone
   rectangles, cable remarks between devices, reopen/edit saved drawings.

   AI PINS (auto-locate) and crop-read (AI text-pick on scans) REMOVED
   2026-07-12 — a week of live field testing found them not worth using,
   supervisors trace/tag fine by hand. Room left open for future AI
   re-integration: ../lib/analyzers/pinExtract.js and ../lib/geminiClient.js
   are untouched, this file just no longer calls them. See MINIMATE-HANDOFF.md
   update log 2026-07-12 for the decision. */

import { useState, useEffect, useRef } from 'react'
import { putFile } from '../lib/fileStore'
import { saveDraft, getDraft, clearDraft } from '../lib/traceDraftStore'
import { uploadDrawing } from '../lib/drawingCloudStore'

var LOOP_COLORS = ['#22D3EE', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#EC4899']
var ZONE_COLORS = ['#8B5CF6', '#22D3EE', '#10B981', '#F59E0B', '#EC4899', '#EF4444']

/* Uppercase WITHOUT trim — used while typing so spaces survive keystrokes */
function upKeep(v) { return (v || '').toUpperCase() }

var tsIdCounter = 0
function nid(prefix) {
  tsIdCounter++
  return prefix + '-' + Date.now() + '-' + tsIdCounter
}

function up(v) { return (v || '').toUpperCase().trim() }

function isImageFile(file) {
  return (file.type || '').indexOf('image/') === 0
}

/* Narrow viewport (matches this app's md: Tailwind breakpoint) or a browser-
   reported low-memory device (Chrome/Android only; iOS Safari doesn't expose
   deviceMemory, so width is the universal fallback). Used to cap raster size
   — a killed tab on a site phone is worse than a slightly softer render. */
function isMobileDevice() {
  return window.innerWidth < 768 || !!(navigator.deviceMemory && navigator.deviceMemory <= 4)
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

export default function TraceStudio(props) {
  // props: file (File), record (optional saved drawing to re-edit),
  //        projectId, onCancel(), onComplete(result, drawingRecord)
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
  // Zones: kind 'group' (devices inside form a location group) or 'highlight'
  // (visual annotation: relocated device, DDC position, etc). shape rect|circle.
  var zonesState = useState(rec ? (rec.zones || []).map(function(z) {
    return Object.assign({ kind: 'group', shape: 'rect', color: '#8B5CF6' }, z)
  }) : [])
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
  var resumeDraftState = useState(null) // {pins, loops, zones, meta, pageNum, savedAt} awaiting Restore/Discard
  var resumeDraft = resumeDraftState[0]
  var setResumeDraft = resumeDraftState[1]

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
  // Hi-res tile: re-render of the VISIBLE region at current zoom (vector PDFs
  // stay razor sharp at any zoom; base raster is only for fast panning)
  var hiResRef = useRef(null)        // {canvas, x, y, w, h, page} page-px space
  var hiResTokenRef = useRef(0)
  var hiResTimerRef = useRef(null)

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
      // Autosaved draft from an earlier session on this exact file (tab
      // killed before DONE, etc.) — offer to restore rather than silently
      // applying it, in case it's actually older than what's already loaded.
      getDraft(hash).then(function(d) { if (d && !cancelled) setResumeDraft(d) }).catch(function() {})
      // Background cloud backup — runs on every open (new file or
      // reopened record alike) so this device isn't the only place this
      // drawing exists. Best-effort; never blocks tracing.
      uploadDrawing(props.projectId, hash, props.file)
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

  // ─── Draft autosave ──────────────────────────────────────────
  // Pins/traces/zones otherwise live only in React state until DONE commits
  // the real drawing record — a killed tab before that loses everything.
  // Debounced local save, gated while a resume decision is still pending so
  // it never silently overwrites a not-yet-restored draft.
  useEffect(function() {
    if (!fileHashRef.current || resumeDraft) return
    var t = setTimeout(function() {
      saveDraft(fileHashRef.current, { pins: pins, loops: loops, zones: zones, meta: meta, pageNum: pageNum })
    }, 800)
    return function() { clearTimeout(t) }
  }, [pins, loops, zones, meta, pageNum, resumeDraft])

  function applyResumeDraft() {
    if (!resumeDraft) return
    setPins(resumeDraft.pins || [])
    setLoops(resumeDraft.loops || [])
    setZones(resumeDraft.zones || [])
    setMeta(resumeDraft.meta || meta)
    if (resumeDraft.pageNum && resumeDraft.pageNum !== pageRef.current) renderPage(resumeDraft.pageNum)
    setResumeDraft(null)
  }

  function discardResumeDraft() {
    clearDraft(fileHashRef.current)
    setResumeDraft(null)
  }

  function renderPage(n) {
    var pdf = pdfRef.current
    if (!pdf) return Promise.resolve()
    // Zero outgoing canvases before dropping the reference — canvas backing
    // memory isn't always promptly reclaimed by GC alone, and holding two
    // full-res rasters at once is exactly the kind of spike that gets a tab
    // killed on a phone.
    if (hiResRef.current && hiResRef.current.canvas) { hiResRef.current.canvas.width = 0; hiResRef.current.canvas.height = 0 }
    hiResRef.current = null
    hiResTokenRef.current++
    setLoading(true)
    return pdf.getPage(n).then(function(page) {
      var vp1 = page.getViewport({ scale: 1 })
      var mobile = isMobileDevice()
      var maxDim = mobile ? 2048 : 4096
      var scaleCap = mobile ? 2 : 4
      var scale = Math.min(maxDim / vp1.width, maxDim / vp1.height)
      if (scale > scaleCap) scale = scaleCap
      var vp = page.getViewport({ scale: scale })
      var off = document.createElement('canvas')
      off.width = Math.round(vp.width)
      off.height = Math.round(vp.height)
      var ctx = off.getContext('2d')
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function() {
        if (pageImgRef.current) { pageImgRef.current.width = 0; pageImgRef.current.height = 0 }
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

  // ─── Progressive sharp rendering ───────────────────────────
  // After the view settles, re-render ONLY the visible region of the PDF
  // at the current zoom level. Vector CAD PDFs stay crisp at any zoom.
  function scheduleHiRes() {
    if (hiResTimerRef.current) clearTimeout(hiResTimerRef.current)
    hiResTimerRef.current = setTimeout(renderHiResTile, 280)
  }

  function renderHiResTile() {
    var pdf = pdfRef.current
    if (!pdf) return // image files are already at native resolution
    var canvas = canvasRef.current
    var img = pageImgRef.current
    if (!canvas || !img) return
    var v = viewRef.current

    // Base raster is 1:1 or better at this zoom — no tile needed
    if (v.scale <= 1.05) {
      if (hiResRef.current) {
        if (hiResRef.current.canvas) { hiResRef.current.canvas.width = 0; hiResRef.current.canvas.height = 0 }
        hiResRef.current = null
        requestDraw()
      }
      return
    }

    // Visible region in page px, padded so small pans stay sharp
    var pad = 150 / v.scale + 100
    var x0 = Math.max(0, (0 - v.tx) / v.scale - pad)
    var y0 = Math.max(0, (0 - v.ty) / v.scale - pad)
    var x1 = Math.min(img.width, (canvas.width - v.tx) / v.scale + pad)
    var y1 = Math.min(img.height, (canvas.height - v.ty) / v.scale + pad)
    if (x1 <= x0 || y1 <= y0) return

    // Extra density over the base raster, memory-capped (tighter on mobile)
    var mobile = isMobileDevice()
    var density = Math.min(v.scale, mobile ? 3 : 6)
    var tw = Math.round((x1 - x0) * density)
    var th = Math.round((y1 - y0) * density)
    var maxPixels = mobile ? 1600 * 1600 : 3200 * 3200
    if (tw * th > maxPixels) {
      var shrink = Math.sqrt(maxPixels / (tw * th))
      density = density * shrink
      tw = Math.round((x1 - x0) * density)
      th = Math.round((y1 - y0) * density)
    }
    if (density <= 1.02) return

    var token = ++hiResTokenRef.current
    var pageNo = pageRef.current
    pdf.getPage(pageNo).then(function(page) {
      var vp1 = page.getViewport({ scale: 1 })
      var baseScale = img.width / vp1.width
      var vp = page.getViewport({ scale: baseScale * density })
      var c = document.createElement('canvas')
      c.width = tw
      c.height = th
      var cctx = c.getContext('2d')
      return page.render({
        canvasContext: cctx,
        viewport: vp,
        transform: [1, 0, 0, 1, -x0 * density, -y0 * density]
      }).promise.then(function() {
        if (token !== hiResTokenRef.current) return // stale — view moved on
        if (hiResRef.current && hiResRef.current.canvas && hiResRef.current.canvas !== c) {
          hiResRef.current.canvas.width = 0; hiResRef.current.canvas.height = 0
        }
        hiResRef.current = { canvas: c, x: x0, y: y0, w: x1 - x0, h: y1 - y0, page: pageNo }
        console.log('[TRACE] Sharp tile rendered: ' + tw + 'x' + th + ' @ density ' + density.toFixed(2) + 'x (zoom ' + viewRef.current.scale.toFixed(2) + ')')
        requestDraw()
      })
    }).catch(function(err) { console.warn('[TRACE] Hi-res render failed:', err && err.message) })
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
    scheduleHiRes()
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

  // Free the big rasters the moment Trace Studio closes rather than waiting
  // on GC — matters most reopening this same heavy view on a phone.
  useEffect(function() {
    return function() {
      if (pageImgRef.current) { pageImgRef.current.width = 0; pageImgRef.current.height = 0 }
      if (hiResRef.current && hiResRef.current.canvas) { hiResRef.current.canvas.width = 0; hiResRef.current.canvas.height = 0 }
    }
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

    // Sharp overlay of the visible region (rendered at current zoom)
    var hr = hiResRef.current
    if (hr && hr.page === page) {
      ctx.drawImage(hr.canvas, hr.x, hr.y, hr.w, hr.h)
    }

    // Zones + highlights (under strokes)
    zonesRef.current.forEach(function(z) {
      if ((z.page || 1) !== page) return
      var x = z.x1 * W
      var y = z.y1 * H
      var w = (z.x2 - z.x1) * W
      var h = (z.y2 - z.y1) * H
      var col = z.color || '#8B5CF6'
      ctx.globalAlpha = 0.07
      ctx.fillStyle = col
      if (z.shape === 'circle') {
        ctx.beginPath()
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.fillRect(x, y, w, h)
      }
      ctx.globalAlpha = 0.85
      ctx.strokeStyle = col
      ctx.lineWidth = 2 / v.scale
      ctx.setLineDash(z.kind === 'highlight' ? [3 / v.scale, 4 / v.scale] : [8 / v.scale, 6 / v.scale])
      if (z.shape === 'circle') {
        ctx.beginPath()
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.strokeRect(x, y, w, h)
      }
      ctx.setLineDash([])
      ctx.fillStyle = col
      ctx.font = 'bold ' + (14 / v.scale) + 'px Inter, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(z.name, x + 6 / v.scale, y + 6 / v.scale)
      ctx.globalAlpha = 1
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

    // Cable-issue markers (remarks placed on the drawing)
    loopsRef.current.forEach(function(loop) {
      if ((loop.page || 1) !== page) return
      ;(loop.remarks || []).forEach(function(rm) {
        if (rm.x == null || rm.y == null) return
        var mx = rm.x * W
        var my = rm.y * H
        var mr = 11 / v.scale
        ctx.beginPath()
        ctx.arc(mx, my, mr, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(239,68,68,0.95)'
        ctx.fill()
        ctx.lineWidth = 2 / v.scale
        ctx.strokeStyle = '#0F172A'
        ctx.stroke()
        ctx.strokeStyle = '#FFFFFF'
        ctx.lineWidth = 2.5 / v.scale
        var k2 = mr * 0.45
        ctx.beginPath()
        ctx.moveTo(mx - k2, my - k2); ctx.lineTo(mx + k2, my + k2)
        ctx.moveTo(mx + k2, my - k2); ctx.lineTo(mx - k2, my + k2)
        ctx.stroke()
      })
    })

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

  // ─── Text picking (PDF text layer only — see file header) ──
  function pickTextAt(pagePt) {
    var pf = pickRef.current
    if (!pf) return
    var page = pageRef.current

    // Text layer: nearest item wins (instant, free)
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

    // No text layer on this drawing (scan/image) — type it manually
    setPickField(null)
    setAiMsg('NO TEXT LAYER ON THIS DRAWING — TYPE IT IN')
    setEditPinId(pf.pinId)
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

    // Right-click a pin or a traced line to delete it immediately; right-click
    // on empty canvas still pans (navigate mid-trace on desktop), unchanged.
    if (e.button === 2) {
      var rHit = hitPin(pt)
      if (rHit) {
        if (window.confirm('DELETE PIN ' + (rHit.tag || rHit.serial || '') + '?')) deletePin(rHit.id)
        return
      }
      var rStroke = hitStroke(pt)
      if (rStroke) {
        if (window.confirm('DELETE THIS TRACED SEGMENT?')) deleteStroke(rStroke.loopId, rStroke.strokeIdx)
        return
      }
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

    if (m === 'mark') {
      gestureRef.current = { type: 'marktap', pt: pt, moved: false, startX: e.clientX, startY: e.clientY }
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

    if (g.type === 'addpin' || g.type === 'picktap' || g.type === 'marktap') {
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
    if (g.type === 'pan' || g.type === 'pinch') scheduleHiRes()

    if (g.type === 'stroke') { commitStroke(); return }
    if (g.type === 'addpin' && !g.moved) { addPinAt(g.pt); return }
    if (g.type === 'dragpin' && !g.moved) { setEditPinId(g.pinId); return }
    if (g.type === 'picktap' && !g.moved) { pickTextAt(g.pt); return }
    if (g.type === 'picktap' && g.moved) { return }
    if (g.type === 'marktap' && !g.moved) { markCableAt(g.pt); return }
    if (g.type === 'marktap' && g.moved) { return }
    if (g.type === 'zone') { commitZone(); return }
  }

  /* MARK mode: tap on a traced line -> cable-issue marker between the two
     nearest captured devices on that loop. Feeds the Blockers board. */
  function markCableAt(pagePt) {
    var img = pageImgRef.current
    if (!img) return
    var page = pageRef.current
    var thresh = 30 / viewRef.current.scale
    if (thresh < 20) thresh = 20
    var best = null
    loopsRef.current.forEach(function(loop) {
      if ((loop.page || 1) !== page) return
      loop.strokes.forEach(function(stroke) {
        for (var i = 0; i < stroke.length - 1; i++) {
          var d = perpDist(pagePt, stroke[i], stroke[i + 1])
          if (d < thresh && (!best || d < best.d)) best = { d: d, loop: loop }
        }
      })
    })
    if (!best) { setAiMsg('TAP CLOSER TO A TRACED LINE TO MARK A CABLE ISSUE'); return }
    var loop = best.loop
    if (loop.deviceIds.length < 2) { setAiMsg('THIS LOOP NEEDS AT LEAST 2 CAPTURED DEVICES BEFORE MARKING A CABLE SEGMENT'); return }

    var dists = loop.deviceIds.map(function(pid, idx) {
      var p = pinsRef.current.find(function(x) { return x.id === pid })
      if (!p) return { idx: idx, d: Infinity }
      return { idx: idx, d: Math.hypot(p.x * img.width - pagePt.x, p.y * img.height - pagePt.y) }
    })
    dists.sort(function(a, b) { return a.d - b.d })
    var afterIndex = Math.min(dists[0].idx, dists[1].idx)

    setActiveLoopId(loop.id)
    activeLoopRef.current = loop.id
    setEditRemark({ loopId: loop.id, afterIndex: afterIndex, x: pagePt.x / img.width, y: pagePt.y / img.height })
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
      kind: 'group',
      shape: 'rect',
      color: ZONE_COLORS[zonesRef.current.length % ZONE_COLORS.length],
      x1: x1 / img.width, y1: y1 / img.height,
      x2: x2 / img.width, y2: y2 / img.height,
      page: pageRef.current
    }
    zonesRef.current = zonesRef.current.concat([zone])
    setZones(zonesRef.current)
    setEditZoneId(zone.id)
    requestDraw()
  }

  // Where a newly-captured pin belongs in the sequence: find which
  // ALREADY-captured device is nearest each end of the just-drawn stroke, and
  // insert right after the earlier of the two. Redrawing a short connector
  // between device 14 and device 16 to pick up a missed device correctly
  // lands it as #15, instead of always appending to the end of the loop.
  // Falls back to appending when there's nothing yet to anchor against (the
  // loop's first stroke) or the stroke doesn't reach any captured device.
  function findInsertIndex(loop, rawStroke, img) {
    var existing = []
    loop.deviceIds.forEach(function(pid, idx) {
      var p = pinsRef.current.find(function(x) { return x.id === pid })
      if (p) existing.push({ idx: idx, pin: p })
    })
    if (existing.length === 0) return loop.deviceIds.length
    function nearest(pt) {
      var best = null
      var bestD = Infinity
      existing.forEach(function(e) {
        var d = Math.hypot(e.pin.x * img.width - pt.x, e.pin.y * img.height - pt.y)
        if (d < bestD) { bestD = d; best = e }
      })
      return best
    }
    var a = nearest(rawStroke[0])
    var b = nearest(rawStroke[rawStroke.length - 1])
    if (!a || !b) return loop.deviceIds.length
    return Math.min(a.idx, b.idx) + 1
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

    var insertAt = findInsertIndex(loop, raw, img)
    var newIds = loop.deviceIds.slice(0, insertAt).concat(capturedIds).concat(loop.deviceIds.slice(insertAt))
    loopsRef.current = loopsRef.current.map(function(l) {
      if (l.id !== loop.id) return l
      return Object.assign({}, l, {
        strokes: l.strokes.concat([simplified]),
        deviceIds: newIds
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
    scheduleHiRes()
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
    scheduleHiRes()
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

  function setRemark(loopId, afterIndex, text, pos) {
    loopsRef.current = loopsRef.current.map(function(l) {
      if (l.id !== loopId) return l
      var existing = (l.remarks || []).find(function(r) { return r.afterIndex === afterIndex })
      var remarks = (l.remarks || []).filter(function(r) { return r.afterIndex !== afterIndex })
      if (text && text.trim()) {
        var entry = { afterIndex: afterIndex, text: up(text) }
        // Keep/set the on-drawing marker position
        if (pos && pos.x != null) { entry.x = pos.x; entry.y = pos.y }
        else if (existing && existing.x != null) { entry.x = existing.x; entry.y = existing.y }
        remarks = remarks.concat([entry])
      }
      return Object.assign({}, l, { remarks: remarks })
    })
    setLoops(loopsRef.current)
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

  // Manual nudge of a device's position in the sequence (▲▼ in the loop
  // panel) — lets a wrong serialization be fixed with two clicks instead of
  // deleting and retracing the whole loop.
  function moveDeviceInLoop(loopId, index, dir) {
    loopsRef.current = loopsRef.current.map(function(l) {
      if (l.id !== loopId) return l
      var ids = l.deviceIds.slice()
      var j = index + dir
      if (j < 0 || j >= ids.length) return l
      var tmp = ids[index]; ids[index] = ids[j]; ids[j] = tmp
      return Object.assign({}, l, { deviceIds: ids })
    })
    setLoops(loopsRef.current)
    requestDraw()
  }

  // Shared by undoLastStroke and deleteStroke: a loop's deviceIds are always
  // re-derivable from which pins its remaining stroke geometry passes near —
  // recomputing from scratch (rather than trying to track "which stroke
  // captured which pin") keeps this a single source of truth. Trade-off: a
  // device manually unlisted via removeFromLoop() can reappear if a stroke is
  // later deleted/undone and the geometry still passes near it — pre-existing
  // behavior, not new here.
  function recaptureIds(strokes, page, img) {
    var captureR = 14
    var already = {}
    var ids = []
    strokes.forEach(function(stroke) {
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
    return ids
  }

  // Right-click a traced line to delete just that segment (see hitStroke) —
  // deliberately smaller-grained than deleting the whole loop.
  function deleteStroke(loopId, strokeIdx) {
    var loop = loopsRef.current.find(function(l) { return l.id === loopId })
    if (!loop) return
    var img = pageImgRef.current
    if (!img) return
    var remaining = loop.strokes.filter(function(_, i) { return i !== strokeIdx })
    var ids = recaptureIds(remaining, loop.page || 1, img)
    loopsRef.current = loopsRef.current.map(function(l) {
      return l.id === loopId ? Object.assign({}, l, { strokes: remaining, deviceIds: ids }) : l
    })
    setLoops(loopsRef.current)
    requestDraw()
  }

  // Nearest traced segment to a tap/click, across all loops on the current
  // page — same proximity approach as markCableAt, reused for right-click delete.
  function hitStroke(pagePt) {
    var page = pageRef.current
    var thresh = 24 / viewRef.current.scale
    if (thresh < 16) thresh = 16
    var best = null
    loopsRef.current.forEach(function(loop) {
      if ((loop.page || 1) !== page) return
      loop.strokes.forEach(function(stroke, si) {
        for (var i = 0; i < stroke.length - 1; i++) {
          var d = perpDist(pagePt, stroke[i], stroke[i + 1])
          if (d < thresh && (!best || d < best.d)) best = { d: d, loopId: loop.id, strokeIdx: si }
        }
      })
    })
    return best
  }

  function undoLastStroke() {
    var loop = loopsRef.current.find(function(l) { return l.id === activeLoopRef.current })
    if (!loop || loop.strokes.length === 0) return
    var img = pageImgRef.current
    if (!img) return
    var remaining = loop.strokes.slice(0, -1)
    var ids = recaptureIds(remaining, pageRef.current, img)
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
    var unmatched = pins.filter(function(p) { return !placed[p.id] && /^(FCU|VAV|AHU|PAU|ERU|PMU|PM|WM|BTU)/i.test(p.tag) })
      .map(function(p) { return { tag: p.tag, room: p.room, thermostat: p.thermostat, address: p.address, serial: p.serial } })

    // Zones -> device groupings for the location view (highlights are visual only)
    var zoneGroups = zones.filter(function(z) { return z.kind !== 'highlight' }).map(function(z) {
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

    clearDraft(fileHashRef.current)
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
          {modeBtn('mark', '⚠', 'MARK')}
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
        <button onClick={handleDone} disabled={tracedCount === 0} className={'px-4 py-1.5 rounded-md text-[10px] font-bold uppercase transition ' + (tracedCount > 0 ? 'bg-teal text-white hover:bg-teal/80' : 'bg-card2 text-dgray cursor-not-allowed')}>
          DONE ({tracedCount})
        </button>
      </div>

      {resumeDraft && (
        <div className="px-3 py-1.5 bg-orange/20 border-b border-orange text-[10px] text-orange font-bold uppercase flex items-center gap-3">
          <span>UNSAVED WORK FOUND FROM A PREVIOUS SESSION ON THIS DRAWING — RESTORE IT?</span>
          <button onClick={applyResumeDraft} className="px-2.5 py-1 bg-orange text-navy rounded font-bold">RESTORE</button>
          <button onClick={discardResumeDraft} className="text-white/70 hover:text-white">DISCARD</button>
        </div>
      )}
      {aiMsg && (
        <div className="px-3 py-1 bg-card border-b border-border text-[9px] text-orange uppercase truncate">{aiMsg}</div>
      )}
      {pickField && (
        <div className="px-3 py-1.5 bg-teal/20 border-b border-teal text-[10px] text-teal font-bold uppercase">
          TAP THE TEXT ON THE DRAWING TO FILL {pickField.field === 'tag' ? 'EQUIPMENT NAME' : pickField.field.toUpperCase()} {hasTextLayer ? '(TEXT LAYER)' : '(NO TEXT LAYER — TYPE MANUALLY)'}
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
              {mode === 'trace' && 'DRAW ALONG THE LOOP — PINS CAPTURE IN ORDER. RIGHT-CLICK A PIN OR LINE TO DELETE IT · RIGHT-DRAG EMPTY SPACE OR TWO FINGERS TO MOVE AROUND.'}
              {mode === 'pin' && 'TAP EMPTY = ADD PIN · DRAG PIN = MOVE · TAP PIN = EDIT · RIGHT-CLICK PIN = DELETE'}
              {mode === 'zone' && 'DRAG AN AREA — THEN SET TYPE (DEVICE ZONE / HIGHLIGHT), SHAPE AND COLOR'}
              {mode === 'mark' && 'TAP ON A TRACED LINE TO MARK A CABLE ISSUE BETWEEN TWO DEVICES → GOES TO BLOCKERS'}
              {mode === 'pan' && 'DRAG TO MOVE · WHEEL / PINCH TO ZOOM'}
            </div>
          )}

          {/* Pin editor */}
          {editPin && (
            <div className="absolute top-3 left-3 bg-card border border-teal rounded-xl p-3 w-72 z-10 max-h-[70%] overflow-y-auto">
              <div className="text-[9px] text-teal font-bold uppercase mb-2">EDIT DEVICE PIN {editPin.source === 'ai' ? '(AI)' : ''}</div>

              <label className="text-[8px] text-dgray uppercase block mb-0.5">EQUIPMENT NAME (TAG)</label>
              <div className="flex gap-1 mb-2">
                <input value={editPin.tag} onChange={function(e) { updatePin(editPin.id, { tag: upKeep(e.target.value) }) }}
                  className="flex-1 bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase outline-none focus:border-teal" />
                <button onClick={function() { setPickField({ pinId: editPin.id, field: 'tag' }) }} title="PICK FROM DRAWING" className="px-2 py-1 bg-teal/20 text-teal text-[9px] font-bold rounded uppercase hover:bg-teal/30">PICK</button>
              </div>

              <label className="text-[8px] text-dgray uppercase block mb-0.5">DEVICE SERIAL NO. (SHOWN ON DRAWING)</label>
              <input value={editPin.serial || ''} onChange={function(e) { updatePin(editPin.id, { serial: upKeep(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-2 outline-none focus:border-teal" />

              <label className="text-[8px] text-dgray uppercase block mb-0.5">ADDRESS NO.</label>
              <input value={editPin.address || ''} onChange={function(e) { updatePin(editPin.id, { address: upKeep(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-2 outline-none focus:border-teal" />

              <label className="text-[8px] text-dgray uppercase block mb-0.5">ROOM NAME</label>
              <div className="flex gap-1 mb-3">
                <input value={editPin.room || ''} onChange={function(e) { updatePin(editPin.id, { room: upKeep(e.target.value) }) }}
                  className="flex-1 bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase outline-none focus:border-teal" />
                <button onClick={function() { setPickField({ pinId: editPin.id, field: 'room' }) }} title="PICK FROM DRAWING" className="px-2 py-1 bg-teal/20 text-teal text-[9px] font-bold rounded uppercase hover:bg-teal/30">PICK</button>
              </div>

              <div className="flex gap-2">
                <button onClick={function() { setEditPinId(null) }} className="flex-1 px-2 py-1.5 bg-teal text-white text-[9px] font-bold rounded uppercase">CLOSE</button>
                <button onClick={function() { deletePin(editPin.id) }} className="px-2 py-1.5 bg-red/20 text-red text-[9px] font-bold rounded uppercase">DELETE</button>
              </div>
            </div>
          )}

          {/* Zone / highlight editor */}
          {editZone && (
            <div className="absolute top-3 left-3 bg-card border border-purple rounded-xl p-3 w-72 z-10">
              <div className="text-[9px] text-purple font-bold uppercase mb-2">EDIT {editZone.kind === 'highlight' ? 'HIGHLIGHT' : 'ZONE'}</div>

              <label className="text-[8px] text-dgray uppercase block mb-0.5">NAME / LABEL</label>
              <input value={editZone.name} onChange={function(e) { updateZone(editZone.id, { name: upKeep(e.target.value) }) }}
                className="w-full bg-navy border border-border rounded px-2 py-1 text-[11px] text-white uppercase mb-2 outline-none focus:border-purple" />

              <label className="text-[8px] text-dgray uppercase block mb-1">TYPE</label>
              <div className="flex gap-1.5 mb-2">
                <button onClick={function() { updateZone(editZone.id, { kind: 'group' }) }} className={'flex-1 px-2 py-1 text-[9px] font-bold rounded uppercase transition ' + (editZone.kind !== 'highlight' ? 'bg-purple text-white' : 'bg-card2 text-dgray hover:text-white')}>DEVICE ZONE</button>
                <button onClick={function() { updateZone(editZone.id, { kind: 'highlight' }) }} className={'flex-1 px-2 py-1 text-[9px] font-bold rounded uppercase transition ' + (editZone.kind === 'highlight' ? 'bg-purple text-white' : 'bg-card2 text-dgray hover:text-white')}>HIGHLIGHT</button>
              </div>

              <label className="text-[8px] text-dgray uppercase block mb-1">SHAPE</label>
              <div className="flex gap-1.5 mb-2">
                <button onClick={function() { updateZone(editZone.id, { shape: 'rect' }) }} className={'flex-1 px-2 py-1 text-[9px] font-bold rounded uppercase transition ' + (editZone.shape !== 'circle' ? 'bg-purple text-white' : 'bg-card2 text-dgray hover:text-white')}>▭ RECT</button>
                <button onClick={function() { updateZone(editZone.id, { shape: 'circle' }) }} className={'flex-1 px-2 py-1 text-[9px] font-bold rounded uppercase transition ' + (editZone.shape === 'circle' ? 'bg-purple text-white' : 'bg-card2 text-dgray hover:text-white')}>◯ CIRCLE</button>
              </div>

              <label className="text-[8px] text-dgray uppercase block mb-1">COLOR</label>
              <div className="flex gap-1.5 mb-3">
                {ZONE_COLORS.map(function(c) {
                  return <button key={c} onClick={function() { updateZone(editZone.id, { color: c }) }}
                    className={'w-6 h-6 rounded-full transition ' + (editZone.color === c ? 'ring-2 ring-white scale-110' : 'opacity-60 hover:opacity-100')}
                    style={{ background: c }}></button>
                })}
              </div>

              <div className="text-[8px] text-dgray uppercase mb-3">
                {editZone.kind === 'highlight'
                  ? 'VISUAL MARKER ONLY — USE FOR RELOCATED EQUIPMENT, DDC POSITION, NOTES ON THE DRAWING.'
                  : 'DEVICES INSIDE THIS AREA WILL FORM A GROUP IN THE LOCATION VIEW.'}
              </div>
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
                    setRemark(editRemark.loopId, editRemark.afterIndex, inp ? inp.value : '', editRemark)
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
              <input value={meta.name} onChange={function(e) { setMeta(Object.assign({}, meta, { name: upKeep(e.target.value) })) }} placeholder="NAME" className="col-span-2 bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
              <input value={meta.floor} onChange={function(e) { setMeta(Object.assign({}, meta, { floor: upKeep(e.target.value) })) }} placeholder="FLOOR" className="bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
              <input value={meta.block} onChange={function(e) { setMeta(Object.assign({}, meta, { block: upKeep(e.target.value) })) }} placeholder="BLOCK" className="bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
              <input value={meta.zone} onChange={function(e) { setMeta(Object.assign({}, meta, { zone: upKeep(e.target.value) })) }} placeholder="ZONE/AREA" className="col-span-2 bg-navy border border-border rounded px-2 py-1 text-[10px] text-white uppercase outline-none focus:border-teal" />
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
                      var v = upKeep(e.target.value)
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
                            <span key={pid} className="flex items-center gap-0.5">
                              <span className="flex flex-col leading-none">
                                <button onClick={function(e) { e.stopPropagation(); moveDeviceInLoop(loop.id, i, -1) }}
                                  disabled={i === 0} title="MOVE EARLIER IN SEQUENCE"
                                  className="text-[7px] text-dgray hover:text-teal disabled:opacity-20 disabled:hover:text-dgray">▲</button>
                                <button onClick={function(e) { e.stopPropagation(); moveDeviceInLoop(loop.id, i, 1) }}
                                  disabled={i === loop.deviceIds.length - 1} title="MOVE LATER IN SEQUENCE"
                                  className="text-[7px] text-dgray hover:text-teal disabled:opacity-20 disabled:hover:text-dgray">▼</button>
                              </span>
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
        {modeBtn('pan', '✋', '')}
        {modeBtn('pin', '📍', '')}
        {modeBtn('trace', '✏️', '')}
        {modeBtn('zone', '▭', '')}
        {modeBtn('mark', '⚠', '')}
        <button onClick={function() { setStraighten(!straighten) }} className={'px-2.5 py-2 rounded-md text-[11px] font-bold transition ' + (straighten ? 'bg-teal/20 text-teal' : 'bg-card2 text-dgray')}>⊾</button>
        <button onClick={function() { setPanelOpen(!panelOpen) }} className="px-2.5 py-2 bg-card2 text-dgray rounded-md text-[11px] font-bold uppercase">☰</button>
      </div>
    </div>
  )
}
