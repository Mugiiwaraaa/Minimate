# Graph Report - D:\personal\ControlSystems\automatex-app  (2026-07-08)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 310 nodes · 605 edges · 23 communities (17 shown, 6 thin omitted)
- Extraction: 96% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 21 edges (avg confidence: 0.64)
- Token cost: 1,056 input · 181 output

## Graph Freshness
- Built from commit: `dcb5c29f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- App Core & Device Sidebar
- App Entry & UI Components
- AI Image & CAD Analysis
- Loop Device Store
- Project Dependencies
- Document Store & Registry
- Estimate & BOQ Parser
- Trace Studio File Tools
- Global Import & Sheet Classification
- Smart Document Parser
- Reports & Progress Forecasting
- Drawing Parser & Gemini Integration
- Comm Devices Stage UI
- Document & IO List Pages
- Lint Configuration Rules
- Vercel Routing Config
- App Favicon Asset
- SVG Icons Sprite
- React Logo Asset
- Vite Logo Asset
- Tailwind CSS Theme

## God Nodes (most connected - your core abstractions)
1. `App.jsx Main Application` - 16 edges
2. `smartParse()` - 11 edges
3. `cS()` - 10 edges
4. `callGeminiWithImage()` - 9 edges
5. `ReportsPage()` - 9 edges
6. `isNumStr()` - 8 edges
7. `toNum()` - 8 edges
8. `up()` - 8 edges
9. `App()` - 7 edges
10. `GlobalImport()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `README - React + Vite Template` --references--> `App.jsx Main Application`  [INFERRED]
  README.md → src/App.jsx
- `Annotated Building Floor Plan with Highlighted Cable Routing Loops` --conceptually_related_to--> `Smart Excel Parser`  [AMBIGUOUS]
  20260413_112718.jpg.jpeg → src/lib/smartParser.js
- `Minimate Setup Guide` --references--> `Supabase Client Initialization`  [EXTRACTED]
  SETUP.md → src/lib/supabase.js
- `Minimate Setup Guide` --references--> `Supabase Database Schema`  [EXTRACTED]
  SETUP.md → supabase/schema.sql
- `index.html Entry Point` --references--> `main.jsx Entry Point`  [EXTRACTED]
  index.html → src/main.jsx

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Minimate App Core Data Flow** — src_app_jsx, src_lib_supabasedb_js, src_lib_supabase_js, supabase_schema_sql [INFERRED 0.90]
- **Minimate Page Views** — src_pages_dashboard, src_pages_panelslist, src_pages_paneldetail, src_pages_commdevices, src_pages_projectselector [EXTRACTED 0.95]
- **Minimate UI Components** — src_components_sidebar, src_components_statusbadge, src_components_progressbar [EXTRACTED 0.95]

## Communities (23 total, 6 thin omitted)

### Community 0 - "App Core & Device Sidebar"
Cohesion: 0.09
Nodes (32): addrNum(), App(), sortDevicesByAddress(), Sidebar(), listDocuments(), attemptSave(), autoBackup(), countPoints() (+24 more)

### Community 1 - "App Entry & UI Components"
Cohesion: 0.07
Nodes (24): Annotated Building Floor Plan with Highlighted Cable Routing Loops, index.html Entry Point, README - React + Vite Template, Minimate Setup Guide, App.jsx Main Application, Hero Image - Isometric Layered UI Component Illustration, ProgressBar(), StatusBadge() (+16 more)

### Community 2 - "AI Image & CAD Analysis"
Cohesion: 0.15
Nodes (19): analyzeCadPdf(), analyzePhoto(), analyzePhotoBase64(), cleanTag(), extractPins(), analyzeSequence(), callGeminiRaw(), callGeminiWithFile() (+11 more)

### Community 3 - "Loop Device Store"
Cohesion: 0.16
Nodes (24): deviceFieldsKey(), deviceRowToDevice(), deviceToRow(), diffLoops(), drainNow(), ensureBackfill(), fetchLoopDevices(), flushLoopOps() (+16 more)

### Community 4 - "Project Dependencies"
Cohesion: 0.09
Nodes (22): dependencies, react, react-dom, react-router-dom, @supabase/supabase-js, devDependencies, oxlint, tailwindcss (+14 more)

### Community 5 - "Document Store & Registry"
Cohesion: 0.19
Nodes (17): archiveDocument(), assignRegister(), deleteDocument(), docToRow(), findByHash(), floorCode(), ingestFile(), makeRegisterNo() (+9 more)

### Community 6 - "Estimate & BOQ Parser"
Cohesion: 0.27
Nodes (19): aoaOf(), cS(), findHeaderRow(), isNumStr(), isTotalCell(), marked(), parseAnalysis(), parseBoq() (+11 more)

### Community 7 - "Trace Studio File Tools"
Cohesion: 0.20
Nodes (13): isImageFile(), perpDist(), rdp(), TraceStudio(), up(), upKeep(), getFile(), hasFile() (+5 more)

### Community 8 - "Global Import & Sheet Classification"
Cohesion: 0.21
Nodes (15): GlobalImport(), isImg(), isPdfF(), isXls(), classifySheet(), sheetList(), aoaOf(), applyTermination() (+7 more)

### Community 9 - "Smart Document Parser"
Cohesion: 0.33
Nodes (13): cleanStr(), detectSheetType(), extractPDFText(), extractWordText(), gid(), panelSlug(), parseDDCPanelSchedule(), parseDDCTerminationSheets() (+5 more)

### Community 10 - "Reports & Progress Forecasting"
Cohesion: 0.33
Nodes (9): computeForecast(), countStages(), fetchSnapshots(), snapshotProgress(), fmtDate(), ReportsPage(), up(), upKeep() (+1 more)

### Community 11 - "Drawing Parser & Gemini Integration"
Cohesion: 0.36
Nodes (10): callGeminiRaw(), callGeminiWithFile(), callGeminiWithImage(), combineResults(), compressImage(), extractJSON(), normalizeKeys(), parseDrawings() (+2 more)

### Community 12 - "Comm Devices Stage UI"
Cohesion: 0.24
Nodes (5): addrNum(), calcWeightedPct(), CommDevices(), sortDevsByAddr(), stageCount()

### Community 13 - "Document & IO List Pages"
Cohesion: 0.31
Nodes (6): DocGrid(), up(), DocumentsPage(), up(), IoListPage(), up()

### Community 14 - "Lint Configuration Rules"
Cohesion: 0.33
Nodes (5): plugins, rules, react/only-export-components, react/rules-of-hooks, $schema

## Ambiguous Edges - Review These
- `Smart Excel Parser` → `Annotated Building Floor Plan with Highlighted Cable Routing Loops`  [AMBIGUOUS]
  20260413_112718.jpg.jpeg · relation: conceptually_related_to

## Knowledge Gaps
- **37 isolated node(s):** `$schema`, `plugins`, `react/rules-of-hooks`, `react/only-export-components`, `name` (+32 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Smart Excel Parser` and `Annotated Building Floor Plan with Highlighted Cable Routing Loops`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `App.jsx Main Application` connect `App Entry & UI Components` to `App Core & Device Sidebar`, `Comm Devices Stage UI`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `smartParse()` connect `Smart Document Parser` to `App Core & Device Sidebar`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Why does `StatusBadge()` connect `App Entry & UI Components` to `Comm Devices Stage UI`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `App.jsx Main Application` (e.g. with `README - React + Vite Template` and `ProgressBar.jsx`) actually correct?**
  _`App.jsx Main Application` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `plugins`, `react/rules-of-hooks` to the rest of the system?**
  _37 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `App Core & Device Sidebar` be split into smaller, more focused modules?**
  _Cohesion score 0.09413067552602436 - nodes in this community are weakly interconnected._