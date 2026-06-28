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

// ─── Data Persistence (debounced) ──────────────────────────

var saveTimer = null
var pendingData = null
var pendingProjectId = null

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

  supabase
    .from('projects')
    .update({ data: data })
    .eq('id', pid)
    .then(function(res) {
      if (res.error) {
        console.error('[MINIMATE] Save failed:', res.error.message)
      }
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
