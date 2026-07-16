/* --- datasetStore.js --- S2 dataset model with revisions ---
   Working copy (revision_number=0) is mutable with optimistic version lock.
   ISSUE operation creates immutable snapshot (revision_number >= 1).
   Per-dataset realtime scope. Provenance via source_doc_id -> documents.id.

   RLS is OPEN until R3 auth (USING true), same as every other table.

   ============ RUN THIS SQL IN SUPABASE ONCE ============
   create table if not exists public.datasets (
     project_id      text not null,
     id              text not null,
     revision_number int not null default 0,
     kind            text default 'generic',
     name            text default '',
     columns         jsonb default '[]'::jsonb,
     rows            jsonb default '[]'::jsonb,
     source_doc_id   text,
     version         int not null default 1,
     created_at      timestamptz default now(),
     updated_at      timestamptz default now(),
     primary key (project_id, id, revision_number)
   );
   alter table public.datasets enable row level security;
   create policy datasets_open on public.datasets
     for all using (true) with check (true);

   -- Add to realtime publication for per-dataset subscriptions
   alter publication supabase_realtime add table public.datasets;
   ======================================================== */

import { supabase, isDemo } from './supabase'

/* ================================================================
   CORE OPERATIONS
   ================================================================ */

// Get working copy (revision_number = 0)
export function getWorkingCopy(projectId, datasetId, cb) {
  if (isDemo || !supabase) { cb(null, null); return }

  supabase
    .from('datasets')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', datasetId)
    .eq('revision_number', 0)
    .single()
    .then(res => {
      if (res.error && res.error.code !== 'PGRST116') { // PGRST116 = not found (ok)
        cb(res.error, null)
      } else {
        cb(null, res.data || null)
      }
    })
}

// Update working copy with optimistic version lock.
//
// BUG FIXED (2026-07-14): the old code chained upsert(row).eq('version',
// currentVersion) expecting that to gate the write on the version matching —
// it doesn't. PostgREST doesn't apply query filters to an insert/upsert's
// affected rows, only to what comes back in the RETURNING set, and the row
// we'd just written already carried version:currentVersion+1 — so that
// filter could never match what was just written and ALWAYS reported a
// false "version conflict" while the upsert itself had already landed
// unconditionally underneath. Net effect: every save silently won
// regardless of a real conflict, which is how the estimate dataset lost
// equipment entries when two saves raced (last write wins with no real
// lock at all, not "safely rejected").
//
// Real fix: an UPDATE ... WHERE version = currentVersion actually is
// filtered by Postgres before ever touching a row, so an empty RETURNING
// set here genuinely means either no row exists yet (first save) or the
// version moved under us (real conflict) — insert covers the former.
export function updateWorkingCopy(projectId, datasetId, updates, cb) {
  if (isDemo || !supabase) { cb(null, true); return }

  const currentVersion = updates.version || 1
  const patch = {
    kind: updates.kind,
    name: updates.name,
    columns: updates.columns || [],
    rows: updates.rows || [],
    source_doc_id: updates.source_doc_id || null,
    version: currentVersion + 1,
    updated_at: new Date().toISOString()
  }

  supabase
    .from('datasets')
    .update(patch)
    .eq('project_id', projectId).eq('id', datasetId).eq('revision_number', 0).eq('version', currentVersion)
    .select()
    .then(res => {
      if (res.error) { cb(res.error, false); return }
      if (res.data && res.data.length > 0) { cb(null, true); return } // update landed, done

      // Nothing updated — find out whether this is a first-ever save (insert)
      // or a genuine conflict (someone else's save already moved the version).
      supabase.from('datasets').select('id')
        .eq('project_id', projectId).eq('id', datasetId).eq('revision_number', 0)
        .then(existsRes => {
          if (existsRes.error) { cb(existsRes.error, false); return }
          if (existsRes.data && existsRes.data.length > 0) {
            cb(new Error('Version conflict - dataset was modified by another user'), false)
            return
          }
          supabase.from('datasets')
            .insert(Object.assign({ project_id: projectId, id: datasetId, revision_number: 0 }, patch, { version: 1 }))
            .select()
            .then(insRes => {
              if (insRes.error) cb(insRes.error, false)
              else cb(null, true)
            })
        })
    })
}

// Issue immutable revision (copy working copy to max(revision_number) + 1)
export function issueRevision(projectId, datasetId, cb) {
  if (isDemo || !supabase) { cb(null, null); return }

  // 1. Get working copy
  getWorkingCopy(projectId, datasetId, (err, workingCopy) => {
    if (err) { cb(err, null); return }
    if (!workingCopy) { cb(new Error('No working copy found'), null); return }

    // 2. Get max revision number
    supabase
      .from('datasets')
      .select('revision_number')
      .eq('project_id', projectId)
      .eq('id', datasetId)
      .order('revision_number', { ascending: false })
      .limit(1)
      .single()
      .then(res => {
        const maxRev = res.data ? res.data.revision_number : 0
        const newRevNumber = maxRev + 1

        // 3. Copy working copy to new revision
        const issuedRow = {
          project_id: projectId,
          id: datasetId,
          revision_number: newRevNumber,
          kind: workingCopy.kind,
          name: workingCopy.name,
          columns: workingCopy.columns,
          rows: workingCopy.rows,
          source_doc_id: workingCopy.source_doc_id,
          version: 1, // issued revisions don't use version lock
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }

        supabase
          .from('datasets')
          .insert(issuedRow)
          .select()
          .single()
          .then(insertRes => {
            if (insertRes.error) {
              cb(insertRes.error, null)
            } else {
              cb(null, insertRes.data)
            }
          })
      })
  })
}

// List all revisions (working copy + issued)
export function listRevisions(projectId, datasetId, cb) {
  if (isDemo || !supabase) { cb(null, []); return }

  supabase
    .from('datasets')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', datasetId)
    .order('revision_number', { ascending: true })
    .then(res => {
      if (res.error) {
        cb(res.error, [])
      } else {
        cb(null, res.data || [])
      }
    })
}

// Get specific revision
export function getRevision(projectId, datasetId, revisionNumber, cb) {
  if (isDemo || !supabase) { cb(null, null); return }

  supabase
    .from('datasets')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', datasetId)
    .eq('revision_number', revisionNumber)
    .single()
    .then(res => {
      if (res.error && res.error.code !== 'PGRST116') {
        cb(res.error, null)
      } else {
        cb(null, res.data || null)
      }
    })
}

// List all datasets for a project (working copies only)
export function listDatasets(projectId, cb) {
  if (isDemo || !supabase) { cb(null, []); return }

  supabase
    .from('datasets')
    .select('*')
    .eq('project_id', projectId)
    .eq('revision_number', 0) // working copies only
    .order('updated_at', { ascending: false })
    .then(res => {
      if (res.error) {
        cb(res.error, [])
      } else {
        cb(null, res.data || [])
      }
    })
}

// Delete dataset (all revisions)
export function deleteDataset(projectId, datasetId, cb) {
  if (isDemo || !supabase) { cb(null, true); return }

  supabase
    .from('datasets')
    .delete()
    .eq('project_id', projectId)
    .eq('id', datasetId)
    .then(res => {
      if (res.error) {
        cb(res.error, false)
      } else {
        cb(null, true)
      }
    })
}

/* ================================================================
   REALTIME — per-dataset subscription
   ================================================================ */

const datasetChannels = {} // datasetId -> channel

export function subscribeDataset(projectId, datasetId, onUpdate) {
  if (isDemo || !supabase) return

  const channelKey = `${projectId}:${datasetId}`
  unsubscribeDataset(datasetId)

  const channel = supabase
    .channel(`dataset-${channelKey}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'datasets',
      filter: `project_id=eq.${projectId},id=eq.${datasetId}`
    }, payload => {
      onUpdate(payload)
    })
    .subscribe()

  datasetChannels[datasetId] = channel
}

export function unsubscribeDataset(datasetId) {
  const channel = datasetChannels[datasetId]
  if (channel && supabase) {
    supabase.removeChannel(channel)
    delete datasetChannels[datasetId]
  }
}

export function unsubscribeAllDatasets() {
  Object.keys(datasetChannels).forEach(unsubscribeDataset)
}
