-- ============================================================
-- Minimate — v0.2 Database Schema (Document-Based)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- ============================================================
--
-- Single projects table with JSONB data column.
-- Each project stores its entire state as a document:
--   { panels, equipmentMap, terminationMap, loops, areaGroups }
--
-- This avoids complex normalization and maps directly to
-- the React state. Can be normalized later for server-side
-- queries, reports, etc.
-- ============================================================

-- Drop old v0.1 tables if they exist (safe to skip if fresh DB)
drop table if exists update_log cascade;
drop table if exists field_devices cascade;
drop table if exists field_device_schedules cascade;
drop table if exists io_points cascade;
drop table if exists equipment cascade;
drop table if exists ddc_panels cascade;
drop table if exists project_members cascade;
drop table if exists profiles cascade;
drop table if exists projects cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists update_updated_at() cascade;

-- ============================================================
-- PROJECTS TABLE
-- ============================================================

create table projects (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  client text default '',
  location text default '',
  status text default 'active' check (status in ('active','complete','on_hold')),
  data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for listing projects
create index idx_projects_status on projects(status);
create index idx_projects_updated on projects(updated_at desc);

-- Auto-update updated_at on save
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_updated_at before update on projects
  for each row execute procedure update_updated_at();

-- ============================================================
-- DISABLE RLS FOR NOW (Phase 3 adds auth + RLS)
-- ============================================================
-- Anyone with the anon key can read/write projects.
-- This is fine for solo or small-team use during development.
-- Phase 3 will add auth.users, profiles, project_members, and
-- row-level security policies.

alter table projects enable row level security;

-- Allow all operations with anon key
create policy "Allow all for now" on projects
  for all using (true) with check (true);

-- ============================================================
-- S2 — DATASETS TABLE (typed tabular datasets with revisions)
-- ============================================================
-- Each dataset tracks: working copy (mutable) + issued snapshots (immutable)
-- revision_number = 0 is working copy, >= 1 are issued revisions
-- Composite PK ensures one working copy + many issued revisions per dataset

create table datasets (
  project_id uuid not null references projects(id) on delete cascade,
  id text not null,  -- stable dataset ID across all revisions
  revision_number int not null default 0,  -- 0 = working copy, 1+ = issued
  kind text not null check (kind in ('IO_SUMMARY','CABLE_TAKEOFF','BOQ','ESTIMATE','CUSTOM')),
  name text not null,
  columns jsonb not null default '[]'::jsonb,  -- [{name, type, ...}]
  rows jsonb not null default '[]'::jsonb,  -- actual data rows
  source_doc_id text,  -- provenance link to documents.id
  version int not null default 1,  -- optimistic lock (working copy only)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, id, revision_number)
);

-- Indexes for common queries
create index idx_datasets_project on datasets(project_id);
create index idx_datasets_working_copy on datasets(project_id, id) where revision_number = 0;
create index idx_datasets_kind on datasets(project_id, kind);

-- Auto-update updated_at on working copy edits
create trigger set_datasets_updated_at before update on datasets
  for each row when (new.revision_number = 0)
  execute procedure update_updated_at();

-- RLS: same as projects for now
alter table datasets enable row level security;
create policy "Allow all for now" on datasets
  for all using (true) with check (true);

-- ============================================================
-- S4 — CONSOLIDATED SCHEMA (previously missing / comment-only)
-- ============================================================
-- These five tables were live in production but only ever existed as
-- CREATE TABLE comments scattered across loopStore.js/docStore.js/
-- reportStore.js/supabaseDb.js — a fresh Supabase project set up from
-- this file alone would previously break loop syncing silently
-- (loadLoops -> ensureBackfill: "[M6] loops table missing?"). Column
-- names verified against loopStore.js's loopRowToLoop/deviceRowToDevice
-- and docStore.js's actual field usage. NOTE: documents.project_id is
-- `uuid references projects(id)` here, not the `text` type previously
-- written in docStore.js's own header comment (that comment was wrong —
-- projects.id is uuid; fixed alongside this consolidation).

-- ─── M6: LOOPS + LOOP_DEVICES (per-row commissioning data) ───

create table loops (
  project_id uuid not null references projects(id) on delete cascade,
  id text not null,
  name text not null,
  protocol text default 'MODBUS RTU',
  gateway text default '',
  ddc_ref text default '',
  floor text default '',
  zone text default '',
  color text default '',
  source text default '',
  drawing_id text default '',
  cable_remarks jsonb default '[]'::jsonb,
  position int default 0,
  updated_at timestamptz default now(),
  primary key (project_id, id)
);

create index idx_loops_project on loops(project_id);

create table loop_devices (
  project_id uuid not null references projects(id) on delete cascade,
  id text not null,
  loop_id text not null,
  device_type text default 'DEVICE',
  tag text not null,
  room_name text default '',
  address text default '',
  serial text default '',
  thermostat text default '',
  floor text default '',
  drawing_id text default '',
  comm_cable boolean default false,
  control_cable boolean default false,
  continuity boolean default false,
  termination boolean default false,
  device_installed boolean default false,
  address_set boolean default false,
  remarks text default '',
  position int default 0,
  updated_at timestamptz default now(),
  primary key (project_id, id),
  foreign key (project_id, loop_id) references loops(project_id, id) on delete cascade
);

create index idx_loop_devices_project on loop_devices(project_id);
create index idx_loop_devices_loop on loop_devices(project_id, loop_id);

alter table loops enable row level security;
create policy "Allow all for now" on loops for all using (true) with check (true);
alter table loop_devices enable row level security;
create policy "Allow all for now" on loop_devices for all using (true) with check (true);

-- ─── R2: DOCUMENTS (register, revision/supersede chain) ───

create table documents (
  project_id uuid not null references projects(id) on delete cascade,
  id text not null,
  register_no text default '',
  doc_type text default 'OTHER',
  title text default '',
  floor text default '',
  revision text default 'A',
  seq int default 0,
  supersedes_id text,
  status text default 'RECEIVED',
  file_hash text,
  storage_kind text default 'supabase',
  storage_path text,
  file_name text default '',
  file_type text default '',
  file_size bigint default 0,
  source text default '',
  remarks text default '',
  extracted jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (project_id, id)
);

create index idx_documents_project on documents(project_id);

alter table documents enable row level security;
create policy "Allow all for now" on documents for all using (true) with check (true);

insert into storage.buckets (id, name, public)
  values ('documents', 'documents', false)
  on conflict (id) do nothing;
create policy documents_obj_open on storage.objects
  for all using (bucket_id = 'documents') with check (bucket_id = 'documents');

-- ─── R1: PROGRESS_SNAPSHOTS (trend + forecast history) ───

create table progress_snapshots (
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

create index idx_snapshots_project on progress_snapshots(project_id);

alter table progress_snapshots enable row level security;
create policy "Allow all for now" on progress_snapshots for all using (true) with check (true);

-- ─── PROJECT_BACKUPS (6h auto-snapshot, keep 20) ───

create table project_backups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text,
  version int default 0,
  data jsonb,
  created_at timestamptz default now()
);

create index idx_backups_project on project_backups(project_id);

alter table project_backups enable row level security;
create policy "Allow all for now" on project_backups for all using (true) with check (true);
