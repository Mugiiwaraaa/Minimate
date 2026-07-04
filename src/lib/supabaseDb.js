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

// ─── Entity-level merge (multi-user) ────────────────────────
//
// When two users save concurrently, we merge at ENTITY level:
// my devices/loops/panels overwrite the server's copies of the SAME
// entities; entities only on the server (someone else's work) are
// kept. Known limitation: deleting an entity another user just
// edited can bring it back — acceptable until per-row sync (M6).

function mergeById(serverArr, localArr, mergeItem) {
  var byId = {}
  ;(serverArr || []).forEach(function(s) { if (s && s.id) byId[s.id] = s })
  var seen = {}
  var out = (localArr || []).map(function(l) {
    if (l && l.id) seen[l.id] = true
    var s = l && l.id ? byId[l.id] : null
    return (s && mergeItem) ? mergeItem(s, l) : l
  })
  ;(serverArr || []).forEach(function(s) {
    if (s && s.id && !seen[s.id]) out.push(s)
  })
  return out
}

function mergeEquipMap(serverMap, localMap) {
  var out = Object.assign({}, serverMap || {})
  Object.keys(localMap || {}).forEach(function(pid) {
    out[pid] = mergeById((serverMap || {})[pid], localMap[pid])
  })
  return out
}

export function mergeProjectData(server, local) {
  server = server || {}
  local = local || {}
  function mergeLoop(s, l) {
    return Object.assign({}, s, l, { devices: mergeById(s.devices, l.devices) })
  }
  return {
    panels: mergeById(server.panels, local.panels),
    equipmentMap: mergeEquipMap(server.equipmentMap, local.equipmentMap),
    terminationMap: Object.assign({}, server.terminationMap || {}, local.terminationMap || {}),
    loops: mergeById(server.loops, local.loops, mergeLoop),
    areaGroups: mergeById(server.areaGroups, local.areaGroups),
    drawings: mergeById(server.drawings, local.drawings),
    blockers: mergeById(server.blockers, local.blockers),
    gateways: mergeById(server.gateways, local.gateways)
  }
}

// ─── Data Persistence (debounced, version-locked, self-merging) ──
//
// Optimistic concurrency: every save requires the row version we
// loaded. If another user saved first, we MERGE their data with ours
// and retry (up to 3x). The conflict banner only fires if merging
// keeps failing.
//
// Requires (run once in Supabase SQL editor):
//   alter table projects add column if not exists version int not null default 0;

var saveTimer = null
var pendingData = null
var pendingProjectId = null
var localVersion = 0          // version of the row we loaded/last saved
var versionSupported = true   // false if column missing (migration not run yet)
var conflictHandler = null
var remoteDataHandler = null  // App applies fresh/merged data to state
var liveChannel = null

// App registers a callback: called when a save is rejected because
// another user saved first. Receives the fresh server row.
export function onSaveConflict(handler) {
  conflictHandler = handler
}

// App registers a callback: called with a fresh row (data + version)
// whenever remote changes arrive or a conflict was auto-merged.
export function onRemoteData(handler) {
  remoteDataHandler = handler
}

// ─── Realtime: keep everyone current, shrink the conflict window ──
// Requires (run once in Supabase SQL editor):
//   alter publication supabase_realtime add table projects;
export function subscribeToProject(projectId) {
  if (isDemo || !supabase) return
  unsubscribeFromProject()
  liveChannel = supabase
    .channel('proj-' + projectId)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'projects', filter: 'id=eq.' + projectId }, function(payload) {
      var row = payload && payload.new
      if (!row) return
      var v = row.version || 0
      if (v <= localVersion) return           // our own save echoing back
      if (pendingData || saveTimer) return    // we're mid-edit; conflict path will merge
      localVersion = v
      console.log('[MINIMATE] Remote update received (v' + v + ')')
      if (remoteDataHandler) remoteDataHandler(row)
    })
    .subscribe()
}

export function unsubscribeFromProject() {
  if (liveChannel && supabase) {
    supabase.removeChannel(liveChannel)
    liveChannel = null
  }
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

  attemptSave(pid, data, 0)
}

function attemptSave(pid, data, attempt) {
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

      // 0 rows ⇒ someone saved first ⇒ MERGE their data with ours and retry
      console.warn('[MINIMATE] Concurrent save detected (local v' + attemptVersion + ') - merging (attempt ' + (attempt + 1) + '/3)')
      supabase
        .from('projects')
        .select('*')
        .eq('id', pid)
        .single()
        .then(function(fresh) {
          if (fresh.error || !fresh.data) {
            if (conflictHandler) conflictHandler(null)
            return
          }
          if (attempt >= 2) {
            // Merging keeps losing the race — surface the banner
            if (conflictHandler) conflictHandler(fresh.data)
            return
          }
          var merged = mergeProjectData(fresh.data.data, data)
          localVersion = fresh.data.version || 0
          // Let the app show the merged picture (includes the other user's work)
          if (remoteDataHandler) remoteDataHandler(Object.assign({}, fresh.data, { data: merged }))
          attemptSave(pid, merged, attempt + 1)
        })
    })
}

// ─── Backups ─────────────────────────────────────────────────
// Requires (run once in Supabase SQL editor):
//   create table if not exists project_backups (
//     id uuid primary key default gen_random_uuid(),
//     project_id uuid not null,
//     name text,
//     version int default 0,
//     data jsonb,
//     created_at timestamptz default now()
//   );
//   alter table project_backups enable row level security;
//   create policy "open" on project_backups for all using (true) with check (true);

// Auto-snapshot: called on project load. Takes a backup if the newest
// one is older than 6 hours, then prunes to the latest 20.
export function autoBackup(projectId, projectName, dataObj) {
  if (isDemo || !supabase || !projectId) return
  supabase
    .from('project_backups')
    .select('created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .then(function(res) {
      if (res.error) {
        console.warn('[MINIMATE] Backups table missing? Run the project_backups migration.', res.error.message)
        return
      }
      var newest = res.data && res.data[0] && res.data[0].created_at
      if (newest && (Date.now() - new Date(newest).getTime()) < 6 * 3600 * 1000) return
      supabase
        .from('project_backups')
        .insert({ project_id: projectId, name: projectName || '', version: localVersion, data: dataObj || {} })
        .then(function(ins) {
          if (ins.error) { console.warn('[MINIMATE] Backup failed:', ins.error.message); return }
          console.log('[MINIMATE] Auto-backup saved')
          pruneBackups(projectId)
        })
    })
}

function pruneBackups(projectId) {
  supabase
    .from('project_backups')
    .select('id')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .range(20, 99)
    .then(function(res) {
      if (res.error || !res.data || res.data.length === 0) return
      var ids = res.data.map(function(r) { return r.id })
      supabase.from('project_backups').delete().in('id', ids).then(function() {})
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
