# automatex-app — Architecture Revamp Model
## Prepared by: Hermes Agent
## Scope
End-to-end architectural redesign for a full engineering-to-commissioning control systems management platform, incorporating business requirements, current codebase reality, `graphify-out` artifact findings, Excel-like editable documents, and non-destructive data editing guarantees.

## Document Structure
1. Business Context & Requirements
2. Current-State Assessment
3. Risks & Limitations
4. Target Architecture
5. Immutable Data & Non-Destructive Editing Strategy
6. Excel-like Document Editing Engine
7. Privacy/Security Posture
8. Deployment & Operations Architecture
9. Migration Path (Zero Data Loss)
10. Roadmap
11. Open Questions

---

## 1. Business Context & Requirements

### 1.1 Product Vision
A unified engineering management platform for control systems projects spanning:
- Engineering design import and versioning
- BOQ, materials, and cable takeoff reconciliation
- IO point engineering, loop tracing, and DDC termination
- Site installation tracking (daily tasks, manhours, materials installed vs design)
- Inspection, MIR, punch lists
- Commissioning verification and handover
- Reporting by area, device, discipline, and phase

### 1.2 Functional Pillars
| Pillar | Description |
|--------|-------------|
| Project Workspace | Tenant/project isolation, roles, audit |
| Design Engineering | Drawing import, IO list, cable schedule, termination schedules |
| Document Editing | Excel-like editing with validation, multi-select, drag/copy paste |
| Variation Control | Revision snapshots, diffs, approval workflow |
| Installation | Daily logs, area breakdown, device install verification |
| Inventory/Materials | BOQ vs issued vs installed variance tracking |
| Inspection & MIR | Checklists, deficiency tracking, material issue requests |
| Commissioning | IO verification, loop addressing, DDC panel termination checks |
| Reporting | Weekly, area-wise, device-wise, floor-wise, IO completion |
| Visualization | `graphify`-style dependency/community maps |

### 1.3 Non-Functional Requirements
- **Data safety**: All edits must be non-destructive against current production data.
- **Performance**: Large project corpora (>100k nodes in exports) must degrade gracefully.
- **Offline readiness**: Field supervisors with unreliable connectivity.
- **Auditability**: Every change traceable to user, timestamp, and revision.
- **Scalability**: Multi-project, multi-role, multi-site.

---

## 2. Current-State Assessment

### 2.1 Observed Strengths
- Functional SPA with practical modules: IO list, documents, panels, devices, reports.
- Demonstrated visualization capability in `graphify-out/graph.html`.
- Integration scaffolding exists for Supabase.
- Document store and import engine already present.

### 2.2 Critical Weaknesses
1. **No backend API layer**: All business logic currently lives in the browser.
2. **Flat local stores**: `docStore`, `loopStore`, `reportStore`, `fileStore` lack contracts and normalization.
3. **Direct AI access**: `geminiClient.js` implies browser-to-model keys — exposure risk.
4. **No revision/versioning**: Editing documents or BOQ can corrupt production data.
5. **No tests**: No observable quality gate for parsers or import logic.
6. **Monolithic frontend**: `src/pages/` structure prevents incremental scaling.
7. **Packaging gap**: `graphify-out` emits inline HTML with raw data — not parameterized.

---

## 3. Risks & Limitations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Browser-side AI key compromise | Data breach | High | Backend proxy + env secrets |
| Accidental edit overwrites production | Wrong BOQ/IO sent to site | Medium-High | Immutable revisions + draft editing mode |
| Large exports break UI | Memory/CPU crash | Medium | Virtualization, workers, pagination |
| Parser drift causing silent bad imports | Wrong cable lengths/IO | Medium | Zod validation + typed schemas |
| Supabase-only scaling ceiling | Vendor lock / cost | Medium | Abstract repository now |
| No test coverage | Regressions creep | High | Add unit + E2E early |
| Multi-user editing conflict | Data loss | Medium | Optimistic locking, draft queue |
| Offline sync gaps | Incomplete daily logs | Medium | TanStack Query persistence + sync queue |

---

## 4. Target Architecture

### 4.1 High-Level Topology
```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend (React/TS)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ TanStack Query│  │   Zustand    │  │ Excel Editing Eng │ │
│  │ (server cache)│  │ (UI ephemeral)│  │ (grid + ops layer)│  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘  │
│         │                 │                     │            │
│  ┌──────▼─────────────────▼─────────────────────▼──────────┐ │
│  │              tRPC Client / Fetch Layer                   │ │
│  └──────────────────────────┬──────────────────────────────┘ │
│                              │ HTTPS                           │
├──────────────────────────────▼───────────────────────────────┤
│                      Backend API (Node/TS)                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐  │
│  │   tRPC /   │  │  S3 Upload │  │    Background Workers  │  │
│  │  Express   │  │  Handlers  │  │ (parsers, PDF gen)     │  │
│  └────┬───────┘  └────┬───────┘  └───────────┬────────────┘  │
│       │               │                      │                │
│  ┌────▼───────────────▼──────────────────────▼────────────┐  │
│  │                    Service Layer                        │  │
│  │  VariationEngine, IOMapper, BOQRecon, TermValidator     │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│                             │                                 │
│  ┌──────────────────────────▼─────────────────────────────┐  │
│  │                  Repository Layer                      │  │
│  │              (Prisma → PostgreSQL)                      │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
              ┌────────────────────────┐
              │   Object Storage + CDN │
              │   (MinIO / S3)        │
              └────────────────────────┘
```

### 4.2 Monorepo Layout

```
automatex-app/
  packages/
    app/                   # React frontend
    api/                   # Backend (tRPC or Express)
    shared/                # Zod schemas, types, constants
    parsers/               # Import parsers (isolated, testable)
  infra/
    docker-compose.yml
    Dockerfile.api
    Dockerfile.app
    fly.toml / vercel.json
  scripts/
    migrate.sh
    seed.sh
    graphify-export.ts
```

### 4.3 Domain Boundaries

| Bounded Context | Location | Public API |
|-----------------|----------|------------|
| Project Workspace | `packages/api/src/project` | CRUD + members |
| Engineering | `packages/api/src/engineering` | Revision, IO, Termination, Cable |
| Documents | `packages/api/src/documents` | Import, version, query grid |
| Inventory | `packages/api/src/inventory` | BOQ, Material, IssueLog |
| Installation | `packages/api/src/installation` | WorkPkg, DailyLog, DrawingOverlay |
| Inspection | `packages/api/src/inspection` | Checklist, MIR, Deficiencies |
| Commissioning | `packages/api/src/commissioning` | IOVerify, TerminationCheck |
| Reporting | `packages/api/src/reporting` | Templates, PDF/Excel export |
| Files | `packages/api/src/files` | Upload, download, thumbnails |

---

## 5. Immutable Data & Non-Destructive Editing Strategy

This is the single most important architectural decision to protect production data.

### 5.1 Principles
1. **Revisions are immutable snapshots.** Once a `DesignRevision` reaches status `APPROVED`, it can never change.
2. **Edits live in Drafts.** Users edit in an isolated sandbox tied to a revision.
3. **Nothing overwrites approved state without a new Revision and explicit approval.**
4. **Shadow/Draft tables for mutable workspace state** during bulk editing.

### 5.2 Document Editing Model

```ts
// User opens documents page → system creates an editable Draft
interface EditDraft {
  draftId: string
  authorId: string
  sourceRevisionId: string   // approved revision being edited
  status: 'open' | 'submitted' | 'approved' | 'discarded'
  tableVersions: DraftTableVersion[]
  createdAt: timestamp
}

interface DraftTableVersion {
  tableId: string
  snapshot: Cell[][]       // full snapshot at draft creation
  ops: OpLog[]             // applied user ops
  appliedHash: string      // SHA of snapshot+ops
}
```

### 5.3 Operation Log (OpLog)
Every user action appends an op. Ops are replayed to compute current state from snapshot.

```ts
type Op =
  | { type: 'cell_update'; row: number; col: number; oldValue: any; newValue: any }
  | { type: 'row_insert'; index: number; cells: any[] }
  | { type: 'row_delete'; index: number }
  | { type: 'col_insert'; index: number; header: string }
  | { type: 'col_delete'; index: number }
  | { type: 'row_copy'; from: number[]; to: number }
  | { type: 'range_paste'; topLeft: {row,col}; data: Cell[][] }
  | { type: 'bulk_update'; updates: Array<{row,col,newValue}> }
```

Benefits:
- Full audit trail of what changed.
- Undo/redo via op replay.
- Conflict detection via version vector.
- Safe merging after approval review.

### 5.4 Approval Flow
1. Engineer works in Draft.
2. Submits Draft for approval.
3. Reviewer sees diff against source `DesignRevision`.
4. If approved → system creates new `DesignRevision` from Draft state + sets as current.
5. If rejected → Draft returned with comments; source revision unchanged.

### 5.5 Excel-like Editor Architecture
Frontend: AG Grid or custom canvas/grid engine with ops collector.

```
ExcelEditor
├── VirtualGrid           // renders only visible rows/cols
├── SelectionManager      // multi-select, range copy/paste
├── KeyboardHandler       // shortcuts (Ctrl+C/V/X, arrows, Tab, Enter, Ctrl+Z/Y)
├── OpCollector           // converts user actions → OpLog
├── ValidationLayer       // per-cell schema validation
├── ConflictResolver      // for concurrent edits (draft conflict)
└── Toolbar               // copy/paste/drag/cut/filter/sort
```

Key behaviors:
- **Drag/copy**: row/column drag clones cells; all expressed as ops.
- **Multi-select**: range operations emit one bulk op.
- **Paste**: Excel-like TSV/cell-range paste; validated before applying.
- **Filter/Sort**: reorder rows; reorder expressed as row index ops.
- **Undo/Redo**: maintained as pointer into op log.
- **Validation**: invalid cell retains old valid value, emits error marker, does not emit destructive op.

---

## 6. Excel-like Document Editing Engine (Deep Dive)

### 6.1 Editor Requirements
- 50,000+ rows smooth scroll (virtualization mandatory).
- Multi-column/row selection.
- Ctrl/Cmd-click range selection.
- Drag to copy cells.
- Keyboard shortcuts: Ctrl+C/V/X/Z/Y/Arrow/Tab/Enter/Delete.
- Formula support (optional in v1, but keep extension point).
- Import/export to Excel/CSV preserving formulas/styling.

### 6.2 State Machine
```
IDLE → EDITING → SUBMITTED → (APPROVED | REJECTED)
                ↓
            DISCARDED
```
- `EDITING` state collects ops against draft snapshot.
- Autosave draft every N ops or seconds.
- Draft version vector prevents merge conflicts.

### 6.3 Conflict Resolution
Because users may edit same table concurrently:
- Draft snapshot locked at creation; only ops accepted.
- On submit, server validates op log against base snapshot.
- If base changed (rare since source is immutable), server rejects with optimistic lock; user rebases on current approved revision and re-applies.
- For same-draft collaboration, last-write-wins with user notification of merged changes.

### 6.4 Data Accuracy Guarantee
- **Nothing touches `DesignRevision` tables directly.** Only the approval path writes immutable snapshots.
- **All updates are append-only op logs.** Deletions append a tombstone op.
- **Read path is deterministic**: snapshot + ops → view.
- **Server never mutates user edits in place** — only compacts op logs into new snapshots during approval.

---

## 7. Privacy/Security Posture

### 7.1 Secrets & Keys
- All AI/API keys in backend env; never in frontend.
- Supabase Auth recommended for identity; backend enforces project roles.
- S3 presigned URLs for uploads; backend validates project membership before issuing.

### 7.2 Auth & RBAC
```ts
enum Role { SuperAdmin, ProjectEngineer, SiteSupervisor, QC, Viewer }
const permissions: Record<Role, string[]> = {
  SuperAdmin: ['*'],
  ProjectEngineer: ['project.edit','revision.approve','document.import','report.read'],
  SiteSupervisor: ['installation.edit','drawing.mark','dailyLog.edit'],
  QC: ['inspection.edit','mir.raise','commissioning.verify'],
  Viewer: ['project.read','report.read'],
}
```

### 7.3 Row-Level Access
- Every table scoped by `projectId`.
- Repository layer injects `projectId` from session context automatically.
- Cross-project queries forbidden at service boundary.

### 7.4 Audit Log
```ts
interface AuditEntry {
  actorId: string
  action: string
  entity: string
  entityId: string
  projectId: string
  before?: any
  after?: any
  timestamp: Date
}
```
- Immutable append-only table.
- Exposed in web UI and report exports.

---

## 8. Deployment & Operations Architecture

### 8.1 Environments
- `dev` — feature branches deploy to preview.
- `staging` — mirrors prod with synthetic data; all reports validated weekly.
- `prod` — no direct DB writes except via backend API.

### 8.2 CI/CD Pipeline
1. `pnpm install` + cache.
2. `pnpm lint` + `pnpm typecheck`.
3. `pnpm test --coverage` (unit + integration).
4. `docker build` app + api.
5. Push to registry.
6. Deploy API to Fly/ECS/Render.
7. Deploy app to Vercel/Cloudflare Pages.
8. Run DB migrations in staging + smoke tests.
9. Prod rollout with canary (10% traffic, 30m).

### 8.3 Observability
- Structured JSON logs (pino) with `projectId`, `draftId`, `revisionId`.
- Error tracking (Sentry).
- Metrics: API latency, upload duration, parser job count, active drafts.
- Weekly report generation jobs visible in admin dashboard.

### 8.4 Container Stack
```
services:
  api:
    build: ./packages/api
    env: [DATABASE_URL, S3_*, AUTH_*]
    ports: [3001]
    deploy: replicas 2, autoscaling on CPU > 60%
  app:
    build: ./packages/app
    env: [VITE_API_URL]
    deploy: static hosting, CDN
  worker:
    build: ./packages/parsers
    env: [DATABASE_URL, S3_*]
  db:
    image: postgres:16
    volume: db-data
  s3:
    image: minio/minio
```

---

## 9. Migration Path (Zero Data Loss)

### Phase 0 — Audit & Baseline
- Inventory all local stores, Supabase tables, and file formats.
- Export snapshots of all projects.
- Freeze schema changes; document current fields.

### Phase 1 — Backend Skeleton
- Stand up API + Prisma + Postgres.
- Implement `Project`, `User`, `Role`.
- Reproduce one page (e.g., `IoListPage`) against backend.
- Feature flags allow running old/new code in parallel.

### Phase 2 — Document Editing Sandbox
- Implement draft + op log storage.
- Wire grid editor.
- All legacy document reads now served through draft-aware API.

### Phase 3 — Revision Migration
- Move all approved documents/revisions into immutable schema.
- Backfill op logs from current state for audit continuity.

### Phase 4 — Parser Migration
- Move each parser (`smartParser.js`, `estimateParser.js`, etc.) to `packages/parsers`.
- Validate every output against shared Zod schema.
- Deprecate old `lib/` parsers only after 2 green test runs.

### Phase 5 — Frontend Feature Folders
- Migrate page-by-page to feature folders under `packages/app/src/features`.
- Each feature independently deployable via route-level code split.

### Phase 6 — Graphify Re-architecture
- Move graph generation to backend worker.
- Frontend calls `/reports/graph/:projectId?rev=...`.
- Returns parameterized JSON and presigned assets; no inline RAW arrays.

### Phase 7 — Hardening & Scale
- Add tests for approval flow and op log compaction.
- Load test weekly report generation.
- Enable offline sync queue for mobile supervisors.

---

## 10. Roadmap

| Phase | Duration | Deliverable | Success Metric |
|-------|----------|-------------|----------------|
| 0 | 2 weeks | Audit + schema plan | Baseline snapshot captured |
| 1 | 4 weeks | Backend skeleton + IoList | Old/new parity for IO list |
| 2 | 6 weeks | Excel editor + Draft API | Edits survive refresh; approved state unchanged |
| 3 | 4 weeks | Revision migration + approval UI | 100% of projects rehydrated |
| 4 | 4 weeks | Parsers in workers | Import accuracy same or better |
| 5 | 6 weeks | Feature folder restructuring | No regression in page behavior |
| 6 | 3 weeks | Graphify as service | Graph export parameterized, no inline |
| 7 | Ongoing | Tests + offline + CI | Coverage >70%, zero data incidents |

---

## 11. Open Questions / Decisions Needed

1. **AI strategy**: Which AI workflows are essential in v1 (image analysis, OCR, parsing)? Define scope and backend proxy needs.
2. **Multi-tenancy**: Are all users in one project or are there customers/projects? Define tenancy model.
3. **File formats**: Which CAD/PDF formats must be supported? DWG/DXF viewer integration required?
4. **Offline priority**: Is field offline top priority or can initial launch be online-first with caching later?
5. **Monetization**: Will report generation and storage drive costs? Budget storage early.
6. **Editor fidelity**: Is Excel formula support required, or value-only editing sufficient?
7. **Compliance**: Any regulatory requirements (ISO 9001, client QA procedures) that dictate audit trail persistence or retention?
8. **Data migration source**: Is the current Supabase state the source of truth, or is there an export from legacy systems?

---

## 12. Appendix: Current Codebase Health Snapshot

| Area | Rating | Notes |
|------|--------|-------|
| Frontend modularity | Low | `src/pages/` flat; mixed concerns |
| Data contracts | Low | No shared schemas across parsers |
| Security | Medium | Supabase present; AI keys unknown |
| Reliability | Low | No tests; imports lack schema validation |
| Document editing | Medium | `docStore` + grid exists; lacks Excel behaviors |
| Visualization | Medium-High | `graphify` works; not structuralized |
| Deployment | Low-Medium | Vite build exists; no CI/CD or containers |
| Backup/Restore | Unknown | No evident export/policy |

---

## 13. Recommended Immediate Decisions (This Week)

1. Appoint product owner for `DesignRevision + Variation` module.
2. Decide backend framework: tRPC vs Express.
3. Decide editor: AG Grid vs custom.
4. Decide auth: Supabase Auth vs custom JWT.
5. Choose reporting format: PDF (Puppeteer) vs Excel (Excalidraw/SheetJS) vs both.
6. Define rollback policy: approved revision never mutates; drafts discarded.

---

*End of report.*
