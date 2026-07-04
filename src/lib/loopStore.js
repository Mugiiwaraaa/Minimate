/* --- loopStore.js --- M6 per-row persistence for loops + devices ---
   The diff layer: UI keeps calling onUpdateLoops(fullArray) exactly as
   before; this module diffs prev vs next and emits SINGLE-ROW operations.
   A checkbox tick = one row upsert. Two users on different devices can
   never conflict.

   P1 (current): DUAL-WRITE. Blob stays canonical; rows are written in
   parallel and backfilled once per project. P2 switches reads to rows. */

import { supabase, isDemo } from './supabase'

/* ================================================================
   ROW SHAPES
   ================================================================ */

function loopToRow(projectId, loop, position) {
  return {
    project_id: projectId,
    id: loop.id,
    name: loop.name || '',
    protocol: loop.protocol || 'MODBUS RTU',
    gateway: loop.gateway || '',
    ddc_ref: loop.ddc_ref || '',
    floor: loop.floor || '',
    zone: loop.zone || '',
    color: loop.color || '',
    source: loop.source || '',
    drawing_id: loop.drawingId || '',
    cable_remarks: loop.cable_remarks || [],
    position: position,
    updated_at: new Date().toISOString()
  }
}

function deviceToRow(projectId, loopId, dev, position) {
  return {
    project_id: projectId,
    id: dev.id,
    loop_id: loopId,
    device_type: dev.device_type || 'DEVICE',
    tag: dev.tag || '',
    room_name: dev.room_name || '',
    address: dev.address || '',
    serial: dev.serial || '',
    thermostat: dev.thermostat || '',
    floor: dev.floor || '',
    drawing_id: dev.drawingId || '',
    comm_cable: !!dev.comm_cable,
    control_cable: !!dev.control_cable,
    continuity: !!dev.continuity,
    termination: !!dev.termination,
    device_installed: !!dev.device_installed,
    address_set: !!dev.address_set,
    remarks: dev.remarks || '',
    position: position,
    updated_at: new Date().toISOString()
  }
}

export function loopRowToLoop(r) {
  return {
    id: r.id,
    name: r.name,
    protocol: r.protocol,
    gateway: r.gateway,
    ddc_ref: r.ddc_ref,
    floor: r.floor,
    zone: r.zone,
    color: r.color,
    source: r.source,
    drawingId: r.drawing_id,
    cable_remarks: r.cable_remarks || []
  }
}

export function deviceRowToDevice(r) { return rowToDevice(r) }

function rowToDevice(r) {
  return {
    id: r.id,
    device_type: r.device_type,
    tag: r.tag,
    room_name: r.room_name,
    address: r.address,
    serial: r.serial,
    thermostat: r.thermostat,
    floor: r.floor,
    drawingId: r.drawing_id,
    comm_cable: !!r.comm_cable,
    control_cable: !!r.control_cable,
    continuity: !!r.continuity,
    termination: !!r.termination,
    device_installed: !!r.device_installed,
    address_set: !!r.address_set,
    remarks: r.remarks || ''
  }
}

export function rowsToLoops(loopRows, deviceRows) {
  var devsByLoop = {}
  ;(deviceRows || []).slice().sort(function(a, b) { return (a.position || 0) - (b.position || 0) })
    .forEach(function(r) {
      if (!devsByLoop[r.loop_id]) devsByLoop[r.loop_id] = []
      devsByLoop[r.loop_id].push(rowToDevice(r))
    })
  return (loopRows || []).slice().sort(function(a, b) { return (a.position || 0) - (b.position || 0) })
    .map(function(r) {
      return {
        id: r.id,
        name: r.name,
        protocol: r.protocol,
        gateway: r.gateway,
        ddc_ref: r.ddc_ref,
        floor: r.floor,
        zone: r.zone,
        color: r.color,
        source: r.source,
        drawingId: r.drawing_id,
        cable_remarks: r.cable_remarks || [],
        devices: devsByLoop[r.id] || []
      }
    })
}

/* ================================================================
   DIFF — prev loops vs next loops -> row operations
   ================================================================ */

function loopFieldsKey(projectId, loop, pos) {
  var r = loopToRow(projectId, loop, pos)
  delete r.updated_at
  return JSON.stringify(r)
}

function deviceFieldsKey(projectId, loopId, dev, pos) {
  var r = deviceToRow(projectId, loopId, dev, pos)
  delete r.updated_at
  return JSON.stringify(r)
}

export function diffLoops(projectId, prevLoops, nextLoops) {
  var ops = { loopUpserts: [], loopDeletes: [], devUpserts: [], devDeletes: [] }
  var prevById = {}
  ;(prevLoops || []).forEach(function(l, i) { prevById[l.id] = { loop: l, pos: i } })
  var seenLoops = {}

  ;(nextLoops || []).forEach(function(l, li) {
    seenLoops[l.id] = true
    var prev = prevById[l.id]

    if (!prev) {
      // New loop: insert it + every device
      ops.loopUpserts.push(loopToRow(projectId, l, li))
      l.devices.forEach(function(d, di) {
        ops.devUpserts.push(deviceToRow(projectId, l.id, d, di))
      })
      return
    }

    // Existing loop: fields changed?
    if (loopFieldsKey(projectId, prev.loop, prev.pos) !== loopFieldsKey(projectId, l, li)) {
      ops.loopUpserts.push(loopToRow(projectId, l, li))
    }

    // Devices, by id
    var prevDevs = {}
    prev.loop.devices.forEach(function(d, di) { prevDevs[d.id] = { dev: d, pos: di } })
    var seenDevs = {}
    l.devices.forEach(function(d, di) {
      seenDevs[d.id] = true
      var pd = prevDevs[d.id]
      if (!pd || deviceFieldsKey(projectId, l.id, pd.dev, pd.pos) !== deviceFieldsKey(projectId, l.id, d, di)) {
        ops.devUpserts.push(deviceToRow(projectId, l.id, d, di))
      }
    })
    prev.loop.devices.forEach(function(d) {
      if (!seenDevs[d.id]) ops.devDeletes.push(d.id)
    })
  })

  ;(prevLoops || []).forEach(function(l) {
    if (!seenLoops[l.id]) ops.loopDeletes.push(l.id)
  })

  return ops
}

/* ================================================================
   OP QUEUE — debounced, serialized, retried
   ================================================================ */

var queue = { projectId: null, loopUpserts: {}, loopDeletes: {}, devUpserts: {}, devDeletes: {} }
var opTimer = null
var opInFlight = false
var opAttempts = 0

function queueSize() {
  return Object.keys(queue.loopUpserts).length + Object.keys(queue.loopDeletes).length +
         Object.keys(queue.devUpserts).length + Object.keys(queue.devDeletes).length
}

export function syncLoops(projectId, prevLoops, nextLoops) {
  if (isDemo || !supabase || !projectId) return
  if (queue.projectId && queue.projectId !== projectId) {
    // Project switched with ops pending — flush them for the OLD project first
    drainNow()
  }
  queue.projectId = projectId
  var ops = diffLoops(projectId, prevLoops, nextLoops)

  ops.loopUpserts.forEach(function(r) { delete queue.loopDeletes[r.id]; queue.loopUpserts[r.id] = r })
  ops.devUpserts.forEach(function(r) { delete queue.devDeletes[r.id]; queue.devUpserts[r.id] = r })
  ops.devDeletes.forEach(function(id) { delete queue.devUpserts[id]; queue.devDeletes[id] = true })
  ops.loopDeletes.forEach(function(id) { delete queue.loopUpserts[id]; queue.loopDeletes[id] = true })

  if (queueSize() === 0) return
  if (opTimer) clearTimeout(opTimer)
  opTimer = setTimeout(drainNow, 300)
}

export function flushLoopOps() {
  if (opTimer) { clearTimeout(opTimer); opTimer = null }
  drainNow()
}

function drainNow() {
  if (opTimer) { clearTimeout(opTimer); opTimer = null }
  if (opInFlight) { opTimer = setTimeout(drainNow, 400); return }
  if (queueSize() === 0 || !queue.projectId) return

  var pid = queue.projectId
  var batch = {
    loopUpserts: Object.keys(queue.loopUpserts).map(function(k) { return queue.loopUpserts[k] }),
    loopDeletes: Object.keys(queue.loopDeletes),
    devUpserts: Object.keys(queue.devUpserts).map(function(k) { return queue.devUpserts[k] }),
    devDeletes: Object.keys(queue.devDeletes)
  }
  queue = { projectId: pid, loopUpserts: {}, loopDeletes: {}, devUpserts: {}, devDeletes: {} }
  opInFlight = true

  runBatch(pid, batch)
    .then(function() {
      opInFlight = false
      opAttempts = 0
      if (queueSize() > 0) drainNow()
    })
    .catch(function(err) {
      opInFlight = false
      opAttempts++
      console.warn('[M6] Row sync failed (attempt ' + opAttempts + '/3):', err && err.message)
      if (opAttempts < 3) {
        // Put the batch back (fresh edits win over requeued ones)
        batch.loopUpserts.forEach(function(r) { if (!queue.loopUpserts[r.id] && !queue.loopDeletes[r.id]) queue.loopUpserts[r.id] = r })
        batch.devUpserts.forEach(function(r) { if (!queue.devUpserts[r.id] && !queue.devDeletes[r.id]) queue.devUpserts[r.id] = r })
        batch.devDeletes.forEach(function(id) { if (!queue.devUpserts[id]) queue.devDeletes[id] = true })
        batch.loopDeletes.forEach(function(id) { if (!queue.loopUpserts[id]) queue.loopDeletes[id] = true })
        opTimer = setTimeout(drainNow, 1500 * opAttempts)
      } else {
        opAttempts = 0
        console.error('[M6] Row sync dropped a batch — blob remains canonical in P1, no data lost')
      }
    })
}

function runBatch(pid, b) {
  // Remember our writes so their realtime echoes are recognized
  noteWrites('loops', b.loopUpserts)
  noteWrites('loop_devices', b.devUpserts)
  // Order matters: loop rows before their device rows; deletes last
  var p = Promise.resolve()
  if (b.loopUpserts.length > 0) {
    p = p.then(function() {
      return supabase.from('loops').upsert(b.loopUpserts, { onConflict: 'project_id,id' }).then(throwIfError)
    })
  }
  if (b.devUpserts.length > 0) {
    p = p.then(function() {
      return supabase.from('loop_devices').upsert(b.devUpserts, { onConflict: 'project_id,id' }).then(throwIfError)
    })
  }
  if (b.devDeletes.length > 0) {
    p = p.then(function() {
      return supabase.from('loop_devices').delete().eq('project_id', pid).in('id', b.devDeletes).then(throwIfError)
    })
  }
  if (b.loopDeletes.length > 0) {
    p = p.then(function() {
      return supabase.from('loop_devices').delete().eq('project_id', pid).in('loop_id', b.loopDeletes).then(throwIfError)
    }).then(function() {
      return supabase.from('loops').delete().eq('project_id', pid).in('id', b.loopDeletes).then(throwIfError)
    })
  }
  return p
}

function throwIfError(res) {
  if (res && res.error) throw new Error(res.error.message)
  return res
}

/* ================================================================
   LOAD + BACKFILL
   ================================================================ */

export function loadLoops(projectId, cb) {
  if (isDemo || !supabase) { cb(null, { loops: [], hasRows: false }); return }
  supabase.from('loops').select('*').eq('project_id', projectId).then(function(lres) {
    if (lres.error) { cb(lres.error, null); return }
    if (!lres.data || lres.data.length === 0) { cb(null, { loops: [], hasRows: false }); return }
    supabase.from('loop_devices').select('*').eq('project_id', projectId).then(function(dres) {
      if (dres.error) { cb(dres.error, null); return }
      cb(null, { loops: rowsToLoops(lres.data, dres.data), hasRows: true })
    })
  })
}

/* ================================================================
   OWN-ECHO DETECTION — realtime replays our own writes back to us.
   We remember what we recently wrote; identical incoming rows are
   echoes and must be ignored (or they overwrite text mid-typing).
   ================================================================ */

var recentWrites = {} // 'table:id' -> { key, ts }

function stableRowKey(row) {
  var c = Object.assign({}, row)
  delete c.updated_at
  return JSON.stringify(c)
}

function noteWrites(table, rows) {
  var now = Date.now()
  rows.forEach(function(r) {
    recentWrites[table + ':' + r.id] = { key: stableRowKey(r), ts: now }
  })
  // Opportunistic cleanup
  Object.keys(recentWrites).forEach(function(k) {
    if (now - recentWrites[k].ts > 30000) delete recentWrites[k]
  })
}

export function isOwnEcho(table, row) {
  if (!row || !row.id) return false
  var e = recentWrites[table + ':' + row.id]
  if (!e || Date.now() - e.ts > 30000) return false
  return e.key === stableRowKey(row)
}

/* ================================================================
   P3 REALTIME — per-row events, filtered by project
   ================================================================ */

var rowChannel = null

export function subscribeLoops(projectId, onRow) {
  if (isDemo || !supabase) return
  unsubscribeLoops()
  rowChannel = supabase
    .channel('rows-' + projectId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loops', filter: 'project_id=eq.' + projectId }, function(payload) {
      onRow('loops', payload)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loop_devices', filter: 'project_id=eq.' + projectId }, function(payload) {
      onRow('loop_devices', payload)
    })
    .subscribe()
}

export function unsubscribeLoops() {
  if (rowChannel && supabase) {
    supabase.removeChannel(rowChannel)
    rowChannel = null
  }
}

/* One-time per project: copy blob loops into rows. Blob stays canonical. */
export function ensureBackfill(projectId, blobLoops) {
  if (isDemo || !supabase || !projectId) return
  if (!blobLoops || blobLoops.length === 0) return
  supabase.from('loops').select('id', { count: 'exact', head: true }).eq('project_id', projectId).then(function(res) {
    if (res.error) {
      console.warn('[M6] loops table missing? Run the M6 P0 migration.', res.error.message)
      return
    }
    if (res.count && res.count > 0) return // already backfilled
    console.log('[M6] Backfilling ' + blobLoops.length + ' loops into rows...')
    var loopRows = blobLoops.map(function(l, i) { return loopToRow(projectId, l, i) })
    var devRows = []
    blobLoops.forEach(function(l) {
      l.devices.forEach(function(d, di) { devRows.push(deviceToRow(projectId, l.id, d, di)) })
    })
    supabase.from('loops').upsert(loopRows, { onConflict: 'project_id,id' }).then(function(r1) {
      if (r1.error) { console.error('[M6] Backfill loops failed:', r1.error.message); return }
      // Chunk device inserts (payload safety)
      var chunks = []
      for (var i = 0; i < devRows.length; i += 400) chunks.push(devRows.slice(i, i + 400))
      var p = Promise.resolve()
      chunks.forEach(function(chunk) {
        p = p.then(function() {
          return supabase.from('loop_devices').upsert(chunk, { onConflict: 'project_id,id' }).then(throwIfError)
        })
      })
      p.then(function() {
        console.log('[M6] Backfill complete: ' + loopRows.length + ' loops, ' + devRows.length + ' devices')
      }).catch(function(e) {
        console.error('[M6] Backfill devices failed:', e.message)
      })
    })
  })
}
