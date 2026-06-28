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
