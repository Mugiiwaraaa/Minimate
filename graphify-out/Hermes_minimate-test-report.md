# MINIMATE / automatex-app — Application Test Report
## Prepared as an engineering QA review
## Date: 2026-07-09
## Branch: main
## Verified by: Hermes Agent
## Scope: Current working tree on `D:\personal\ControlSystems\automatex-app`

---

## 1. Test Execution Summary

| Test Area | Command / Method | Verdict |
|----------|------------------|---------|
| Lint | `npm run lint` | PASS with 50 warnings |
| Build | `npm run build` | PASS with 1 chunk-size warning |
| Unit tests | none discoverable | NOT EXECUTABLE — no test runner/tests present |
| Integration/API smoke tests | Supabase configs not enabled for review | NOT EXECUTABLE — requires live env |
| Runtime smoke | Browser run | NOT EXECUTED in this pass; static code path review performed |

---

## 2. Evidence: Lint & Build

```
> npm run lint
Found 50 warnings and 0 errors.

> npm run build
vite v8.1.0 building client environment for production...
dist/index.html                   1.00 kB
dist/assets/index-Cbsv9imI.css   44.09 kB
dist/assets/index-B6Y_b0Rd.js   809.69 kB
```

Build completes, but `index.js` exceeds 500 kB after minification; Vite warns to add code-splitting.

---

## 3. Scope of Review (Codebase Paths Read)

- `package.json`, `vite.config.js`, `.env.example`
- `src/App.jsx`, `src/main.jsx`, `src/index.css`, `src/App.css`
- `src/pages/*` — Dashboard, PanelsList, PanelDetail, CommDevices, DrawingsPage, BlockersPage, ReportsPage, DocumentsPage, IoListPage, ProjectSelector
- Components: `Sidebar.jsx`, `TraceStudio.jsx`, `GlobalImport.jsx`
- Libraries: `supabaseDb.js`, `loopStore.js`, `reportStore.js`, `smartParser.js`, `estimateParser.js`, `terminationParser.js`, `drawingParser.js`, `geminiClient.js`, `importEngine.js`, `docStore.js`, `fileStore.js`

---

## 4. Findings

### 4.1 Build Quality
- ✅ `npm run build` succeeds.
- ⚠️ Bundle size ~809 kB; no dynamic imports detected in review.
- ⚠️ Oxlint found 50 warnings but no errors.

### 4.2 Product & Architecture
- ✅ Functional structure for design projects, panels, equipment, IO, DB termination, drawing/trace studio, reports, and document register exists.
- ⚠️ Most logic is concentrated in `src/App.jsx` (~1.8k lines), increasing defect risk and maintenance cost.
- ⚠️ Data is split across blob project state + Supabase rows for loops/devices without a unified schema contract.
- ⚠️ No observed API backend for sensitive operations; business logic runs in the browser.

### 4.3 Data Safety / Editing Model (Critical)
- ✅ Current import flow has preview + exclusion before write; good safety behavior.
- ⚠️ “Edit in place” paths in reports/docs are not isolated behind draft revisions based on current code paths reviewed.
- ⚠️ Document/data edits can mutate current state directly without a reviewed approval and diff workflow.

### 4.4 Security & Secrets
- ⚠️ `localStorage.setItem('minimate_gemini_key', ...)` stores AI API key in browser storage (`App.jsx:984-987`, rendering modal path around `1300-1304`).
- ⚠️ There is no evidence of server-side secret handling for AI/workflow operations.
- ⚠️ `.env` usage suggests secrets may live in envs, but auth/RBAC posture wasn’t verified beyond Supabase presence.

### 4.5 Multi-user / Realtime Behavior
- ✅ Loop row sync has diff + retry behavior in `loopStore.js`.
- ⚠️ Backfill path still exists; old blob-copy loops are written without loops on project load if `data.loops` was non-empty.
- ⚠️ Race/merge behavior around `scheduleLoopOrderRefresh` and `isOwnEcho` is complex and should have explicit tests.

### 4.6 Testing
- ❌ No test frameworks or test files present.
- ❌ No CI workflow observed.
- ❌ No automated smoke tests for import, parser, merge, drawing analysis, report generation.

### 4.7 Performance
- ⚠️ Large virtualized tables/report grids exist but could degrade on low-end browsers.
- ⚠️ Heavy `setState` chains and large in-memory arrays in `App.jsx` review suggest need for profiling and code-splitting.

### 4.8 Product Completeness vs Your Request
- ✅ Covers project setup, design import, panel/IO/equipment editing, drawing/trace, daily progress-like reporting columns.
- ⚠️ Tracked modules for “cable installed vs design,” “material inventories,” “inspection/MIR workflow,” “commissioning verification” are suggested in code but incomplete or partially mocked.
- ❌ No test evidence that reports accurately compute installed-vs-design variance across cable takeoffs.

---

## 5. Risk Map

| Risk | Severity | Probability | Mitigation Priority |
|------|----------|-------------|---------------------|
| Gemini key exposure in localStorage | HIGH | Confirmed | Immediate |
| No unit/integration tests | HIGH | Confirmed | Immediate |
| Monolithic state mutations in App.jsx | MEDIUM-HIGH | Confirmed | Short-term |
| Large bundle / slow cold load | MEDIUM | Confirmed | Medium |
| Revision/draft edits mutating production data | MEDIUM-HIGH | Likely | Immediate |
| Unverified report math / variance logic | MEDIUM | Likely | Medium |

---

## 6. Recommended Immediate Actions

1. Move Gemini key handling to backend and rotate any exposed keys.
2. Add test runner and write 20-30 baseline tests covering:
   - import preview confirmation/exclusions
   - parser edge cases
   - loop diff + sync
   - report basic aggregations
3. Reduce `App.jsx` complexity via feature extraction.
4. Add chunking / route-level lazy imports.
5. End-to-end verify report calculations for cable/device variances before commissioning use.

---

*End of test report.*
