/* --- docStore.js --- R2 Documents engine: FILE + DOCUMENT layers ---
   Three-layer model (roadmap R2):
     FILE     - raw bytes, deduped by SHA-256 hash. Office docs -> Supabase
                Storage bucket 'documents'; DRAWINGS stay in IndexedDB
                (fileStore.js) so this module only records their hash + kind.
     DOCUMENT - a register row in public.documents (auto number, type,
                revision chain w/ supersede, status). Per-row like loops
                (M6 lesson: hot data gets rows, NEVER the JSONB blob).
     DATA     - extracted rows elsewhere carry source_doc_id -> documents.id.

   Inbox states live in `status`: RECEIVED -> CLASSIFIED -> PROCESSED | FAILED,
   plus ARCHIVED (superseded revisions). Nothing touches live panels/devices
   until the user confirms type and hits PROCESS (App-side).

   RLS is OPEN until R3 auth (USING true), same as every other table.

   Canonical SQL lives in supabase/schema.sql (S4 consolidation) — this
   comment is kept in sync for readers of this file, not run separately.
   ============ SUPABASE SCHEMA (see supabase/schema.sql) ============
   create table if not exists public.documents (
     project_id    uuid not null references public.projects(id) on delete cascade,
     id            text not null,
     register_no   text default '',
     doc_type      text default 'OTHER',
     title         text default '',
     floor         text default '',
     revision      text default 'A',
     seq           int  default 0,
     supersedes_id text,
     status        text default 'RECEIVED',
     file_hash     text,
     storage_kind  text default 'supabase',
     storage_path  text,
     file_name     text default '',
     file_type     text default '',
     file_size     bigint default 0,
     source        text default '',
     remarks       text default '',
     extracted     jsonb default '{}'::jsonb,
     created_at    timestamptz default now(),
     updated_at    timestamptz default now(),
     primary key (project_id, id)
   );
   alter table public.documents enable row level security;
   create policy documents_open on public.documents
     for all using (true) with check (true);

   insert into storage.buckets (id, name, public)
     values ('documents', 'documents', false)
     on conflict (id) do nothing;
   create policy documents_obj_open on storage.objects
     for all using (bucket_id = 'documents') with check (bucket_id = 'documents');

   -- optional realtime (add later if multi-device live inbox is wanted):
   -- alter publication supabase_realtime add table public.documents;
   ============ END SQL ============ */

import { supabase, isDemo } from './supabase'
import { hashFile } from './fileStore'

var BUCKET = 'documents'

/* Register-number type abbreviations (BN01-IOL-GF-003-C) */
var TYPE_ABBR = {
  DRAWING: 'DWG', IO_LIST: 'IOL', DDC_TERMINATION: 'TRM', FCU_SCHEDULE: 'FCU',
  VAV_SCHEDULE: 'VAV', DDC_PANEL_SCHEDULE: 'DPS', REPORT: 'RPT',
  INSPECTION_LOG: 'INS', DELIVERY_NOTE: 'DLN', MATERIAL_DOC: 'MAT', OTHER: 'DOC'
}

var DOC_TYPE_LABELS = {
  DRAWING: 'DRAWING', IO_LIST: 'IO LIST', DDC_TERMINATION: 'DDC TERMINATION',
  FCU_SCHEDULE: 'FCU SCHEDULE', VAV_SCHEDULE: 'VAV SCHEDULE',
  DDC_PANEL_SCHEDULE: 'DDC PANEL SCHEDULE', REPORT: 'REPORT',
  INSPECTION_LOG: 'INSPECTION LOG', DELIVERY_NOTE: 'DELIVERY NOTE',
  MATERIAL_DOC: 'MATERIAL DOC', OTHER: 'OTHER'
}

/* Types with a LIVE import pipeline today -> route on PROCESS. Everything
   else parks in the library, typed, until its engine lands (R4/R5). */
var ROUTABLE_TYPES = {
  DRAWING: 'drawings',
  IO_LIST: 'panels',
  DDC_TERMINATION: 'panels',
  FCU_SCHEDULE: 'devices',
  VAV_SCHEDULE: 'devices',
  DDC_PANEL_SCHEDULE: 'panels'
}

var docCounter = 0
function docId() { docCounter++; return 'doc-' + Date.now() + '-' + docCounter }

function up(v) { return (v || '').toString().toUpperCase() }

/* ============ Register numbering ============ */

function projectCode(project) {
  if (project && project.code) return up(project.code).replace(/[^A-Z0-9]/g, '')
  var name = up((project && project.name) || 'PRJ')
  var m = name.match(/[A-Z]{2,}\d+/) || name.match(/\b[A-Z0-9]{2,6}\b/)
  if (m) return m[0]
  return name.replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'PRJ'
}

function floorCode(floor) {
  var f = up(floor || '')
  if (!f) return 'GEN'
  if (/ROOF/.test(f)) return 'RF'
  if (/GROUND/.test(f)) return 'GF'
  if (/FIRST/.test(f)) return 'FF'
  if (/SECOND/.test(f)) return 'SF'
  if (/THIRD/.test(f)) return 'TF'
  if (/BASE|BASEMENT/.test(f)) return 'BF'
  var lvl = f.match(/(\d+)/)
  if (lvl) return 'L' + lvl[1]
  return f.replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'GEN'
}

function pad3(n) { var s = '' + (n || 0); while (s.length < 3) { s = '0' + s } return s }

function makeRegisterNo(project, docType, floor, seq, revision) {
  return [projectCode(project), TYPE_ABBR[docType] || 'DOC', floorCode(floor), pad3(seq || 1)].join('-') + '-' + up(revision || 'A')
}

/* next seq for (project, type, floor), scanning existing docs */
function nextSeq(docs, docType, floor) {
  var fc = floorCode(floor)
  var max = 0
  ;(docs || []).forEach(function(d) {
    if (d.doc_type === docType && floorCode(d.floor) === fc) {
      var n = parseInt(d.seq || 0, 10) || 0
      if (n > max) max = n
    }
  })
  return max + 1
}

function nextRevision(rev) {
  var r = up(rev || 'A')
  var c = r.charCodeAt(r.length - 1)
  if (c >= 65 && c < 90) return r.slice(0, -1) + String.fromCharCode(c + 1)
  return r + 'A'
}

/* Assign register_no + seq to a doc once its type + floor are confirmed. */
function assignRegister(project, existingDocs, doc) {
  var seq = nextSeq(existingDocs, doc.doc_type, doc.floor)
  doc.seq = seq
  doc.register_no = makeRegisterNo(project, doc.doc_type, doc.floor, seq, doc.revision || 'A')
  return doc
}

/* Build the metadata for a NEW revision that supersedes prevDoc (same base
   number + type + floor + seq, bumped revision letter). */
function makeRevisionMeta(project, prevDoc) {
  var rev = nextRevision(prevDoc.revision || 'A')
  return {
    doc_type: prevDoc.doc_type,
    floor: prevDoc.floor || '',
    seq: prevDoc.seq || 0,
    revision: rev,
    supersedes_id: prevDoc.id,
    register_no: makeRegisterNo(project, prevDoc.doc_type, prevDoc.floor, prevDoc.seq, rev)
  }
}

/* ============ Storage (office-doc bytes -> Supabase Storage) ============ */

function safeName(n) { return (n || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) }

function uploadBytes(projectId, hash, file) {
  if (isDemo || !supabase) return Promise.resolve(null)
  var path = projectId + '/' + hash + '-' + safeName(file.name)
  return supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true, contentType: file.type || 'application/octet-stream'
  }).then(function(res) {
    if (res.error) throw res.error
    return path
  })
}

function signedUrl(path, expiresSec) {
  if (isDemo || !supabase || !path) return Promise.resolve(null)
  return supabase.storage.from(BUCKET).createSignedUrl(path, expiresSec || 3600).then(function(res) {
    if (res.error) throw res.error
    return (res.data && res.data.signedUrl) || null
  })
}

function deleteBytes(path) {
  if (isDemo || !supabase || !path) return Promise.resolve()
  return supabase.storage.from(BUCKET).remove([path]).then(function() { return true })
}

/* ============ DOCUMENT register rows ============ */

function docToRow(projectId, d) {
  return {
    project_id: projectId,
    id: d.id,
    register_no: d.register_no || '',
    doc_type: d.doc_type || 'OTHER',
    title: d.title || '',
    floor: d.floor || '',
    revision: d.revision || 'A',
    seq: d.seq || 0,
    supersedes_id: d.supersedes_id || null,
    status: d.status || 'RECEIVED',
    file_hash: d.file_hash || '',
    storage_kind: d.storage_kind || 'supabase',
    storage_path: d.storage_path || null,
    file_name: d.file_name || '',
    file_type: d.file_type || '',
    file_size: d.file_size || 0,
    source: d.source || '',
    remarks: d.remarks || '',
    extracted: d.extracted || {},
    updated_at: new Date().toISOString()
  }
}

function listDocuments(projectId) {
  if (isDemo || !supabase) return Promise.resolve([])
  return supabase.from('documents').select('*').eq('project_id', projectId)
    .order('created_at', { ascending: true }).then(function(res) {
      if (res.error) throw res.error
      return res.data || []
    })
}

function upsertDocument(projectId, doc) {
  var row = docToRow(projectId, doc)
  if (isDemo || !supabase) return Promise.resolve(row)
  return supabase.from('documents').upsert(row, { onConflict: 'project_id,id' }).then(function(res) {
    if (res.error) throw res.error
    return row
  })
}

function deleteDocument(projectId, id) {
  if (isDemo || !supabase) return Promise.resolve()
  return supabase.from('documents').delete().eq('project_id', projectId).eq('id', id).then(function(res) {
    if (res.error) throw res.error
    return true
  })
}

/* Dedupe: is this hash already in the register for this project? */
function findByHash(docs, hash) {
  var hit = null
  ;(docs || []).forEach(function(d) { if (!hit && d.file_hash === hash) hit = d })
  return hit
}

/* ============ Ingest: FILE + a RECEIVED document row (no live data yet) ============
   Returns a doc object (not yet register-numbered — that happens at confirm).
   opts: { docType, floor, title, source, storageKind, revision, supersedesId } */
function ingestFile(project, file, existingDocs, opts) {
  opts = opts || {}
  var projectId = project.id
  return hashFile(file).then(function(hash) {
    var dupe = findByHash(existingDocs, hash)
    var storageKind = opts.storageKind || (opts.docType === 'DRAWING' ? 'indexeddb' : 'supabase')

    function build(path) {
      return {
        id: docId(),
        register_no: '',
        doc_type: opts.docType || 'OTHER',
        title: opts.title || file.name || '',
        floor: opts.floor || '',
        revision: opts.revision || 'A',
        seq: 0,
        supersedes_id: opts.supersedesId || null,
        status: 'RECEIVED',
        file_hash: hash,
        storage_kind: storageKind,
        storage_path: path || null,
        file_name: file.name || '',
        file_type: file.type || '',
        file_size: file.size || 0,
        source: opts.source || 'IMPORT',
        remarks: dupe ? 'DUPLICATE OF ' + (dupe.register_no || dupe.file_name) : '',
        extracted: opts.extracted || {},
        created_at: new Date().toISOString(),
        _duplicateOf: dupe ? dupe.id : null
      }
    }

    if (storageKind === 'supabase') {
      return uploadBytes(projectId, hash, file).then(function(path) { return build(path) })
    }
    return Promise.resolve(build(null))
  })
}

/* Archive an import into the library in one call: hash + (upload) + register
   number + register row. Best-effort; resolves with the doc (or null on fail). */
function archiveDocument(project, file, existingDocs, opts) {
  return ingestFile(project, file, existingDocs || [], opts || {}).then(function(doc) {
    assignRegister(project, existingDocs || [], doc)
    doc.status = 'PROCESSED'
    return upsertDocument(project.id, doc).then(function() { return doc })
  })
}

export {
  BUCKET, TYPE_ABBR, DOC_TYPE_LABELS, ROUTABLE_TYPES, archiveDocument,
  docId, projectCode, floorCode, makeRegisterNo, nextSeq, nextRevision,
  assignRegister, makeRevisionMeta,
  uploadBytes, signedUrl, deleteBytes,
  listDocuments, upsertDocument, deleteDocument, findByHash, ingestFile
}
