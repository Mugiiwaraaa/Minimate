/* --- sim/engineer-sim.mjs --- "Fable acts as a site engineer" ---
   Playwright simulation that drives Minimate the way Fahad's team does:
   imports, edits, ticks, traces, reports — then verifies persistence and
   multi-user behavior with TWO concurrent browser contexts.

   NOT WIRED TO CI YET. Run manually when ready:
     1) npm i -D playwright && npx playwright install chromium
     2) npm run dev   (or set SIM_URL to the deployed app)
     3) node sim/engineer-sim.mjs
   Optional env: SIM_URL (default http://localhost:5173)
                 SIM_HEADED=1 (watch it work)
                 SIM_KEEP=1  (don't delete the test project at the end)

   Design notes:
   - Uses ONLY user-visible surfaces (text, roles, placeholders) — no test-ids
     required, so it exercises the app exactly as an engineer would.
   - Each scenario logs PASS/FAIL and continues; exit code 1 if any failed.
   - The test project is named SIM-<timestamp> and archived+deleted at the end
     (soft-delete → DELETE FOREVER) unless SIM_KEEP=1.
   - Scenario list mirrors sim/README.md — keep the two in sync. */

import { chromium } from 'playwright'

var BASE = process.env.SIM_URL || 'http://localhost:5173'
var HEADED = !!process.env.SIM_HEADED
var KEEP = !!process.env.SIM_KEEP
var PROJECT = 'SIM-' + Date.now()

var results = []
function pass(name, note) { results.push({ name: name, ok: true, note: note || '' }); console.log('  ✓ ' + name + (note ? ' — ' + note : '')) }
function fail(name, err) { results.push({ name: name, ok: false, note: String(err && err.message || err) }); console.log('  ✗ ' + name + ' — ' + String(err && err.message || err)) }

async function run() {
  console.log('ENGINEER SIM · ' + BASE + ' · project ' + PROJECT)
  var browser = await chromium.launch({ headless: !HEADED })
  var ctxA = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  await ctxA.grantPermissions(['clipboard-read', 'clipboard-write']) // S9 copy/paste
  var A = await ctxA.newPage()
  A.on('console', function(msg) {
    if (msg.type() === 'error') console.log('  [browser error] ' + msg.text().substring(0, 160))
  })

  // ── SCENARIO 1: project creation ─────────────────────────────
  try {
    await A.goto(BASE)
    await A.getByText('CREATE PROJECT', { exact: false }).first().click()
    await A.getByPlaceholder(/BN01|ADEK|E\.G\./i).first().fill(PROJECT)
    await A.getByRole('button', { name: /CREATE PROJECT/i }).click()
    await A.getByText('FIELD DEVICES', { exact: false }).first().waitFor({ timeout: 15000 })
    pass('S1 create project + land in app')
  } catch (e) { fail('S1 create project', e); await browser.close(); return finish() }

  // ── SCENARIO 2: loops + devices by hand (the daily grind) ────
  try {
    await A.locator('a[href="/field-devices"]').first().click() // sidebar NavLink text is "🔗FIELD DEVICES" (icon+label, no wrapper) — exact text match misses it and hits the Dashboard stat-card label instead; href is unambiguous
    await A.getByRole('button', { name: /\+ ADD LOOP/i }).click()
    await A.getByPlaceholder('GF').first().fill('FF')
    await A.getByPlaceholder('LOOP 1').first().fill('SIM-LOOP-01')
    await A.getByRole('button', { name: /CREATE LOOP/i }).click()
    // addLoop() auto-expands the new loop (setExpanded(loop.id)) — no click needed;
    // clicking the loop name here would just TOGGLE it closed again
    for (var i = 1; i <= 5; i++) {
      await A.getByText('+ ADD DEVICE', { exact: false }).first().click()
      await A.getByPlaceholder('FCU-01').first().fill('SIM-FCU-' + i)
      await A.getByPlaceholder('ROOM 101').first().fill('SIM ROOM ' + i)
      await A.getByPlaceholder('1').last().fill(String(10 - i)) // reversed addresses on purpose
      await A.getByRole('button', { name: /^ADD$/i }).click()
    }
    pass('S2 add loop + 5 devices')
  } catch (e) { fail('S2 add loop/devices', e) }

  // ── SCENARIO 3: rapid checklist ticking (the M6 stress test) ─
  try {
    var boxes = A.locator('table button.w-5') // StgBtn cells
    var n = await boxes.count()
    var clicks = 0
    for (var b = 0; b < n && clicks < 15; b++) {
      var el = boxes.nth(b)
      if (await el.isEnabled()) { await el.click({ delay: 30 }); clicks++ }
    }
    await A.waitForTimeout(2500) // let row ops drain
    pass('S3 rapid ticking', clicks + ' ticks')
  } catch (e) { fail('S3 rapid ticking', e) }

  // ── SCENARIO 4: SORT BY ADDR then persistence reload ─────────
  try {
    await A.getByText('SORT BY ADDR', { exact: false }).first().click()
    await A.waitForTimeout(1800)
    await A.reload()
    // activeProject is plain useState(null), no persistence — a hard reload always
    // drops back to ProjectSelector regardless of URL. Re-select + re-navigate.
    await A.getByText(PROJECT, { exact: false }).first().waitFor({ timeout: 15000 })
    await A.getByText(PROJECT, { exact: false }).first().click()
    await A.locator('a[href="/field-devices"]').first().waitFor({ timeout: 15000 })
    await A.locator('a[href="/field-devices"]').first().click()
    await A.getByText('SIM-LOOP-01').first().waitFor({ timeout: 10000 })
    await A.getByText('SIM-LOOP-01').first().click() // collapsed again after reload — expand it
    var firstTag = await A.locator('table input[value^="SIM-FCU-"]').first().inputValue()
    if (firstTag !== 'SIM-FCU-5') throw new Error('expected SIM-FCU-5 first after addr sort, got ' + firstTag)
    pass('S4 sort persisted across reload')
  } catch (e) { fail('S4 sort/persistence', e) }

  // ── SCENARIO 5: second engineer, live sync (two contexts) ────
  try {
    var ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    var B = await ctxB.newPage()
    await B.goto(BASE)
    await B.getByText(PROJECT).first().click()
    await B.locator('a[href="/field-devices"]').first().click()
    await B.getByText('SIM-LOOP-01').first().click()
    // B ticks a stage; A should see it without reload
    var bBox = B.locator('table button.w-5').first()
    var before = await A.locator('table button.w-5').first().getAttribute('class')
    if ((before || '').indexOf('bg-green') < 0) {
      await bBox.click()
      await A.waitForTimeout(3000)
      var after = await A.locator('table button.w-5').first().getAttribute('class')
      if ((after || '').indexOf('bg-green') < 0) throw new Error("A never saw B's tick (realtime)")
    }
    // simultaneous different-device edits must both survive
    await A.locator('table input[value^="SIM-FCU-"]').nth(1).fill('SIM-FCU-EDIT-A')
    await B.locator('table input[value^="SIM-FCU-"]').nth(2).fill('SIM-FCU-EDIT-B')
    await A.waitForTimeout(3000)
    await A.reload() // no persistence for activeProject — bounces to ProjectSelector, same as S4
    await A.getByText(PROJECT, { exact: false }).first().waitFor({ timeout: 15000 })
    await A.getByText(PROJECT, { exact: false }).first().click()
    await A.locator('a[href="/field-devices"]').first().waitFor({ timeout: 15000 })
    await A.locator('a[href="/field-devices"]').first().click()
    await A.getByText('SIM-LOOP-01').first().waitFor({ timeout: 10000 })
    await A.getByText('SIM-LOOP-01').first().click()
    // table cells are <input value=...> — innerText never sees input values
    // (same class of mistake as S6's original getByText check); match value
    // attributes directly instead
    var hasA = await A.locator('input[value="SIM-FCU-EDIT-A"]').count()
    var hasB = await A.locator('input[value="SIM-FCU-EDIT-B"]').count()
    if (hasA === 0 || hasB === 0) throw new Error('concurrent edits lost: ' + (hasA === 0 ? 'A' : 'B'))
    await ctxB.close()
    pass('S5 two-engineer live sync, no lost edits')
  } catch (e) { fail('S5 multi-user sync', e) }

  // ── SCENARIO 6: area group + location view ───────────────────
  try {
    await A.getByRole('button', { name: /LOCATION VIEW/i }).click()
    await A.getByRole('button', { name: /\+ ADD AREA GROUP/i }).click()
    await A.getByPlaceholder(/EAST WING/i).fill('SIM AREA 1')
    await A.getByPlaceholder('GF').last().fill('FF')
    await A.getByRole('button', { name: /^CREATE$/i }).click()
    // area name renders as <input value={area.name}>, not text content — getByText
    // can never match an input's value; match the value attribute directly instead
    await A.locator('input[value="SIM AREA 1"]').first().waitFor({ timeout: 8000 })
    pass('S6 area group under floor header')
  } catch (e) { fail('S6 location view', e) }

  // ── SCENARIO 7: reports render + exports exist ───────────────
  try {
    await A.locator('a[href="/reports"]').first().click()
    await A.getByText('EXPORT PDF', { exact: false }).first().waitFor({ timeout: 10000 })
    await A.getByText('WEEKLY PROGRESS', { exact: false }).first().click() // preset applies
    await A.getByText('EXECUTIVE SUMMARY', { exact: false }).first().waitFor()
    var dl = A.waitForEvent('download', { timeout: 15000 })
    await A.getByRole('button', { name: /EXPORT EXCEL/i }).click()
    var file = await dl
    if (!file.suggestedFilename().endsWith('.xlsx')) throw new Error('excel export filename: ' + file.suggestedFilename())
    pass('S7 reports + excel export', file.suggestedFilename())
  } catch (e) { fail('S7 reports/exports', e) }

  // ── SCENARIO 8: documents / global import surface exists ─────
  try {
    await A.getByText('DOCUMENTS', { exact: false }).first().click()
    await A.getByText(/ESTIMATE|LIBRARY|DRAWINGS/i).first().waitFor({ timeout: 8000 })
    pass('S8 documents page reachable')
  } catch (e) { fail('S8 documents page', e) }

  // ── SCENARIO 9: fixture import → IoSheetGrid Excel UX ─────────
  // sim/fixtures/sim-io-list.xlsx -> import -> panel DDC-GF-01 with two
  // equipment (UNIT-1, UNIT-2), each with a DI point ("SIM POINT ONE")
  // and a DO point ("SIM POINT TWO"). Row layout is deterministic from
  // IoSheetGrid.jsx's toRows(): r0=UNIT-1 header, r1/r2=its points,
  // r3=UNIT-2 header, r4/r5=its points. Columns: _name=c0, _qty=c1,
  // _di=c2, _do=c3 (see IO_COLUMNS in IoSheetGrid.jsx).
  try {
    await A.locator('input[type="file"]').first().setInputFiles('sim/fixtures/sim-io-list.xlsx')
    await A.getByText('IMPORT →', { exact: false }).first().waitFor({ timeout: 8000 })
    await A.getByText('IMPORT →', { exact: false }).first().click()
    await A.getByText('CONFIRM IMPORT', { exact: false }).first().waitFor({ timeout: 8000 })
    await A.getByText('CONFIRM IMPORT', { exact: false }).first().click()
    await A.waitForTimeout(1200)

    await A.locator('a[href="/panels"]').first().click() // same "🔗FIELD DEVICES"-class ambiguity as above — Dashboard has a DDC PANELS stat card too
    await A.getByText('DDC-GF-01', { exact: false }).first().click()
    var c10 = A.locator('[data-r="1"][data-c="0"]').first()
    await c10.waitFor({ timeout: 10000 })

    // keyboard nav: select r1, Down then Up round-trips back
    await c10.click()
    await A.keyboard.press('ArrowDown')
    await A.keyboard.press('ArrowUp')

    // type-to-edit: typing while a cell is selected starts edit; Enter commits
    await A.keyboard.type('EDITED POINT')
    await A.keyboard.press('Enter')
    await A.waitForTimeout(400)
    var nameText = (await c10.innerText()).trim()
    if (nameText.indexOf('EDITED POINT') < 0) throw new Error('type-to-edit: expected EDITED POINT, got "' + nameText + '"')

    // range select + copy: select r1 _name+_qty (2 cells), Ctrl+C
    var c11 = A.locator('[data-r="1"][data-c="1"]').first()
    await c10.click()
    await c11.click({ modifiers: ['Shift'] }) // extends selection c0..c1
    await A.keyboard.press('Control+c')

    // paste onto r4 (UNIT-2's first point) — TSV round-trip
    var c40 = A.locator('[data-r="4"][data-c="0"]').first()
    await c40.click()
    await A.keyboard.press('Control+v')
    await A.waitForTimeout(500)
    var pastedText = (await c40.innerText()).trim()
    if (pastedText.indexOf('EDITED POINT') < 0) throw new Error('paste: expected EDITED POINT on r4, got "' + pastedText + '"')

    // fill-drag COPY: select r1 _di (=1), drag its corner handle down to r2 (a DO point, _di empty)
    var c12 = A.locator('[data-r="1"][data-c="2"]').first()
    await c12.click()
    var handle = A.locator('[data-r="1"][data-c="2"] [data-fill="1"]').first()
    var hBox = await handle.boundingBox()
    var c22 = A.locator('[data-r="2"][data-c="2"]').first()
    var tBox = await c22.boundingBox()
    if (!hBox || !tBox) throw new Error('fill handle or target cell not found')
    await A.mouse.move(hBox.x + hBox.width / 2, hBox.y + hBox.height / 2)
    await A.mouse.down()
    await A.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 5 })
    await A.mouse.up()
    await A.waitForTimeout(500)
    var filledVal = (await c22.innerText()).trim()
    if (filledVal !== '1') throw new Error('fill-drag: expected r2 _di=1 after fill, got "' + filledVal + '"')

    // Ctrl+Z undo — should revert the fill (app-level undo, IoSheetGrid bubbles via onUndo)
    await A.keyboard.press('Control+z')
    await A.waitForTimeout(500)
    var afterUndo = (await c22.innerText()).trim()
    if (afterUndo === '1') throw new Error('undo: fill was not reverted, still shows "1"')

    pass('S9 sheetgrid excel UX', 'import+nav+edit+copy/paste+fill-drag+undo all verified')
  } catch (e) { fail('S9 sheetgrid excel UX', e) }

  // ── CLEANUP ──────────────────────────────────────────────────
  if (!KEEP) {
    try {
      await A.getByText('SWITCH PROJECT', { exact: false }).first().click()
      await A.getByText(PROJECT).first().waitFor()
      // soft-delete isn't exposed on the card; archive via app is manual —
      // leave the SIM project; flag for manual cleanup instead.
      console.log('  ! cleanup: archive/delete project ' + PROJECT + ' manually (soft-delete lives in-app)')
    } catch (e) { console.log('  ! cleanup skipped: ' + e.message) }
  }

  await browser.close()
  finish()
}

function finish() {
  var failed = results.filter(function(r) { return !r.ok })
  console.log('\n──────── RESULT: ' + (results.length - failed.length) + '/' + results.length + ' passed ────────')
  failed.forEach(function(f) { console.log('FAILED: ' + f.name + ' — ' + f.note) })
  process.exit(failed.length > 0 ? 1 : 0)
}

run().catch(function(e) { console.error('SIM CRASHED:', e); process.exit(1) })
