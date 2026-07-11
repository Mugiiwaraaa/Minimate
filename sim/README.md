# Engineer Simulation — `sim/engineer-sim.mjs`

An AI-or-human-runnable Playwright script that uses Minimate **exactly like a
site engineer**: no test-ids, no internals — it clicks what an engineer sees.
Written July 10 2026 as part of the v2 Foundation plan. **Not wired to CI yet.**

## Run it (when ready — not today)
```bash
npm i -D playwright
npx playwright install chromium
npm run dev                # or: set SIM_URL to the deployed URL
node sim/engineer-sim.mjs
```
Env flags: `SIM_URL` (default localhost:5173) · `SIM_HEADED=1` watch it work ·
`SIM_KEEP=1` keep the test project.

⚠️ It creates a real project (`SIM-<timestamp>`) in whatever Supabase the app
points at. Point at a dev/staging Supabase or accept a junk project to archive.
Archive/DELETE FOREVER it from the project selector afterwards.

## Scenarios (keep in sync with the script)
| # | Simulates | Guards against |
|---|---|---|
| S1 | Create project, land in app | selector/routing regressions |
| S2 | Add loop + 5 devices by hand | the daily-grind entry path |
| S3 | Rapid checklist ticking (15 fast ticks) | the July-5 save-race class of bug |
| S4 | Sort by address → hard reload | persistence + M6 row round-trip |
| S5 | **Second browser context**: live tick sync + simultaneous different-device edits | realtime, echo filtering, lost-edit regressions |
| S6 | Area group under floor header | location view grouping |
| S7 | Reports: preset apply + Excel download | reports engine + export |
| S8 | Documents page reachable | R2 surface |
| S9 | *(stub)* SheetGrid Excel UX: keyboard nav, fill-drag, TSV paste, Ctrl+Z | enable at S-track S3 — this is the acceptance test for the grid refit |

## Interpreting results
Each scenario logs `✓/✗` and the run exits 1 on any failure. Browser console
errors are echoed with `[browser error]`. The most valuable failures are S3–S5:
they reproduce, on demand, the entire class of multi-user bugs that cost days
in early July.

## Future
- Wire into a pre-deploy step (run against Vercel preview URL).
- Add fixture import scenario (small `.xlsx` estimate in `sim/fixtures/`) once
  datasets land (S-track S2/S3).
- Fill in S9 when SheetGrid ships.
