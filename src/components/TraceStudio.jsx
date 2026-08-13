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
import { jsPDF } from 'jspdf'
import { putFile } from '../lib/fileStore'
import { saveDraft, getDraft, clearDraft } from '../lib/traceDraftStore'
import { uploadDrawing } from '../lib/drawingCloudStore'
import { buildPageCache, getManifest, drawRegion, drawFullPage } from '../lib/rasterCache'

// 20 distinct, high-saturation colors — a real project runs well past 6 loops (BN01 alone has
// 20+), and the old 6-color array silently wrapped and repeated (GW1-R1 and LOOP-07 both landed
// on the same cyan). Still not infinite — the color-picker dot lets a user override past that,
// or pick a specific color deliberately regardless of count.
var LOOP_COLORS = [
  '#22D3EE', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#EC4899',
  '#3B82F6', '#6366F1', '#A855F7', '#D946EF', '#F43F5E', '#F97316',
  '#EAB308', '#84CC16', '#22C55E', '#14B8A6', '#0EA5E9', '#0891B2',
  '#B45309', '#65A30D'
]
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
  var exportingState = useState(false)
  var exporting = exportingState[0]
  var setExporting = exportingState[1]
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
  var colorPickerState = useState(null) // loop id whose color swatch grid is open, or null
  var colorPickerLoopId = colorPickerState[0]
  var setColorPickerLoopId = colorPickerState[1]
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
  var cacheMsgState = useState('')  // one-time raster cache build progress, '' when idle
  var cacheMsg = cacheMsgState[0]
  var setCacheMsg = cacheMsgState[1]

  // ─── Refs ──────────────────────────────────────────────────
  var canvasRef = useRef(null)
  var importInputRef = useRef(null)
  var wrapRef = useRef(null)
  var pdfRef = useRef(null)
  var pageImgRef = useRef(null)
  var textItemsRef = useRef([])     // [{str,x,y,page}] page px (text-layer PDFs only)
  var viewRef = useRef({ scale: 1, tx: 0, ty: 0 })
  var pointersRef = useRef({})
  var gestureRef = useRef(null)
  var strokeRef = useRef([])
  var tempZoneRef = useRef(null)    // live rectangle while dragging, page px
  var tempSelectRef = useRef(null)  // live box-select rectangle while dragging, page px
  var selectedRef = useRef({})      // pin id -> true, multi-select for group drag (PIN mode)
  var fileHashRef = useRef(rec ? (rec.fileHash || '') : '')
  var rafRef = useRef(0)
  // Hi-res tile: re-render of the VISIBLE region at current zoom (vector PDFs
  // stay razor sharp at any zoom; base raster is only for fast panning)
  var hiResRef = useRef(null)        // {canvas, x, y, w, h, page} page-px space
  var hiResTokenRef = useRef(0)
  var hiResTimerRef = useRef(null)
  // Raster cache (see lib/rasterCache.js). Heavy CAD exports cost 10+ seconds
  // PER RENDER regardless of resolution, so re-rendering the vector page on
  // every zoom is unusable. Once a page is cached, both the base raster and the
  // sharp zoom tiles come from stored tiles instead of the vector page.
  var hashReadyRef = useRef(null)    // Promise<hash> — putFile() runs in parallel with the PDF load
  var manifestRef = useRef({})       // pageNo -> manifest, for the current file
  var cacheBuildingRef = useRef({})  // pageNo -> true while a build is in flight

  var pinsRef = useRef(pins);               pinsRef.current = pins
  var loopsRef = useRef(loops);             loopsRef.current = loops
  // Undo stack for loop/stroke edits (draw, delete-stroke, drag-resnap, delete-loop) — a plain
  // snapshot stack, not per-field diffing, since every mutation here already replaces
  // loopsRef.current wholesale via .map()/.filter() rather than mutating in place.
  var undoStackRef = useRef([])
  var zonesRef = useRef(zones);             zonesRef.current = zones
  var activeLoopRef = useRef(activeLoopId); activeLoopRef.current = activeLoopId
  var pageRef = useRef(pageNum);            pageRef.current = pageNum
  var modeRef = useRef(mode);               modeRef.current = mode
  var pickRef = useRef(pickField);          pickRef.current = pickField

  // ─── Load file (PDF or image) + render ─────────────────────
  useEffect(function() {
    var cancelled = false

    // Never rejects — the raster cache awaits this and must not be taken down
    // by a best-effort IndexedDB write failing.
    hashReadyRef.current = putFile(props.file).catch(function() { return null })
    hashReadyRef.current.then(function(hash) {
      if (!hash) return
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

  // Rasterize page N to its own fresh canvas + viewport, with no side effects on any live-view
  // state (pageImgRef, pageNum, hi-res tiles, text layer). Shared by renderPage() (the normal
  // "switch to this page" path) and exportPdf() (which rasterizes every page with loops on it
  // without disturbing whatever page the user is actively looking at).
  function rasterizePageRaw(n) {
    var pdf = pdfRef.current
    if (!pdf) return Promise.resolve(null) // single-image file — caller falls back to pageImgRef
    var mobile = isMobileDevice()
    var maxDim = mobile ? 2048 : 4096

    return (hashReadyRef.current || Promise.resolve(null)).then(function(hash) {
      // Cache hit: the whole base view is an image blit, no vector work at all.
      if (!hash) return null
      return getManifest(hash, n).then(function(m) {
        if (!m) return null
        manifestRef.current[n] = m
        return drawFullPage(hash, n, m, maxDim).then(function(canvas) {
          return pdf.getPage(n).then(function(page) {
            return { canvas: canvas, page: page, viewport: page.getViewport({ scale: canvas.width / m.pageWidth }) }
          })
        })
      }).catch(function() { return null })
    }).then(function(cached) {
      if (cached) return cached

      return pdf.getPage(n).then(function(page) {
        var vp1 = page.getViewport({ scale: 1 })
        var scaleCap = mobile ? 2 : 4
        var scale = Math.min(maxDim / vp1.width, maxDim / vp1.height)
        if (scale > scaleCap) scale = scaleCap
        var vp = page.getViewport({ scale: scale })
        var off = document.createElement('canvas')
        off.width = Math.round(vp.width)
        off.height = Math.round(vp.height)
        var t0 = Date.now()
        return page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise
          .then(function() {
            // How long that took IS the heaviness test — no need to count
            // operators. Anything past ~1.2s will make every zoom miserable,
            // so pay the one-time cache build now.
            if (Date.now() - t0 > 1200) maybeBuildCache(n)
            return { canvas: off, page: page, viewport: vp }
          })
      })
    })
  }

  /* One-time raster cache build for a heavy page. Fire-and-forget: the user
     keeps working on the already-rendered base raster while it runs, and the
     payoff lands on the next zoom (and every future open of this file). */
  function maybeBuildCache(n) {
    if (cacheBuildingRef.current[n] || manifestRef.current[n]) return
    var pdf = pdfRef.current
    if (!pdf) return
    cacheBuildingRef.current[n] = true
    ;(hashReadyRef.current || Promise.resolve(null)).then(function(hash) {
      if (!hash) return null
      setCacheMsg('OPTIMIZING DRAWING FOR FAST ZOOM…')
      return buildPageCache(pdf, hash, n, function(frac, label) {
        setCacheMsg(label + ' ' + Math.round(frac * 100) + '%')
      }).then(function(m) {
        manifestRef.current[n] = m
        console.log('[TRACE] Raster cache built for page ' + n + ' in ' + m.buildMs + 'ms (' + m.cols + 'x' + m.rows + ' tiles @ ' + m.width + 'x' + m.height + ')')
        setCacheMsg('')
      })
    }).catch(function(err) {
      console.warn('[TRACE] Raster cache build failed:', err && err.message)
      setCacheMsg('')
    }).then(function() { cacheBuildingRef.current[n] = false })
  }

  function renderPage(n) {
    if (!pdfRef.current) return Promise.resolve()
    // Zero outgoing canvases before dropping the reference — canvas backing
    // memory isn't always promptly reclaimed by GC alone, and holding two
    // full-res rasters at once is exactly the kind of spike that gets a tab
    // killed on a phone.
    if (hiResRef.current && hiResRef.current.canvas) { hiResRef.current.canvas.width = 0; hiResRef.current.canvas.height = 0 }
    hiResRef.current = null
    hiResTokenRef.current++
    setLoading(true)
    return rasterizePageRaw(n).then(function(res) {
      if (pageImgRef.current) { pageImgRef.current.width = 0; pageImgRef.current.height = 0 }
      pageImgRef.current = res.canvas
      // Text layer (true CAD PDFs) -> selectable labels
      return res.page.getTextContent().then(function(content) {
        var items = []
        ;(content.items || []).forEach(function(it) {
          if (!it.str || !it.str.trim()) return
          var p = res.viewport.convertToViewportPoint(it.transform[4], it.transform[5])
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
    }).catch(function(err) {
      setError(err.message || 'PAGE RENDER FAILED')
      setLoading(false)
    })
  }

  // ─── PDF export: clean copy of every page that has traced loops on it ──
  // Deliberately NOT a 1:1 screenshot of the live view — skips zones and cable-issue markers,
  // draws every pin at full opacity regardless of which loop is "active", and only labels pins
  // that are actually captured onto a loop (an untraced stray pin isn't a "traced object"). That
  // is what "clean" means here: the trace record, not the working canvas.
  function pageHasLoops(n) {
    return loopsRef.current.some(function(l) { return (l.page || 1) === n && l.strokes.length > 0 })
  }

  function drawExportOverlay(ctx, img, page) {
    var W = img.width, H = img.height
    var pinLoop = {}
    loopsRef.current.forEach(function(loop) { loop.deviceIds.forEach(function(pid) { pinLoop[pid] = loop }) })

    loopsRef.current.forEach(function(loop) {
      if ((loop.page || 1) !== page) return
      ctx.strokeStyle = loop.color
      ctx.lineWidth = Math.max(3, W / 700)
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

    var r = Math.max(9, W / 750)
    pinsRef.current.forEach(function(pin) {
      if ((pin.page || 1) !== page) return
      var lp = pinLoop[pin.id]
      if (!lp) return
      var idx = lp.deviceIds.indexOf(pin.id)
      var px = pin.x * W, py = pin.y * H
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.fillStyle = lp.color
      ctx.fill()
      ctx.lineWidth = Math.max(1.5, r * 0.15)
      ctx.strokeStyle = '#0F172A'
      ctx.stroke()
      ctx.fillStyle = '#FFFFFF'
      ctx.font = 'bold ' + Math.round(r * 1.1) + 'px Arial, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(idx + 1), px, py)
      ctx.fillStyle = '#111111'
      ctx.font = Math.round(r * 0.95) + 'px Arial, sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(pin.tag || '', px + r + 4, py)
    })
  }

  function exportPdf() {
    var pages = []
    for (var n = 1; n <= pageCount; n++) if (pageHasLoops(n)) pages.push(n)
    if (pages.length === 0) { setAiMsg('NO TRACED LOOPS TO EXPORT'); return }
    setExporting(true)
    var doc = null
    var chain = Promise.resolve()
    pages.forEach(function(n) {
      chain = chain
        .then(function() { return pdfRef.current ? rasterizePageRaw(n).then(function(res) { return res.canvas }) : pageImgRef.current })
        .then(function(img) {
          var off = document.createElement('canvas')
          off.width = img.width
          off.height = img.height
          var ctx = off.getContext('2d')
          ctx.fillStyle = '#FFFFFF'
          ctx.fillRect(0, 0, off.width, off.height)
          ctx.drawImage(img, 0, 0)
          drawExportOverlay(ctx, img, n)

          var headerH = Math.max(30, img.width / 35)
          var pageW = img.width, pageH = img.height + headerH
          if (!doc) doc = new jsPDF({ orientation: pageW >= pageH ? 'landscape' : 'portrait', unit: 'pt', format: [pageW, pageH] })
          else doc.addPage([pageW, pageH], pageW >= pageH ? 'landscape' : 'portrait')
          doc.setFillColor(15, 23, 42)
          doc.rect(0, 0, pageW, headerH, 'F')
          doc.setTextColor(255, 255, 255)
          doc.setFontSize(Math.max(11, headerH * 0.4))
          doc.text((meta.name || 'DRAWING') + (pages.length > 1 ? ' — PAGE ' + n : '') + ' — ' + new Date().toLocaleDateString(), 10, headerH * 0.65)
          doc.addImage(off.toDataURL('image/jpeg', 0.92), 'JPEG', 0, headerH, img.width, img.height)
        })
    })
    chain.then(function() {
      doc.save((meta.name || 'trace-export').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.pdf')
      setExporting(false)
    }).catch(function(err) {
      setAiMsg('EXPORT FAILED: ' + (err && err.message || err))
      setExporting(false)
    })
  }

  // ─── Traced-objects export/import: recover from a slow/corrupted drawing by re-uploading a
  // fresh copy of the SAME floor without redoing the trace work ────────────────────────────
  // Deliberately excludes stroke geometry and zones — a traced line's coordinates only mean
  // anything relative to the exact image they were drawn on; carrying them onto a different
  // (even if very similar) source image would draw a meaningless line. What's actually
  // expensive to redo — and what this preserves — is the DATA: tags, addresses, room names,
  // and which devices belong to which loop, in what order.
  function exportTraceObjects() {
    var loopsWithDevices = loopsRef.current.filter(function(l) { return l.deviceIds.length > 0 })
    if (loopsWithDevices.length === 0) { setAiMsg('NO TRACED LOOPS TO EXPORT'); return }
    var pinIds = {}
    loopsWithDevices.forEach(function(l) { l.deviceIds.forEach(function(pid) { pinIds[pid] = true }) })
    var exportPins = pinsRef.current.filter(function(p) { return pinIds[p.id] }).map(function(p) {
      return { id: p.id, tag: p.tag || '', room: p.room || '', address: p.address || '', thermostat: p.thermostat || '', serial: p.serial || '', x: p.x, y: p.y }
    })
    var exportLoops = loopsWithDevices.map(function(l) {
      return { id: l.id, name: l.name, color: l.color, deviceIds: l.deviceIds.slice() }
    })
    var payload = {
      minimate_trace_export: true,
      version: 1,
      exported_at: new Date().toISOString(),
      source_name: meta.name || '',
      pins: exportPins,
      loops: exportLoops
    }
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = (meta.name || 'trace-objects').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function importTraceObjects(file) {
    var reader = new FileReader()
    reader.onload = function() {
      var data
      try { data = JSON.parse(reader.result) } catch (e) { setAiMsg('NOT A VALID TRACE EXPORT FILE'); return }
      if (!data || !data.minimate_trace_export) { setAiMsg('NOT A MINIMATE TRACE EXPORT FILE'); return }
      var srcPins = data.pins || []
      var srcLoops = data.loops || []
      if (srcPins.length === 0) { setAiMsg('FILE HAS NO TRACED OBJECTS'); return }

      // Fit the imported cluster's bounding box into the current page, centered, preserving its
      // relative layout — re-uploading a fresh copy of the SAME floor (the intended use case)
      // means this lands very close to correct; a genuinely different drawing still gets a much
      // better starting point to drag-correct from than a random pile.
      var xs = srcPins.map(function(p) { return p.x }), ys = srcPins.map(function(p) { return p.y })
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs)
      var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys)
      var spanX = Math.max(maxX - minX, 0.001), spanY = Math.max(maxY - minY, 0.001)
      var targetPage = pageRef.current

      var idMap = {}
      var newPins = srcPins.map(function(p) {
        var newId = nid('pin')
        idMap[p.id] = newId
        return {
          id: newId, tag: p.tag || '', serial: p.serial || '', address: p.address || '',
          thermostat: p.thermostat || '', room: p.room || '',
          x: (p.x - minX) / spanX * 0.8 + 0.1,
          y: (p.y - minY) / spanY * 0.8 + 0.1,
          source: 'import', page: targetPage
        }
      })
      var existingNames = {}
      loopsRef.current.forEach(function(l) { existingNames[up(l.name)] = true })
      var newLoops = srcLoops.map(function(l, li) {
        var baseName = l.name || 'IMPORTED LOOP'
        var finalName = baseName, n = 1
        while (existingNames[up(finalName)]) { finalName = baseName + ' (' + (++n) + ')' }
        existingNames[up(finalName)] = true
        return {
          id: nid('loop'), name: finalName, color: l.color || LOOP_COLORS[(loopsRef.current.length + li) % LOOP_COLORS.length],
          page: targetPage, strokes: [],
          deviceIds: (l.deviceIds || []).map(function(oldId) { return idMap[oldId] }).filter(Boolean),
          remarks: []
        }
      })

      pushUndo()
      pinsRef.current = pinsRef.current.concat(newPins)
      setPins(pinsRef.current)
      loopsRef.current = loopsRef.current.concat(newLoops)
      setLoops(loopsRef.current)
      requestDraw()
      setAiMsg('IMPORTED ' + newPins.length + ' DEVICES ACROSS ' + newLoops.length + ' LOOPS — DRAG THEM INTO POSITION')
    }
    reader.onerror = function() { setAiMsg('FAILED TO READ FILE') }
    reader.readAsText(file)
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

    // Cached path: crop the tile straight out of stored tiles. This is the
    // whole point of the cache — on a heavy CAD export the vector re-render
    // below costs 10+ seconds EVERY zoom, and this costs a few milliseconds.
    var m = manifestRef.current[pageNo]
    if (m) {
      var k = m.width / img.width // base-raster px -> cached-raster px
      // Never stretch the cache more than this. Past 1:1 the cache has no more
      // detail to give, and blowing it up further just makes labels mushy —
      // clamping keeps strokes and text crisp and shrinks the tile we decode.
      var MAX_UPSCALE = 1.35
      if (density > k * MAX_UPSCALE) {
        density = k * MAX_UPSCALE
        tw = Math.round((x1 - x0) * density)
        th = Math.round((y1 - y0) * density)
      }
      ;(hashReadyRef.current || Promise.resolve(null)).then(function(hash) {
        if (!hash || token !== hiResTokenRef.current) return
        return drawRegion(hash, pageNo, m, x0 * k, y0 * k, x1 * k, y1 * k, tw, th)
          .then(function(c) {
            if (token !== hiResTokenRef.current) { c.width = 0; c.height = 0; return }
            if (hiResRef.current && hiResRef.current.canvas && hiResRef.current.canvas !== c) {
              hiResRef.current.canvas.width = 0; hiResRef.current.canvas.height = 0
            }
            hiResRef.current = { canvas: c, x: x0, y: y0, w: x1 - x0, h: y1 - y0, page: pageNo }
            requestDraw()
          })
      }).catch(function(err) { console.warn('[TRACE] Cached tile failed:', err && err.message) })
      return
    }

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

  // Ctrl+Z / Cmd+Z undoes the last loop/stroke edit (draw, delete-stroke, drag-resnap,
  // delete-loop) via undoTrace()'s snapshot stack. Skipped while focus is in a text field so it
  // doesn't hijack that field's own native undo (e.g. editing a pin's tag).
  useEffect(function() {
    function onKeyDown(e) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || (e.key !== 'z' && e.key !== 'Z')) return
      var t = e.target
      var tag = t && t.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return
      e.preventDefault()
      undoTrace()
    }
    window.addEventListener('keydown', onKeyDown)
    return function() { window.removeEventListener('keydown', onKeyDown) }
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

    // Live box-select rectangle (PIN mode, drag on empty space)
    var tsel = tempSelectRef.current
    if (tsel) {
      ctx.fillStyle = 'rgba(34,211,238,0.12)'
      ctx.fillRect(Math.min(tsel.x1, tsel.x2), Math.min(tsel.y1, tsel.y2), Math.abs(tsel.x2 - tsel.x1), Math.abs(tsel.y2 - tsel.y1))
      ctx.strokeStyle = '#22D3EE'
      ctx.lineWidth = 1.5 / v.scale
      ctx.setLineDash([6 / v.scale, 4 / v.scale])
      ctx.strokeRect(Math.min(tsel.x1, tsel.x2), Math.min(tsel.y1, tsel.y2), Math.abs(tsel.x2 - tsel.x1), Math.abs(tsel.y2 - tsel.y1))
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
      if (selectedRef.current[pin.id]) {
        ctx.beginPath()
        ctx.arc(px, py, r + 5 / v.scale, 0, Math.PI * 2)
        ctx.strokeStyle = '#22D3EE'
        ctx.lineWidth = 2.5 / v.scale
        ctx.setLineDash([3 / v.scale, 3 / v.scale])
        ctx.stroke()
        ctx.setLineDash([])
      }
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

  // Box-select (PIN mode, drag on empty space — same convention as selecting files in Explorer):
  // every pin on the current page whose center falls inside the dragged rectangle gets selected,
  // replacing any prior selection. Box coordinates are page-space, unordered corners.
  function selectPinsInBox(box) {
    var img = pageImgRef.current
    if (!img) return
    var page = pageRef.current
    var x1 = Math.min(box.x1, box.x2), x2 = Math.max(box.x1, box.x2)
    var y1 = Math.min(box.y1, box.y2), y2 = Math.max(box.y1, box.y2)
    var sel = {}
    pinsRef.current.forEach(function(pin) {
      if ((pin.page || 1) !== page) return
      var px = pin.x * img.width, py = pin.y * img.height
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) sel[pin.id] = true
    })
    selectedRef.current = sel
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

  // Magnetic snap while tracing: when a stroke point lands within range of an existing pin,
  // lock it to that pin's exact coordinates instead of the raw cursor position — the drawn
  // line visually attaches to the node rather than passing near it.
  //
  // Hysteresis via snapState (the active stroke gesture object, carried across the whole
  // drag): a flat entry/exit radius flickers right at the boundary — ordinary mouse jitter
  // crosses it several times a second, so the line would pop in and out of the pin. Once
  // locked onto a pin, releasing it requires moving noticeably farther away (1.6x the entry
  // radius) than it took to lock on, so a held cursor near a pin stays put — but it's still
  // freely resnappable to a DIFFERENT pin the instant that one becomes the nearest, since the
  // wider radius only ever applies to whichever pin is already locked, never to a candidate
  // it'd be switching to.
  function snapToPin(pagePt, snapState) {
    var img = pageImgRef.current
    if (!img) return pagePt
    var v = viewRef.current
    var page = pageRef.current
    var enterR = 16 / v.scale
    var best = null
    var bestD = Infinity
    pinsRef.current.forEach(function(pin) {
      if ((pin.page || 1) !== page) return
      var d = Math.hypot(pin.x * img.width - pagePt.x, pin.y * img.height - pagePt.y)
      if (d < bestD) { bestD = d; best = pin }
    })
    var stuck = snapState && best && best.id === snapState.snapPinId
    var r = stuck ? enterR * 1.6 : enterR
    if (best && bestD <= r) {
      if (snapState) snapState.snapPinId = best.id
      return { x: best.x * img.width, y: best.y * img.height }
    }
    if (snapState) snapState.snapPinId = null
    return pagePt
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
        // No confirm() here on purpose — a blocking native dialog breaks the flow of a
        // right-click-to-delete gesture on a canvas tool, and Ctrl+Z (undoTrace) is the
        // real safety net now instead of a modal on every single delete.
        deleteStroke(rStroke.loopId, rStroke.strokeIdx)
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
      if (hit && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+click toggles this pin in the selection without starting a drag — same
        // convention as multi-selecting files. Drag any selected pin afterward to move the group.
        var sel = Object.assign({}, selectedRef.current)
        if (sel[hit.id]) delete sel[hit.id]; else sel[hit.id] = true
        selectedRef.current = sel
        gestureRef.current = { type: 'togglepin', moved: false }
        requestDraw()
        return
      }
      if (hit) {
        if (selectedRef.current[hit.id] && Object.keys(selectedRef.current).length > 1) {
          // Dragging a pin that's part of an active multi-selection moves the whole group,
          // preserving each pin's offset from the drag start rather than snapping them together.
          var origins = {}
          Object.keys(selectedRef.current).forEach(function(pid) {
            var p = pinsRef.current.find(function(x) { return x.id === pid })
            if (p) origins[pid] = { x: p.x, y: p.y }
          })
          gestureRef.current = { type: 'groupdrag', anchor: pt, origins: origins, moved: false }
        } else {
          // Clicking a pin outside the current selection acts like Explorer: it replaces the
          // selection (here: clears it) and drags just that one pin, same as before multi-select existed.
          if (Object.keys(selectedRef.current).length) { selectedRef.current = {}; requestDraw() }
          gestureRef.current = { type: 'dragpin', pinId: hit.id, moved: false }
        }
      } else {
        // Empty space: could be a tap-to-add-pin, or the start of a box-select drag — resolved
        // by movement distance in onPointerMove/onPointerUp, same ambiguity addpin already had.
        gestureRef.current = { type: 'addpin', pt: pt, moved: false, startX: e.clientX, startY: e.clientY }
        tempSelectRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
      }
      return
    }

    if (m === 'trace') {
      ensureActiveLoop()
      var strokeGesture = { type: 'stroke', snapPinId: null }
      gestureRef.current = strokeGesture
      strokeRef.current = [snapToPin(pt, strokeGesture)]
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

    if (g.type === 'addpin') {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 8) g.moved = true
      if (g.moved && tempSelectRef.current) {
        var sp = toPage(e.clientX, e.clientY)
        tempSelectRef.current = { x1: g.pt.x, y1: g.pt.y, x2: sp.x, y2: sp.y }
        requestDraw()
      }
      return
    }

    if (g.type === 'picktap' || g.type === 'marktap') {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 8) g.moved = true
      return
    }

    if (g.type === 'groupdrag') {
      var gp = toPage(e.clientX, e.clientY)
      var img2 = pageImgRef.current
      if (!img2) return
      var dx = (gp.x - g.anchor.x) / img2.width
      var dy = (gp.y - g.anchor.y) / img2.height
      if (dx !== 0 || dy !== 0) g.moved = true
      pinsRef.current = pinsRef.current.map(function(p) {
        var o = g.origins[p.id]
        if (!o) return p
        return Object.assign({}, p, { x: o.x + dx, y: o.y + dy })
      })
      setPins(pinsRef.current)
      requestDraw()
      return
    }

    if (g.type === 'zone') {
      var zp = toPage(e.clientX, e.clientY)
      tempZoneRef.current = { x1: g.start.x, y1: g.start.y, x2: zp.x, y2: zp.y }
      requestDraw()
      return
    }

    if (g.type === 'stroke') {
      var pt2 = snapToPin(toPage(e.clientX, e.clientY), g)
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
    if (g.type === 'addpin' && !g.moved) {
      tempSelectRef.current = null
      // A plain tap on empty space clears an active selection instead of adding a pin — matches
      // "click empty space to deselect." Only adds a pin when there was nothing selected to clear.
      if (Object.keys(selectedRef.current).length) { selectedRef.current = {}; requestDraw() }
      else { addPinAt(g.pt) }
      return
    }
    if (g.type === 'addpin' && g.moved) {
      var box = tempSelectRef.current
      tempSelectRef.current = null
      if (box) selectPinsInBox(box)
      requestDraw()
      return
    }
    if (g.type === 'groupdrag') { if (g.moved) resequencePins(Object.keys(g.origins)); return }
    if (g.type === 'togglepin') { return }
    if (g.type === 'dragpin' && !g.moved) { setEditPinId(g.pinId); return }
    if (g.type === 'dragpin' && g.moved) { resequencePinInLoops(g.pinId); return }
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
  //
  // Two real bugs fixed here (both caused a stroke continuing forward from #20 to land as #6
  // instead of #21, because an unrelated earlier pin happened to sit close by on the drawing):
  //   1. nearest() searched every pin in the loop with no page filter — a pin on a different
  //      sheet with coincidentally-close normalized coordinates could "win" purely by chance,
  //      unlike commitStroke()'s own pin-capture loop, which does filter by page.
  //   2. nearest() had no distance cutoff, so it always returned SOME pin even when nothing was
  //      genuinely close to the stroke, and Math.min(a.idx, b.idx) then unconditionally
  //      preferred whichever end matched the EARLIER pin — even a spurious, unrelated match.
  //      Now the far end only overrides the append-forward default when it's both within range
  //      AND immediately adjacent to the near end (the actual "fill a gap" case); a lone/no
  //      match at the far end just appends after the near end, as tracing forward expects.
  function findInsertIndex(loop, rawStroke, img) {
    var page = pageRef.current
    var existing = []
    loop.deviceIds.forEach(function(pid, idx) {
      var p = pinsRef.current.find(function(x) { return x.id === pid && (x.page || 1) === page })
      if (p) existing.push({ idx: idx, pin: p })
    })
    if (existing.length === 0) return loop.deviceIds.length
    var anchorR = 20 / viewRef.current.scale
    if (anchorR < 14) anchorR = 14
    anchorR *= 3
    function nearest(pt) {
      var best = null
      var bestD = Infinity
      existing.forEach(function(e) {
        var d = Math.hypot(e.pin.x * img.width - pt.x, e.pin.y * img.height - pt.y)
        if (d < bestD) { bestD = d; best = e }
      })
      return (best && bestD <= anchorR) ? best : null
    }
    var a = nearest(rawStroke[0])
    var b = nearest(rawStroke[rawStroke.length - 1])
    if (a && b && Math.abs(a.idx - b.idx) === 1) return Math.min(a.idx, b.idx) + 1
    if (a) return a.idx + 1
    if (b) return b.idx
    return loop.deviceIds.length
  }

  // Dragging an already-captured pin to a new spot should move it in the sequence too — a
  // freely-resnappable device, not one stuck at whatever index it got when first captured.
  // For every loop the pin belongs to, finds the nearest point on the polyline formed by the
  // OTHER devices already in that loop's sequence (an interior segment via perpDist, or one of
  // the two open ends by straight-line distance) and reinserts the pin at that position.
  // Pure core, shared by both entry points below: given a loops array, moves pinId to its best
  // position in every loop it belongs to and returns the (possibly) updated array. No side
  // effects (no undo push, no setLoops) — callers own the undo boundary, which is what makes a
  // multi-pin group move collapse into ONE undo step instead of one per pin.
  function computeResequenced(loopsIn, pinId, img) {
    var pin = pinsRef.current.find(function(p) { return p.id === pinId })
    if (!pin) return loopsIn
    var pt = { x: pin.x * img.width, y: pin.y * img.height }
    return loopsIn.map(function(loop) {
      if (loop.deviceIds.indexOf(pinId) === -1) return loop
      var remaining = loop.deviceIds.filter(function(id) { return id !== pinId })
      var others = []
      remaining.forEach(function(id, idx) {
        var p = pinsRef.current.find(function(x) { return x.id === id })
        if (p) others.push({ pos: idx, x: p.x * img.width, y: p.y * img.height })
      })
      if (others.length === 0) return loop
      var last = others[others.length - 1]
      var bestPos = last.pos + 1
      var bestD = Math.hypot(pt.x - last.x, pt.y - last.y)
      var d0 = Math.hypot(pt.x - others[0].x, pt.y - others[0].y)
      if (d0 < bestD) { bestD = d0; bestPos = others[0].pos }
      for (var i = 0; i < others.length - 1; i++) {
        var d = perpDist(pt, others[i], others[i + 1])
        if (d < bestD) { bestD = d; bestPos = others[i + 1].pos }
      }
      var newIds = remaining.slice(0, bestPos).concat([pinId]).concat(remaining.slice(bestPos))
      return Object.assign({}, loop, { deviceIds: newIds })
    })
  }

  // Single-pin entry point — dragging one pin (no active multi-selection).
  function resequencePinInLoops(pinId) {
    var img = pageImgRef.current
    if (!img) return
    pushUndo()
    loopsRef.current = computeResequenced(loopsRef.current, pinId, img)
    setLoops(loopsRef.current)
  }

  // Multi-pin entry point — a box-select/Ctrl+click group drag. One pushUndo() for the whole
  // batch, so Ctrl+Z undoes the entire group move in a single step, not pin-by-pin.
  function resequencePins(pinIds) {
    var img = pageImgRef.current
    if (!img || !pinIds.length) return
    pushUndo()
    var next = loopsRef.current
    pinIds.forEach(function(pinId) { next = computeResequenced(next, pinId, img) })
    loopsRef.current = next
    setLoops(next)
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
    pushUndo()
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

  // Snapshot loopsRef.current before a mutation so Ctrl+Z (undoTrace) can restore it. Called
  // at the START of each mutating function, before that function reassigns loopsRef.current —
  // a plain reference push is enough since nothing here ever mutates the array/objects in
  // place, only replaces them via .map()/.filter().
  function pushUndo() {
    undoStackRef.current.push(loopsRef.current)
    if (undoStackRef.current.length > 50) undoStackRef.current.shift()
  }

  function undoTrace() {
    var prev = undoStackRef.current.pop()
    if (!prev) return
    loopsRef.current = prev
    setLoops(prev)
    requestDraw()
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
    pushUndo()
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
    pushUndo()
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
        <input ref={importInputRef} type="file" accept="application/json" className="hidden"
          onChange={function(e) { var f = e.target.files && e.target.files[0]; if (f) importTraceObjects(f); e.target.value = '' }} />
        <button onClick={function() { importInputRef.current && importInputRef.current.click() }} title="RE-IMPORT TRACED OBJECTS EXPORTED FROM ANOTHER DRAWING (E.G. A FRESHER COPY OF THE SAME FLOOR) — YOU DRAG THEM INTO POSITION AFTER"
          className="px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition bg-card2 text-dgray hover:text-white">
          ⬆ IMPORT
        </button>
        <button onClick={exportTraceObjects} disabled={tracedCount === 0} title="SAVE TRACED OBJECTS (TAGS, ADDRESSES, LOOP MEMBERSHIP) TO RE-UPLOAD ONTO ANOTHER DRAWING"
          className="px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition bg-card2 text-dgray hover:text-white disabled:opacity-40 disabled:cursor-not-allowed">
          ⬇ OBJECTS
        </button>
        <button onClick={exportPdf} disabled={exporting || tracedCount === 0} title="CLEAN PDF OF EVERY PAGE WITH TRACED LOOPS"
          className="px-3 py-1.5 rounded-md text-[10px] font-bold uppercase transition bg-card2 text-dgray hover:text-white disabled:opacity-40 disabled:cursor-not-allowed">
          {exporting ? 'EXPORTING…' : '⬇ PDF'}
        </button>
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
          {/* Non-blocking: tracing stays fully usable on the base raster while
              the one-time cache builds in the background. */}
          {!loading && cacheMsg && (
            <div className="absolute top-3 right-3 bg-card/95 border border-teal/40 rounded-lg px-3 py-1.5 text-[9px] text-teal uppercase pointer-events-none">
              {cacheMsg}
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
                  <button onClick={function(e) { e.stopPropagation(); setColorPickerLoopId(colorPickerLoopId === loop.id ? null : loop.id) }}
                    title="CHANGE COLOR"
                    className="w-3 h-3 rounded-full shrink-0 ring-1 ring-white/30 hover:ring-white transition" style={{ background: loop.color }}></button>
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
                {colorPickerLoopId === loop.id && (
                  <div className="flex flex-wrap gap-1 mb-2" onClick={function(e) { e.stopPropagation() }}>
                    {LOOP_COLORS.map(function(c) {
                      return <button key={c} onClick={function() {
                          loopsRef.current = loopsRef.current.map(function(l) { return l.id === loop.id ? Object.assign({}, l, { color: c }) : l })
                          setLoops(loopsRef.current)
                          setColorPickerLoopId(null)
                        }}
                        className={'w-4 h-4 rounded-full transition ' + (loop.color === c ? 'ring-2 ring-white scale-110' : 'opacity-60 hover:opacity-100')}
                        style={{ background: c }}></button>
                    })}
                  </div>
                )}
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
