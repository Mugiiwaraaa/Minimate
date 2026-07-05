/* --- reportStore.js --- R1: progress history for trend + forecast ---
   One tiny snapshot per project per ~day (taken on project load).
   A snapshot is per-stage device counts — a few hundred bytes.
   Trend charts and projected-completion math read these.

   Requires (run once in Supabase SQL editor):
     create table if not exists progress_snapshots (
       id uuid primary key default gen_random_uuid(),
       project_id uuid not null references projects(id) on delete cascade,
       snapped_at timestamptz default now(),
       total int default 0,
       comm int default 0,
       ctrl int default 0,
       cont int default 0,
       term int default 0,
       inst int default 0,
       addr int default 0
     );
     create index if not exists idx_snap_proj on progress_snapshots(project_id);
     alter table progress_snapshots enable row level security;
     create policy "open" on progress_snapshots for all using (true) with check (true);
*/

import { supabase, isDemo } from './supabase'

export function countStages(loops) {
  var c = { total: 0, comm: 0, ctrl: 0, cont: 0, term: 0, inst: 0, addr: 0 }
  ;(loops || []).forEach(function(l) {
    ;(l.devices || []).forEach(function(d) {
      c.total++
      if (d.comm_cable) c.comm++
      if (d.control_cable) c.ctrl++
      if (d.continuity) c.cont++
      if (d.termination) c.term++
      if (d.device_installed) c.inst++
      if (d.address_set) c.addr++
    })
  })
  return c
}

/* Take a snapshot if the newest one is older than 20 hours. */
export function snapshotProgress(projectId, loops) {
  if (isDemo || !supabase || !projectId) return
  supabase
    .from('progress_snapshots')
    .select('snapped_at')
    .eq('project_id', projectId)
    .order('snapped_at', { ascending: false })
    .limit(1)
    .then(function(res) {
      if (res.error) {
        console.warn('[R1] progress_snapshots table missing? Run the R1 migration.', res.error.message)
        return
      }
      var newest = res.data && res.data[0] && res.data[0].snapped_at
      if (newest && (Date.now() - new Date(newest).getTime()) < 20 * 3600 * 1000) return
      var c = countStages(loops)
      if (c.total === 0) return
      supabase
        .from('progress_snapshots')
        .insert(Object.assign({ project_id: projectId }, c))
        .then(function(ins) {
          if (!ins.error) console.log('[R1] Progress snapshot saved (' + c.inst + '/' + c.total + ' installed)')
        })
    })
}

export function fetchSnapshots(projectId, cb) {
  if (isDemo || !supabase || !projectId) { cb(null, []); return }
  supabase
    .from('progress_snapshots')
    .select('*')
    .eq('project_id', projectId)
    .order('snapped_at', { ascending: true })
    .limit(120)
    .then(function(res) {
      cb(res.error || null, res.data || [])
    })
}

/* Linear velocity over up to the last 14 days of snapshots.
   Returns { perDay, projectedDate, daysLeft } or null when not enough data. */
export function computeForecast(snapshots, currentInstalled, total) {
  if (!snapshots || snapshots.length < 2 || total === 0) return null
  var cutoff = Date.now() - 14 * 86400000
  var recent = snapshots.filter(function(s) { return new Date(s.snapped_at).getTime() >= cutoff })
  if (recent.length < 2) recent = snapshots.slice(-2)
  var first = recent[0]
  var last = recent[recent.length - 1]
  var days = (new Date(last.snapped_at) - new Date(first.snapped_at)) / 86400000
  if (days < 0.5) return null
  var perDay = (last.inst - first.inst) / days
  if (perDay <= 0) return { perDay: 0, projectedDate: null, daysLeft: null }
  var remaining = total - currentInstalled
  var daysLeft = Math.ceil(remaining / perDay)
  var projected = new Date(Date.now() + daysLeft * 86400000)
  return { perDay: Math.round(perDay * 10) / 10, projectedDate: projected, daysLeft: daysLeft }
}
