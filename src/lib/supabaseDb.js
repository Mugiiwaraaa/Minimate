import { supabase, isDemo } from './supabase'

// ─── Project CRUD ──────────────────────────────────────────

export function listProjects(cb) {
  if (isDemo || !supabase) {
    cb(null, [])
    return
  }
  supabase
    .from('projects')
    .select('id, name, client, location, status, created_at, updated_at, data')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .then(function(res) {
      if (res.error) { cb(res.error, null); return }
      // Add summary stats from data for project cards
      var projects = (res.data || []).map(function(p) {
        var d = p.data || {}
        return Object.assign({}, p, {
          panelCount: (d.panels || []).length,
          pointCount: countPoints(d),
          loopCount: (d.loops || []).length
        })
      })
      cb(null, projects)
    })
}

export function loadProject(projectId, cb) {
  if (isDemo || !supabase) {
    cb(null, null)
    return
  }
  supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()
    .then(function(res) {
      if (res.error) { cb(res.error, null); return }
      cb(null, res.data)
    })
}

export function createProject(name, client, location, cb) {
  if (isDemo || !supabase) {
    cb(new Error('No Supabase connection'), null)
    return
  }
  var row = {
    name: (name || 'NEW PROJECT').toUpperCase(),
    client: (client || '').toUpperCase(),
    location: (location || '').toUpperCase(),
    status: 'active',
    data: { panels: [], equipmentMap: {}, terminationMap: {}, loops: [], areaGroups: [] }
  }
  supabase
    .from('projects')
    .insert(row)
    .select()
    .single()
    .then(function(res) {
      if (res.error) { cb(res.error, null); return }
      cb(null, res.data)
    })
}

export function deleteProject(projectId, cb) {
  if (isDemo || !supabase) {
    cb(new Error('No Supabase connection'))
    return
  }
  // Soft delete — set status to on_hold
  supabase
    .from('projects')
    .update({ status: 'on_hold' })
    .eq('id', projectId)
    .then(function(res) {
      cb(res.error || null)
    })
}

export function saveProjectMeta(projectId, fields, cb) {
  if (isDemo || !supabase) return
  supabase
    .from('projects')
    .update(fields)
    .eq('id', projectId)
    .then(function(res) {
      if (cb) cb(res.error || null)
    })
}

// ─── Data Persistence (debounced, version-locked) ──────────
//
// Optimistic concurrency: every save requires the row version we
// loaded. If another user saved first, our update matches 0 rows
// and we fire the conflict handler instead of silently overwriting.
//
// Requires (run once in Supabase SQL editor):
//   alter table projects add column if not exists version int not null default 0;

var saveTimer = null
var pendingData = null
var pendingProjectId = null
var localVersion = 0          // version of the row we loaded/last saved
var versionSupported = true   // false if column missing (migration not run yet)
var conflictHandler = null

// App registers a callback: called when a save is rejected because
// another user saved first. Receives the fresh server row.
export function onSaveConflict(handler) {
  conflictHandler = handler
}

// Called by App after loading a project so saves carry the right version
export function setLoadedVersion(v) {
  localVersion = (typeof v === 'number' && v >= 0) ? v : 0
}

export function saveProjectData(projectId, stateObj) {
  if (isDemo || !supabase) return
  // stateObj = { panels, equipmentMap, terminationMap, loops, areaGroups }
  pendingProjectId = projectId
  pendingData = stateObj

  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 1500) // 1.5s debounce
}

function flushSave() {
  if (!pendingData || !pendingProjectId || isDemo || !supabase) return
  var pid = pendingProjectId
  var data = pendingData
  pendingData = null
  pendingProjectId = null
  saveTimer = null

  if (!versionSupported) {
    // Fallback: version column missing — plain save (old behavior)
    supabase
      .from('projects')
      .update({ data: data })
      .eq('id', pid)
      .then(function(res) {
        if (res.error) console.error('[MINIMATE] Save failed:', res.error.message)
      })
    return
  }

  var attemptVersion = localVersion
  supabase
    .from('projects')
    .update({ data: data, version: attemptVersion + 1 })
    .eq('id', pid)
    .eq('version', attemptVersion)
    .select('version')
    .then(function(res) {
      if (res.error) {
        // 42703 = undefined column: migration not run yet, degrade gracefully
        if (res.error.code === '42703' || (res.error.message || '').indexOf('version') >= 0) {
          console.warn('[MINIMATE] version column missing - run migration. Falling back to unversioned saves.')
          versionSupported = false
          supabase.from('projects').update({ data: data }).eq('id', pid).then(function(r2) {
            if (r2.error) console.error('[MINIMATE] Save failed:', r2.error.message)
          })
          return
        }
        console.error('[MINIMATE] Save failed:', res.error.message)
        return
      }
      if (res.data && res.data.length > 0) {
        // Save accepted — we own the new version
        localVersion = res.data[0].version
        return
      }
      // 0 rows updated ⇒ someone else saved first ⇒ CONFLICT
      console.warn('[MINIMATE] Save conflict: project changed on server (local v' + attemptVersion + ')')
      supabase
        .from('projects')
        .select('*')
        .eq('id', pid)
        .single()
        .then(function(fresh) {
          if (conflictHandler) conflictHandler(fresh.error ? null : fresh.data)
        })
    })
}

// Force immediate save (call before navigation away)
export function flushPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  flushSave()
}

// ─── Helpers ───────────────────────────────────────────────

function countPoints(data) {
  var total = 0
  var eqMap = data.equipmentMap || {}
  Object.keys(eqMap).forEach(function(pid) {
    var eqs = eqMap[pid] || []
    eqs.forEach(function(eq) {
      var pts = eq.points || []
      pts.forEach(function(pt) {
        if (!pt.excluded) total += (pt.qty || 1)
      })
    })
  })
  return total
}
