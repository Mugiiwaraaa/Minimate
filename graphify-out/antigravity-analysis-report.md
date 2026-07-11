# Minimate — Engineering Analysis & Test Report

This report evaluates the current state, architectural structure, and limitations of the **Minimate (automatex-app)** codebase. It details code quality metrics (lint and build), identifies core limitations across the frontend, backend, and data layers, analyzes the Hermes reports from an engineering perspective, and provides concrete SQL schemas and recommendations to stabilize the application's functionality.

---

## 1. Codebase Verification (Lint & Build Status)

To establish a baseline, static code checks were executed directly on the workspace.

### 1.1 Lint Report (`npm run lint`)
* **Verdict**: **PASS (with warnings)**
* **Tool**: `oxlint` (completed in 73ms across 39 files)
* **Results**: **50 warnings**, 0 errors.
* **Key Findings**:
  - The majority of the 50 warnings are React Hook dependency issues (`react-hooks/exhaustive-deps`).
  - Critical dependencies are missing in `useEffect` arrays in [App.jsx](file:///D:/personal/ControlSystems/automatex-app/src/App.jsx#L248) (such as `setUpdateAvailable`, `setPanels`, `setBlockers`, etc.) and `useCallback` hooks (such as `setEquipmentMap` and `setLoops` at [App.jsx:L562](file:///D:/personal/ControlSystems/automatex-app/src/App.jsx#L562)).
  - While these do not break compiling, they can cause stale closures, unnecessary re-renders, and sync failures in production.

### 1.2 Build Report (`npm run build`)
* **Verdict**: **PASS (with warnings)**
* **Tool**: `vite` + `rolldown` (built in 649ms)
* **Output**:
  - `dist/index.html` (1.00 kB)
  - `dist/assets/index-Cbsv9imI.css` (44.09 kB)
  - `dist/assets/index-B6Y_b0Rd.js` (809.69 kB)
* **Key Warnings**:
  - Vite warned that the bundle size (`index.js` at ~810 kB) exceeds the recommended **500 kB** chunk limit.
  - The large chunk size is due to the lack of code-splitting (lazy loading) across pages like `ReportsPage.jsx` (~77 KB source) and `CommDevices.jsx` (~64 KB source), which are loaded statically at boot time.

### 1.3 Test Suite Status
* **Verdict**: **NOT RUNNABLE**
* **Findings**:
  - No test frameworks (Jest, Vitest, Cypress) are defined in `package.json`.
  - No test files (e.g. `*.test.js` or `*.spec.js`) exist in the codebase.
  - There are no automated quality gates to verify parser accuracy or sync mechanics.

---

## 2. Deep-Dive Limitations: Backend & Database

Although the database layer uses Supabase, the current structure has significant operational and design challenges.

### 2.1 Missing SQL Schemas (Critical Setup Blockers)
The codebase contains a `supabase/schema.sql` file, but it **only defines the `projects` table**. The tables required for core features are either completely missing or only exist as comments inside library files:
* **`documents`**: Schema commented at the top of [docStore.js](file:///D:/personal/ControlSystems/automatex-app/src/lib/docStore.js#L18-L54).
* **`progress_snapshots`**: Schema commented at the top of [reportStore.js](file:///D:/personal/ControlSystems/automatex-app/src/lib/reportStore.js#L7-L22).
* **`project_backups`**: Schema commented at [supabaseDb.js:L429-438](file:///D:/personal/ControlSystems/automatex-app/src/lib/supabaseDb.js#L429-L438).
* **`loops` and `loop_devices`**: **No SQL schema exists anywhere in the codebase.**

> [!WARNING]
> Running the provided `schema.sql` alone will result in silent runtime errors. When the application loads, `loadLoops` attempts to query the `loops` and `loop_devices` tables. Since they do not exist, it triggers a warning in `ensureBackfill` (`[M6] loops table missing? Run the M6 P0 migration.`) and disables all loop syncing.

### 2.2 Fragmented Data Model (Dual-Write Drift)
The application uses a **dual-write model**:
1. It writes the entire project state (panels, equipment, drawings, blockers, etc.) as a single large JSONB document in `projects.data`.
2. It writes loops and devices to normalized tables (`loops` and `loop_devices`) to facilitate multi-user row-level updates.

On project load, the frontend queries `loops` and `loop_devices`, replaces the `loops` array inside the loaded project state, and scrubs the stale copy of `loops` from the project blob. This creates a high risk of database drift. If a row-level upsert fails or fails to sync in time, the project blob and the row-level tables will fall out of sync.

### 2.3 Real-Time Sync & Client-Side 3-Way Merge
* **Key-Press Network Chatter**: State updates are debounced by 1.5s in `supabaseDb.js` before flushing to Supabase. However, in `DocGrid.jsx` and `IoListPage.jsx`, every keypress in an input cell updates the React state immediately. This triggers rapid debounced save requests, causing high network traffic and UI stutter.
* **Client-Side Merging**: If two users save the project concurrently, the Supabase version check rejects the write. The client then pulls the server version, executes a custom **3-way merge on the client side** (`mergeProjectData` in `supabaseDb.js`), and retries. Performing merge logic on the client is error-prone, increases bundle complexity, and exposes the app to race conditions.

---

## 3. Deep-Dive Limitations: Frontend & UX

The application is structured as a Single Page Application (SPA) with intensive client-side processing.

### 3.1 DOM Overload and Lack of Virtualization
In [DocGrid.jsx](file:///D:/personal/ControlSystems/automatex-app/src/components/DocGrid.jsx) and [IoListPage.jsx](file:///D:/personal/ControlSystems/automatex-app/src/pages/IoListPage.jsx), the application renders an editable grid using raw HTML `<table>` elements where **every cell contains an active React `<input>`**:
* If a user imports a typical MEP IO list with 1,000 equipment items and 10 points per item, the DOM will render **10,000+ input fields**.
* React's virtual DOM reconciliation will suffer major lags on every keystroke as it diffs thousands of input elements in the tree.
* There is **no row virtualization** (e.g. `react-window` or `react-virtualized`), which causes the browser to lag or crash on large projects.

### 3.2 Brittle Excel/CSV Parsers
The parsers in `estimateParser.js` and `smartParser.js` rely on hardcoded column indices. For example, `parseIoSummary` expects the quantity in column 2, point descriptions in column 3, and DI/DO/AI/AO indicators on columns 4–9.
* If a subcontractor shifts the columns, inserts an extra column at the beginning, or changes the header text order, the parser will extract incorrect data or fail entirely.
* There is **no schema validation** (e.g. using `Zod` or `Valibot`) before writing parsed data to the state. This allows malformed data to overwrite valid state.

### 3.3 Heavy Browser-Side Operations
* **Single-Threaded Parsing**: Parsing of Word documents (Mammoth.js) and PDFs (PDF.js) is executed on the main UI thread. During parsing, the entire browser tab freezes, creating a poor user experience.
* **Unused Dependencies**: [index.html](file:///D:/personal/ControlSystems/automatex-app/index.html#L12) loads `Tesseract.js` for OCR via a script tag. However, a codebase search confirms **Tesseract is never used** in any Javascript files. This adds unnecessary boot-time network and scripting overhead.
* **Direct Gemini Client Calls**: [geminiClient.js](file:///D:/personal/ControlSystems/automatex-app/src/lib/geminiClient.js) sends API requests directly from the browser to Google's endpoints using an API key stored in `localStorage` (`minimate_gemini_key`). If the site is compromised via XSS, this key is exposed.

### 3.4 Excel Editing Gaps
The "Excel-like" grid lacks standard spreadsheet behaviors:
* No keyboard-based cell navigation (Arrow keys, Tab, Enter).
* No multi-cell range selection or range-fill (drag-to-copy).
* No ability to copy and paste tabular data directly from a desktop application (Excel/Google Sheets) into a range of cells.
* No cell-level undo/redo (it only supports a global state-level undo with a 30-step limit).

---

## 4. Analysis of Hermes' Reports: A Different Perspective

Hermes generated three documents proposing a complete revamp of the application:
1. `Hermes_minimate-test-report.md` (QA review focusing on build, warnings, and safety)
2. `Hermes_product-readiness-report.md` (Product gaps, XSS hazards in graph generation, performance)
3. `Hermes_architecture-revamp-model.md` (Architectural target model)

### 4.1 Comparison of Perspectives

| Vector | Hermes' Revamp Proposal | Our Pragmatic Engineering Perspective |
| :--- | :--- | :--- |
| **Backend** | Proposes writing a complete Node/Express/tRPC API backend with Prisma and Docker containerization. | Adding a backend adds heavy deployment overhead. Since the user wants to polish current functions and is holding back on Auth/RLS, we should keep the serverless Supabase setup but fix the database schema, data models, and sync paths. |
| **Data Safety** | Proposes an **OpLog / Draft-Revision** model (shadow tables, commit/approve workflows). | Correct for auditability, but extremely high complexity. A simpler approach is to implement client-side input throttling, transaction batches, and soft-locking during editing sessions. |
| **Excel Grid** | Recommends replacing the custom grids with AG Grid. | **Agreed.** Custom HTML tables with thousands of `<input>` elements are unusable for real-world projects. AG Grid (or a lightweight virtualized grid) resolves both the performance (virtualization) and usability (copy-paste, keyboard navigation) issues. |
| **Security** | Recommends immediate removal of localStorage key storage and shifting all AI logic to backend routes. | Moving key storage to backend is a best practice. However, if the app remains an offline-first SPA, the client-key model can be retained but warning indicators should be added to explain key exposure risks to the user. |

---

## 5. Completed SQL Schema (Missing Tables)

To address the critical setup issues, the SQL schema below compiles all the missing tables (`documents`, `progress_snapshots`, `project_backups`, `loops`, and `loop_devices`) into a single file. 

> [!IMPORTANT]
> This schema matches the types and indices expected by `loopStore.js`, `docStore.js`, `reportStore.js`, and `supabaseDb.js`. It includes cascaded deletes to ensure database integrity.

```sql
-- ============================================================
-- Minimate — Complete Database Schema (Missing Tables)
-- Run this in Supabase SQL Editor to enable all functions
-- ============================================================

-- 1. LOOPS TABLE
CREATE TABLE IF NOT EXISTS public.loops (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT DEFAULT 'MODBUS RTU',
  gateway TEXT DEFAULT '',
  ddc_ref TEXT DEFAULT '',
  floor TEXT DEFAULT '',
  zone TEXT DEFAULT '',
  color TEXT DEFAULT '',
  source TEXT DEFAULT '',
  drawing_id TEXT DEFAULT '',
  cable_remarks JSONB DEFAULT '[]'::jsonb,
  position INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_loops_project ON public.loops(project_id);

-- 2. LOOP DEVICES TABLE
CREATE TABLE IF NOT EXISTS public.loop_devices (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  loop_id TEXT NOT NULL,
  device_type TEXT DEFAULT 'DEVICE',
  tag TEXT NOT NULL,
  room_name TEXT DEFAULT '',
  address TEXT DEFAULT '',
  serial TEXT DEFAULT '',
  thermostat TEXT DEFAULT '',
  floor TEXT DEFAULT '',
  drawing_id TEXT DEFAULT '',
  comm_cable BOOLEAN DEFAULT false,
  control_cable BOOLEAN DEFAULT false,
  continuity BOOLEAN DEFAULT false,
  termination BOOLEAN DEFAULT false,
  device_installed BOOLEAN DEFAULT false,
  address_set BOOLEAN DEFAULT false,
  remarks TEXT DEFAULT '',
  position INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, loop_id) REFERENCES public.loops(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_loop_devices_project ON public.loop_devices(project_id);
CREATE INDEX IF NOT EXISTS idx_loop_devices_loop ON public.loop_devices(project_id, loop_id);

-- 3. DOCUMENTS TABLE
CREATE TABLE IF NOT EXISTS public.documents (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  register_no TEXT DEFAULT '',
  doc_type TEXT DEFAULT 'OTHER',
  title TEXT DEFAULT '',
  floor TEXT DEFAULT '',
  revision TEXT DEFAULT 'A',
  seq INT DEFAULT 0,
  supersedes_id TEXT,
  status TEXT DEFAULT 'RECEIVED',
  file_hash TEXT,
  storage_kind TEXT DEFAULT 'supabase',
  storage_path TEXT,
  file_name TEXT DEFAULT '',
  file_type TEXT DEFAULT '',
  file_size BIGINT DEFAULT 0,
  source TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  extracted JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_project ON public.documents(project_id);

-- 4. PROGRESS SNAPSHOTS TABLE
CREATE TABLE IF NOT EXISTS public.progress_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  snapped_at TIMESTAMPTZ DEFAULT now(),
  total INT DEFAULT 0,
  comm INT DEFAULT 0,
  ctrl INT DEFAULT 0,
  cont INT DEFAULT 0,
  term INT DEFAULT 0,
  inst INT DEFAULT 0,
  addr INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_snapshots_project ON public.progress_snapshots(project_id);

-- 5. PROJECT BACKUPS TABLE
CREATE TABLE IF NOT EXISTS public.project_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT,
  version INT DEFAULT 0,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backups_project ON public.project_backups(project_id);

-- ============================================================
-- DISABLE ROW-LEVEL SECURITY POLICIES FOR DEVELOPMENT
-- ============================================================
ALTER TABLE public.loops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loop_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.progress_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_backups ENABLE ROW LEVEL SECURITY;

CREATE POLICY loops_open ON public.loops FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY loop_devices_open ON public.loop_devices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY documents_open ON public.documents FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY progress_snapshots_open ON public.progress_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY project_backups_open ON public.project_backups FOR ALL USING (true) WITH CHECK (true);
```

---

## 6. Recommendations for Function Polish

To make the current application functions "perfect" before enabling Auth/RLS, focus on these five targeted code improvements:

1. **Clean up index.html Script Bloat**:
   Remove `Tesseract.js` from `index.html` to reduce unused network overhead.
2. **Debounce Grid Typing Handlers**:
   In `DocGrid.jsx` and `IoListPage.jsx`, do not trigger the global `onChange` on every keypress. Instead, hold cell modifications in a local component state and flush them to the parent project state only when the user presses **Enter**, **Tab**, or clicks away (**blur**). This stops network stuttering.
3. **Add React Window / Virtualization to Grids**:
   Implement a lightweight virtualization container for `DocGrid` and `IoListPage` so that only the visible rows are mounted in the browser DOM.
4. **Resolve Lint Hook Dependency Warnings**:
   Update dependency arrays in `useEffect` and `useCallback` hooks inside `App.jsx` to prevent memory leaks and stale state evaluations.
5. **Add Web Workers for File Parsers**:
   Offload Mammoth.js, PDF.js, and SheetJS parsing logic into browser Web Workers so the UI remains active and responsive during imports.
