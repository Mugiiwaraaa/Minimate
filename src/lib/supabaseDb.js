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

// ─── Entity-level 3-WAY merge (multi-user) ──────────────────
//
// base = what the data looked like when WE loaded/last saved.
// Knowing the base lets us tell deletions apart from additions:
//   in base, on server, not local  -> WE deleted it     -> stays deleted
//   in base, local, not on server -> THEY deleted it   -> deleted, unless
//                                     we edited it since (edit wins)
//   not in base, only on server   -> THEY added it     -> kept
//   not in base, only local       -> WE added it       -> kept
//   on both sides                 -> our copy wins (we are the one saving)

// Field-level 3-way merge of one entity: my field wins only if I CHANGED
// it since load. Fields I didn't touch keep the server's (other user's)
// value. This is what protects "supervisor filled DDC/gateway on the loop
// while I only ticked device stages" — both survive.
function merge3Fields(s, l, b) {
  var out = Object.assign({}, s)
  Object.keys(l).forEach(function(k) {
    if (k === 'devices') return // devices merge separately, per device
    var lv = JSON.stringify(l[k])
    var bv = b ? JSON.stringify(b[k]) : undefined
    if (b === undefined || b === null || lv !== bv) out[k] = l[k]
  })
  return out
}

function mergeById(serverArr, localArr, baseArr, mergeItem) {
  var sBy = {}
  var bBy = {}
  ;(serverArr || []).forEach(function(s) { if (s && s.id) sBy[s.id] = s })
  ;(baseArr || []).forEach(function(b) { if (b && b.id) bBy[b.id] = b })
  var seen = {}
  var out = []
  ;(localArr || []).forEach(function(l) {
    if (!l || !l.id) { out.push(l); return }
    seen[l.id] = true
    var s = sBy[l.id]
    if (s) {
      out.push(mergeItem ? mergeItem(s, l, bBy[l.id]) : merge3Fields(s, l, bBy[l.id]))
      return
    }
    var b = bBy[l.id]
    if (!b) { out.push(l); return } // we added it
    // They deleted it. Keep ours only if we changed it since load (edit wins).
    if (JSON.stringify(l) !== JSON.stringify(b)) out.push(l)
  })
  ;(serverArr || []).forEach(function(s) {
    if (!s || !s.id || seen[s.id]) return
    if (bBy[s.id]) return // was in our base and we no longer have it -> WE deleted it
    out.push(s)           // they added it
  })
  return out
}

function mergeEquipMap(serverMap, localMap, baseMap) {
  var out = Object.assign({}, serverMap || {})
  Object.keys(localMap || {}).forEach(function(pid) {
    out[pid] = mergeById((serverMap || {})[pid], localMap[pid], (baseMap || {})[pid])
  })
  // Panels we deleted entirely
  Object.keys(out).forEach(function(pid) {
    if ((baseMap || {})[pid] && !(localMap || {})[pid]) delete out[pid]
  })
  return out
}

export function mergeProjectData(server, local, base) {
  server = server || {}
  local = local || {}
  base = base || {}
  function mergeLoop(s, l, b) {
    var merged = merge3Fields(s, l, b)
    merged.devices = mergeById(s.devices, l.devices, (b || {}).devices)
    return merged
  }
  // terminationMap: 3-way per panel — my panel wins only if I changed it
  function mergeTermMap(serverMap, localMap, baseMap) {
    var out = Object.assign({}, serverMap || {})
    Object.keys(localMap || {}).forEach(function(pid) {
      var lv = JSON.stringify(localMap[pid])
      var bv = (baseMap || {})[pid] === undefined ? undefined : JSON.stringify(baseMap[pid])
      if (bv === undefined || lv !== bv) out[pid] = localMap[pid]
    })
    Object.keys(out).forEach(function(pid) {
      if ((baseMap || {})[pid] !== undefined && (localMap || {})[pid] === undefined) delete out[pid]
    })
    return out
  }

  return {
    panels: mergeById(server.panels, local.panels, base.panels),
    equipmentMap: mergeEquipMap(server.equipmentMap, local.equipmentMap, base.equipmentMap),
    terminationMap: mergeTermMap(server.terminationMap, local.terminationMap, base.terminationMap),
    loops: mergeById(server.loops, local.loops, base.loops, mergeLoop),
    areaGroups: mergeById(server.areaGroups, local.areaGroups, base.areaGroups),
    drawings: mergeById(server.drawings, local.drawings, base.drawings),
    blockers: mergeById(server.blockers, local.blockers, base.blockers),
    gateways: mergeById(server.gateways, local.gateways, base.gateways)
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
var baseData = null           // snapshot of data at load/last save (3-way merge base)
var versionSupported = true   // false if column missing (migration not run yet)
var conflictHandler = null
var remoteDataHandler = null  // App applies fresh/merged data to state
var liveChannel = null

// Called by App after loading a project: remember the base snapshot
export function setLoadedData(dataObj) {
  try { baseData = JSON.parse(JSON.stringify(dataObj || {})) } catch (e) { baseData = null }
}

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
      setLoadedData(row.data)
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

var inFlight = false // only ONE save round-trip at a time — rapid edits queue up

function flushSave() {
  if (!pendingData || !pendingProjectId || isDemo || !supabase) return
  if (inFlight) {
    // A save is mid-flight; try again when it lands (finishSave also re-fires)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, 500)
    return
  }
  var pid = pendingProjectId
  var data = pendingData
  pendingData = null
  pendingProjectId = null
  saveTimer = null
  inFlight = true

  if (!versionSupported) {
    // Fallback: version column missing — plain save (old behavior)
    supabase
      .from('projects')
      .update({ data: data })
      .eq('id', pid)
      .then(function(res) {
        if (res.error) console.error('[MINIMATE] Save failed:', res.error.message)
        finishSave()
      })
    return
  }

  attemptSave(pid, data, 0)
}

function finishSave() {
  inFlight = false
  if (pendingData) flushSave() // edits made during the round-trip save next
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
            finishSave()
          })
          return
        }
        console.error('[MINIMATE] Save failed:', res.error.message)
        finishSave()
        return
      }
      if (res.data && res.data.length > 0) {
        // Save accepted — we own the new version; this data is the new base
        localVersion = res.data[0].version
        setLoadedData(data)
        finishSave()
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
            finishSave()
            return
          }
          if (attempt >= 2) {
            // Merging keeps losing the race — surface the banner
            if (conflictHandler) conflictHandler(fresh.data)
            finishSave()
            return
          }
          var merged = mergeProjectData(fresh.data.data, data, baseData)
          localVersion = fresh.data.version || 0
          setLoadedData(fresh.data.data) // server state is the new base for the retry
          // Show the merged picture ONLY if the user is not mid-edit —
          // never stomp on checkboxes being ticked right now
          if (remoteDataHandler && !pendingData && !saveTimer) {
            remoteDataHandler(Object.assign({}, fresh.data, { data: merged }))
          }
          attemptSave(pid, merged, attempt + 1)
        })
        .catch(function(e) { console.error('[MINIMATE] Conflict fetch failed:', e && e.message); finishSave() })
    })
    .catch(function(e) { console.error('[MINIMATE] Save request failed:', e && e.message); finishSave() })
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
