/* --- drawingCloudStore.js --- Cloud backup for Trace Studio drawing files ---
   fileStore.js's IndexedDB cache is per-device only — if the device that
   first uploaded a drawing is lost/wiped, or a different supervisor needs
   the same drawing, there is no shared copy anywhere ("THE ORIGINAL FILE IS
   NOT CACHED ON THIS DEVICE"). This uploads the same bytes (best-effort,
   non-blocking) to Supabase Storage so any device/user on the project can
   fetch it. Mirrors docStore.js's uploadBytes/signedUrl pattern, but returns
   raw bytes via .download() instead of a signed URL — Trace Studio needs a
   File object to hand to pdf.js, not a link to display.

   RLS is OPEN until R3 auth (USING true), same as every other bucket/table.

   ============ RUN THIS SQL IN SUPABASE ONCE ============
   insert into storage.buckets (id, name, public)
     values ('drawings', 'drawings', false)
     on conflict (id) do nothing;
   create policy drawings_obj_open on storage.objects
     for all using (bucket_id = 'drawings') with check (bucket_id = 'drawings');
   ======================================================== */

import { supabase, isDemo } from './supabase'

var BUCKET = 'drawings'

function safeName(n) { return (n || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) }

/* Pure + deterministic so upload and download always agree on the same path
   without needing to persist it anywhere. */
function drawingPath(projectId, hash, fileName) {
  return projectId + '/' + hash + '-' + safeName(fileName)
}

/* Best-effort — never throws to the caller. Called on every Trace Studio
   open (new or reopened file alike); upsert:true makes re-uploading the
   same bytes a harmless no-op, so old drawings get retroactively backed up
   simply by being reopened over time. */
function uploadDrawing(projectId, hash, file) {
  if (isDemo || !supabase || !projectId || !hash || !file) return Promise.resolve(null)
  var path = drawingPath(projectId, hash, file.name)
  return supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true, contentType: file.type || 'application/octet-stream'
  }).then(function(res) {
    if (res.error) throw res.error
    return path
  }).catch(function() { return null })
}

/* Resolves a File on a hit, or null on any failure (bucket not set up yet,
   never uploaded, network down, ...) — callers fall back to the existing
   manual "SELECT FILE" flow in that case. */
function downloadDrawing(projectId, hash, fileName, fileType) {
  if (isDemo || !supabase || !projectId || !hash) return Promise.resolve(null)
  var path = drawingPath(projectId, hash, fileName)
  return supabase.storage.from(BUCKET).download(path).then(function(res) {
    if (res.error) throw res.error
    return new File([res.data], fileName || 'drawing', { type: fileType || 'application/octet-stream' })
  }).catch(function() { return null })
}

export { drawingPath, uploadDrawing, downloadDrawing }
