/* --- sim/fixtures/build-fixture.mjs --- generates sim-io-list.xlsx ---
   Minimal IO List workbook matching smartParser.js's parseIOList() row
   pattern exactly (see src/lib/smartParser.js for the format this mirrors):
     - sheet content must score as IO_LIST in detectSheetType() (the phrase
       "IO LIST" anywhere in the first 15 rows scores +7, threshold is >4)
     - a "DDC-<FLOOR>-<NN> (<location>)" cell in column B starts a panel
     - a numeric qty in column A + a name in column B (not starting DI-/DO-)
       starts an equipment group; qty=2 with no explicit id list generates
       two auto-numbered units (UNIT-1, UNIT-2)
     - point rows: column A empty, column B = description, columns C-G =
       DI/DO/AI/AO/INT counts
     - "TOTAL" in column B closes the group + panel

   Produces ONE panel (DDC-GF-01), TWO equipment (UNIT-1, UNIT-2), each with
   a DI and a DO point — enough grid rows (2 headers + 4 points) to exercise
   keyboard nav, multi-row select, fill-drag, and paste in SheetGrid.

   Regenerate: node sim/fixtures/build-fixture.mjs */

import XLSX from 'xlsx'
import { fileURLToPath } from 'url'
import path from 'path'

var __dirname = path.dirname(fileURLToPath(import.meta.url))

var rows = [
  ['IO LIST'],
  ['', 'DDC-GF-01 (SIM ROOM)'],
  [2, 'SIM UNIT A', 0, 0, 0, 0, 0],
  ['', 'SIM POINT ONE', 1, 0, 0, 0, 0],
  ['', 'SIM POINT TWO', 0, 1, 0, 0, 0],
  ['', 'TOTAL']
]

var ws = XLSX.utils.aoa_to_sheet(rows)
var wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, 'IO List')
XLSX.writeFile(wb, path.join(__dirname, 'sim-io-list.xlsx'))
console.log('wrote sim/fixtures/sim-io-list.xlsx')
