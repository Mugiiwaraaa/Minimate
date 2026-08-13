/* --- rasterCache.js --- One-time page raster cache for heavy CAD drawings ---

   WHY THIS EXISTS
   ---------------
   The DWG->PDF exports used on these projects write every entity as its own
   moveto/lineto/stroke. A single A1 BMS floor plan carries ~3.3 MILLION stroke
   operations. Measured with MuPDF on the real BN01 Ground Floor drawing:

       render @ 72 dpi : 11.3 s
       render @150 dpi : 11.8 s
       render @300 dpi : 13.0 s

   The cost is GEOMETRY-bound, not resolution-bound — dropping resolution buys
   almost nothing, because the renderer still walks every stroke. That is why
   TraceStudio's existing maxDim/scaleCap caps do not help on these files, and
   why renderHiResTile()'s per-zoom page.render() is so painful: every pinch
   pays the full multi-second cost again.

   THE FIX
   -------
   Rasterize each page ONCE, slice it into tiles, and keep the tiles in
   IndexedDB keyed by the file's content hash. After that first pass every
   view — base render and sharp zoom tiles alike — is an image blit.

   WHY TILES AND NOT ONE BIG BITMAP
   --------------------------------
   Browsers cap canvas area, and iOS Safari caps it hard (~16.7 MP, vs ~268 MP
   on desktop Chrome). A 400 dpi A1 page is 9934x7016 = 70 MP, which is fine on
   desktop and impossible on an iPhone. Tiles also mean we decode only the few
   tiles actually on screen instead of holding a 280 MB RGBA bitmap resident.

   So: capable devices build the cache; every device consumes it. */

var DB_NAME = 'minimate-rasters'
var STORE = 'tiles'
var DB_VERSION = 1

var TILE = 1024                  // tile edge in raster px
var PDF_DPI = 72                 // PDF user-space units per inch

/* Density to rasterize at.

   Measured on the real BN01 Ground Floor sheet. The cost floor is the operator
   walk — pdf.js re-walks all 3.3M strokes for EVERY render pass — so density
   costs render passes, and passes cost ~30s each:

       360 dpi -> 1 pass,  ~27 s,  4.4 MB of tiles
       700 dpi -> 4 passes, >5 min (95 MP canvas per band, memory-thrashing)

   400 dpi is the knee: one pass, and at that density a 2 mm-cap-height CAD
   label is ~31 px tall and a 0.25 mm line is ~4 px wide — already fully
   resolved, so zooming past it enlarges cleanly rather than revealing more.
   Text stays crisp; see MAX_UPSCALE in TraceStudio for the guard that stops
   the tile path from stretching this into mush. */
var TARGET_DPI = 400
var TARGET_DPI_MOBILE = 300

/* Conservative per-device ceiling on a single canvas. iOS throws or silently
   returns a blank canvas past its limit rather than reporting anything. */
function maxCanvasPixels() {
  var ua = navigator.userAgent || ''
  var iOS = /iPad|iPhone|iPod/.test(ua) || (ua.indexOf('Macintosh') > -1 && navigator.maxTouchPoints > 1)
  if (iOS) return 16 * 1024 * 1024
  if (/Android/.test(ua)) return 32 * 1024 * 1024
  // Chrome's hard ceiling is 2^28 px of area, but cost is badly non-linear
  // near it. Measured on the BN01 Ground Floor sheet: a 100 MP canvas renders
  // in 27 s, a 124 MP one takes over 70 s. 96 MP sits below that knee.
  return 96 * 1024 * 1024
}

function openDb() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = function() {
      var db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = function() { resolve(req.result) }
    req.onerror = function() { reject(req.error || new Error('raster cache open failed')) }
  })
}

function idbGet(key) {
  return openDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE, 'readonly')
      var r = tx.objectStore(STORE).get(key)
      r.onsuccess = function() { resolve(r.result || null) }
      r.onerror = function() { resolve(null) }
    })
  }).catch(function() { return null })
}

function idbPut(rec) {
  return openDb().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(rec)
      tx.oncomplete = function() { resolve(true) }
      tx.onerror = function() { reject(tx.error || new Error('raster cache write failed')) }
    })
  })
}

function manifestKey(hash, page) { return hash + ':' + page + ':manifest' }
function tileKey(hash, page, col, row) { return hash + ':' + page + ':' + col + ',' + row }

/* WebP holds CAD line art far better than JPEG at the same size — JPEG rings
   badly around thin high-contrast strokes, which is all these drawings are. */
var _fmt = null
function pickFormat() {
  if (_fmt) return _fmt
  var c = document.createElement('canvas')
  c.width = 1; c.height = 1
  _fmt = c.toDataURL('image/webp').indexOf('image/webp') === 5
    ? { mime: 'image/webp', q: 0.92 }
    : { mime: 'image/jpeg', q: 0.94 }
  return _fmt
}

function canvasToBlob(canvas) {
  var f = pickFormat()
  return new Promise(function(resolve, reject) {
    canvas.toBlob(function(b) {
      if (b) resolve(b); else reject(new Error('toBlob failed'))
    }, f.mime, f.q)
  })
}

function release(canvas) {
  if (canvas) { canvas.width = 0; canvas.height = 0 }
}

/* ── Build ──────────────────────────────────────────────────────────────
   Rasterize one page at the highest density this device can hold, slice it
   into tiles, and persist them. Runs once per (file, page).
   onProgress(fraction 0..1, label) is optional. */
function buildPageCache(pdf, hash, pageNo, onProgress) {
  var progress = onProgress || function() {}
  return pdf.getPage(pageNo).then(function(page) {
    var vp1 = page.getViewport({ scale: 1 })
    var mobile = /iPad|iPhone|iPod|Android/.test(navigator.userAgent || '')
    var scale = (mobile ? TARGET_DPI_MOBILE : TARGET_DPI) / PDF_DPI
    // Aim for TARGET_DPI, but never at the price of a second render pass: a
    // pass costs another full operator walk (~27 s here), while trimming the
    // density costs almost nothing visually. A big A1 sheet lands ~360 dpi;
    // smaller detail sheets get the full 400.
    var fit = Math.sqrt(maxCanvasPixels() / (vp1.width * vp1.height))
    if (scale > fit) scale = fit
    var W = Math.round(vp1.width * scale)
    var H = Math.round(vp1.height * scale)

    var cols = Math.ceil(W / TILE)
    var rows = Math.ceil(H / TILE)
    var totalTiles = cols * rows
    var started = Date.now()

    // One render pass into one canvas, then slice. Deliberately plain: an
    // earlier banded version (to lift the density past the canvas limit) took
    // 102 s on this sheet against 27 s for this, because pdf.js leaves its
    // fast path once page.render() is given a `transform`, and because every
    // extra band repeats the whole 3.3M-operator walk. Density is capped to
    // one canvas above for the same reason.
    var master = document.createElement('canvas')
    master.width = W
    master.height = H
    var mctx = master.getContext('2d')
    mctx.fillStyle = '#ffffff'
    mctx.fillRect(0, 0, W, H)
    progress(0.02, 'RASTERIZING DRAWING (ONE TIME)')

    return page.render({
      canvasContext: mctx,
      viewport: page.getViewport({ scale: scale })
    }).promise.then(function() {
      var cut = document.createElement('canvas')
      var cctx = cut.getContext('2d')
      var n = 0
      // Sequential: never hold more than the master plus one tile canvas.
      var chain = Promise.resolve()
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          (function(col, row) {
            chain = chain.then(function() {
              var w = Math.min(TILE, W - col * TILE)
              var h = Math.min(TILE, H - row * TILE)
              cut.width = w
              cut.height = h
              cctx.drawImage(master, col * TILE, row * TILE, w, h, 0, 0, w, h)
              return canvasToBlob(cut).then(function(blob) {
                n++
                progress(0.02 + 0.96 * (n / totalTiles), 'CACHING ' + n + '/' + totalTiles)
                return idbPut({ key: tileKey(hash, pageNo, col, row), blob: blob })
              })
            })
          })(c, r)
        }
      }
      return chain.then(function() {
        release(cut)
        release(master)
        var manifest = {
          key: manifestKey(hash, pageNo),
          width: W, height: H, tile: TILE,
          cols: cols, rows: rows, scale: scale,
          pageWidth: vp1.width, pageHeight: vp1.height,
          dpi: Math.round(scale * PDF_DPI),
          buildMs: Date.now() - started,
          builtAt: new Date().toISOString()
        }
        return idbPut(manifest).then(function() {
          progress(1, 'READY')
          return manifest
        })
      }).catch(function(err) {
        release(cut)
        release(master)
        throw err
      })
    })
  })
}

function getManifest(hash, pageNo) {
  return idbGet(manifestKey(hash, pageNo)).then(function(m) {
    return m && m.width ? m : null
  })
}

/* ── Consume ────────────────────────────────────────────────────────────
   Draw the cached region [x0,y0,x1,y1] (in manifest raster px) into a canvas
   of the given output size. Only the tiles that intersect are decoded. */
function drawRegion(hash, pageNo, manifest, x0, y0, x1, y1, outW, outH) {
  var c0 = Math.max(0, Math.floor(x0 / manifest.tile))
  var c1 = Math.min(manifest.cols - 1, Math.floor((x1 - 1) / manifest.tile))
  var r0 = Math.max(0, Math.floor(y0 / manifest.tile))
  var r1 = Math.min(manifest.rows - 1, Math.floor((y1 - 1) / manifest.tile))

  var out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(outW))
  out.height = Math.max(1, Math.round(outH))
  var ctx = out.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)

  var sx = out.width / (x1 - x0)
  var sy = out.height / (y1 - y0)

  var wanted = []
  for (var r = r0; r <= r1; r++) {
    for (var c = c0; c <= c1; c++) wanted.push([c, r])
  }

  return Promise.all(wanted.map(function(cr) {
    return idbGet(tileKey(hash, pageNo, cr[0], cr[1])).then(function(rec) {
      if (!rec || !rec.blob) return null
      return createImageBitmap(rec.blob).then(function(bmp) {
        return { col: cr[0], row: cr[1], bmp: bmp }
      }).catch(function() { return null })
    })
  })).then(function(tiles) {
    tiles.forEach(function(t) {
      if (!t) return
      var tx = t.col * manifest.tile
      var ty = t.row * manifest.tile
      ctx.drawImage(t.bmp, (tx - x0) * sx, (ty - y0) * sy, t.bmp.width * sx, t.bmp.height * sy)
      if (t.bmp.close) t.bmp.close()
    })
    return out
  })
}

/* Whole page downscaled to fit maxDim — the base view. */
function drawFullPage(hash, pageNo, manifest, maxDim) {
  var s = Math.min(maxDim / manifest.width, maxDim / manifest.height, 1)
  return drawRegion(hash, pageNo, manifest, 0, 0, manifest.width, manifest.height,
                    manifest.width * s, manifest.height * s)
}

function clearFile(hash) {
  return openDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE, 'readwrite')
      var store = tx.objectStore(STORE)
      var req = store.openCursor()
      req.onsuccess = function() {
        var cur = req.result
        if (!cur) return
        if (String(cur.key).indexOf(hash + ':') === 0) cur.delete()
        cur.continue()
      }
      tx.oncomplete = function() { resolve(true) }
      tx.onerror = function() { resolve(false) }
    })
  }).catch(function() { return false })
}

export {
  buildPageCache, getManifest, drawRegion, drawFullPage, clearFile,
  maxCanvasPixels, TARGET_DPI
}
