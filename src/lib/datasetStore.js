/* --- datasetStore.js --- S2 dataset model with revisions ---
   Working copy (revision_number=0) is mutable with optimistic version lock.
   ISSUE operation creates immutable snapshot (revision_number >= 1).
   Per-dataset realtime scope. */

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

// Update working copy with optimistic version lock
export function updateWorkingCopy(projectId, datasetId, updates, cb) {
  if (isDemo || !supabase) { cb(null, true); return }

  const currentVersion = updates.version || 1
  const row = {
    project_id: projectId,
    id: datasetId,
    revision_number: 0,
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
    .upsert(row, { onConflict: 'project_id,id,revision_number' })
    .eq('version', currentVersion) // optimistic lock
    .select()
    .then(res => {
      if (res.error) {
        cb(res.error, false)
      } else if (!res.data || res.data.length === 0) {
        cb(new Error('Version conflict - dataset was modified by another user'), false)
      } else {
        cb(null, true)
      }
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
