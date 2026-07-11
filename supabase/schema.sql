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
