# automatex-app — Product Readiness Report
## Scope
Business-model / production-readiness review based on the source codebase and the generated `graphify-out/graph.html` artifact.

## Executive Summary
The app is a usable control-system automation frontend with genuine features: document/IO management, device browsing, import engines, reports, and a graph visualization generator. However, it is not yet production-ready in several structural areas: data/model boundaries, backend/API layer, security, test coverage, observability, deploy hardening, and packaging.

---

## 1. Important Limitations

### 1.1 Architecture / Data Layer
- `src/lib/supabaseDb.js` and `src/lib/supabase.js` indicate the intended persistence layer is Supabase, but there is no visible migration/schema versioning, RLS policies, or seeding story.
- `docStore.js`, `loopStore.js`, `reportStore.js`, `fileStore.js` suggest local/component state stores without a clear data contract; likely inconsistent fields and missing normalization.
- `smartParser.js`, `estimateParser.js`, `terminationParser.js`, `drawingParser.js` imply heavy client-side parsing; no evidence of streaming/worker-based parsing for large uploads.
- `importEngine.js` is likely a flat import pipeline; unclear whether it handles partial failures, idempotency, or cursor-based resume.

### 1.2 Security
- `.env` exists and is not shown here for safety, but repo review should confirm `.env` is gitignored.
- Client-side gemini/key handling: `geminiClient.js` likely talks to AI APIs directly from the browser, which risks key exposure unless restricted to a backend proxy or signed requests.
- No visible auth flow, session hardening, or RBAC on routes/pages.

### 1.3 Reliability & Testing
- No tests directory visible; no test scripts in `package.json` snapshot provided.
- The generated artifact `graphify-out/graph.html` is a standalone snapshot with inline RAW data — not a robust unit-of-work; downstream consumers expecting data fidelity would need schema validation.

### 1.4 UX / Scalability
- `vis-network` standalone bundle loaded from unpkg: vendor/vendor-sprawl risk, and large inline `RAW_NODES`/`RAW_EDGES` payload for big exports.
- Sidebar/info panel UI is functional but lacks empty/loading/error states for missing node metadata.
- No offline support or caching strategy observed.

### 1.5 Deployment
- Build output exists in `/dist`, but no containerization, CI/CD, environment configs, or health endpoints were identified.

---

## 2. Immediate Polishing Checklist

### Product
1. Define a clear product boundary: control-system data entry vs. AI analysis vs. reporting. Fewer verticals done well beats many half-done modules.
2. Standardize data models first: one canonical shape for devices, panels, IOs, documents, drawings, estimates, reports.
3. Replace ad-hoc local stores with a single state/repository layer and typed interfaces.

### Code Quality
1. Add strict TypeScript or at least runtime schema validation for imports/exports (`zod`/`valibot`).
2. Split parsers into workers for CAD/photo analysis to avoid blocking the UI.
3. Centralize API clients; remove direct browser-to-AI-key patterns.
4. Add logging/error boundary utilities and user-facing toast/error states.

### Performance
1. Chunk/paginate large node lists in graph exports.
2. Add `vis-network` data deduplication and edge/weight heuristics to reduce overdraw.
3. Lazy mount heavy pages (`DrawingsPage`, `ReportsPage`) and images.

### Security Hardening
1. Rotate/validate `.env` values; verify `.env` is ignored.
2. Move AI calls to a backend route with usage limits and audit logging.
3. Add auth middleware, row-level security, and route guards.

### Operations
1. Add automated tests for parsers and import engine.
2. Add a CI pipeline: lint, build, deploy.
3. Instrument error and performance metrics for production graphs/corpus ingestion.

---

## 3. Recommended Roadmap

Phase 1 — Stabilize Core
- Fix store contracts and form validation.
- Add E2E smoke tests for import + graph export + reports.
- Hardn auth/env secrets.

Phase 2 — Scale
- Worker-based parsing, streaming imports.
- Backend proxy for compute/AI.
- Real database migrations and RLS.

Phase 3 — Productionize
- Container + env profiles + health checks.
- Observability + feature flags.
- Pricing/usage metrics if monetizing.

---

## 4. Graphify Artifact Notes
`graphify-out/graph.html` demonstrates end-to-end embedding, search, inspection, and community filtering. To make it production-grade:
- parameterize `RAW_NODES`/`RAW_EDGES` via JSON fetch instead of inline script.
- validate size budgets (>150KB inline indicates large corpus needs pagination).
- add accessibility: keyboard navigation + reduced motion + ARIA labels.

## 5. Risk Summary
1. AI/key exposure risk if gemini client remains browser-side.
2. Data contract drift as parsers grow, causing silent bad imports.
3. Frontend-only architecture becoming a scaling ceiling sooner than expected.
4. No observed test coverage; failures will compound as modules touch shared stores.

---

## Nitty-Gritty Code-Level Issues

### 6.1 Graph Export Safety / XSS
`showInfo()` builds HTML with node labels. The `esc()` helper mitigates obvious XSS, but hyperedge labels, regex patterns, and edge tooltips can still inject unsafe content if upstream data is not sanitized.

### 6.2 Data Accuracy in Graphs
With `RAW_NODES` embedded inline, graph exports will become huge and brittle. This couples visualization to bundle size and exposes repo structure rather than actionable domain state.

### 6.3 Search UX Gaps
- No debounce on search input; large corpora will create UI jank.
- Search only matches labels; missing path/type/community filters.
- No keyboard selection within search results.

### 6.4 Maintenance Maintainability
- Inline constants in HTML prevent reusability; build graphify as a separate package/module.
- Community hiding uses `hidden: true` which leaves edges/orphans; better to collapse subgraph or dim with opacity transitions.

### 6.5 Observability
No error handling for failures in network stabilization, missing nodes in `focusNode()`, or invalid `RAW_NODES` entries; debugging in production will be painful.

---

*Report generated for internal review.*
