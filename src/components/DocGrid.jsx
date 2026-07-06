/* --- DocGrid.jsx --- editable table for ANY document's content ---
   A document's content is a simple grid { columns:[headers], rows:[[cells]] }
   stored on the document (extracted.table). Fully editable: edit any cell,
   rename headers, add/delete rows, add/remove columns. Edits save live via
   onChange. Generic — works for every document type. */

function up(v) { return ('' + (v == null ? '' : v)).toUpperCase() }

export default function DocGrid(props) {
  var table = props.table || {}
  var cols = table.columns || []
  var rows = table.rows || []

  function commit(nextCols, nextRows) { if (props.onChange) props.onChange({ columns: nextCols, rows: nextRows }) }
  function setCell(r, c, v) {
    var nr = rows.map(function(row, ri) { if (ri !== r) return row; var nc = row.slice(); nc[c] = v; return nc })
    commit(cols, nr)
  }
  function setHeader(c, v) { var nc = cols.slice(); nc[c] = v; commit(nc, rows) }
  function addRow() { commit(cols, rows.concat([cols.map(function() { return '' })])) }
  function delRow(r) { commit(cols, rows.filter(function(row, ri) { return ri !== r })) }
  function addCol() { commit(cols.concat(['COLUMN ' + (cols.length + 1)]), rows.map(function(row) { return row.concat(['']) })) }
  function delCol(c) { commit(cols.filter(function(v, ci) { return ci !== c }), rows.map(function(row) { return row.filter(function(v, ci) { return ci !== c }) })) }

  var inCls = 'bg-transparent border border-transparent rounded px-1 py-0.5 uppercase text-[11px] outline-none focus:border-teal focus:bg-navy w-full'
  var thc = 'px-1 py-1 border-b border-border'
  var tdc = 'px-1 py-0.5 border-b border-border/30'

  if (cols.length === 0 && rows.length === 0) {
    return (
      <div>
        <div className="text-[11px] text-dgray uppercase mb-2 leading-relaxed">THIS DOCUMENT HAS NO EDITABLE TABLE YET — RE-IMPORT IT TO LOAD ITS CONTENT, OR START A BLANK TABLE.</div>
        <button onClick={addCol} className="px-3 py-1.5 bg-teal/20 text-teal text-[10px] font-bold rounded uppercase hover:bg-teal/30">+ ADD COLUMN</button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 no-print">
        <button onClick={addRow} className="px-2.5 py-1 bg-teal/20 text-teal text-[10px] font-bold rounded uppercase hover:bg-teal/30">+ ROW</button>
        <button onClick={addCol} className="px-2.5 py-1 bg-purple/20 text-purple text-[10px] font-bold rounded uppercase hover:bg-purple/30">+ COLUMN</button>
        <span className="text-[9px] text-dgray uppercase">{rows.length} ROWS · {cols.length} COLS · EDITS SAVE LIVE</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border border-border">
          <thead><tr>
            <th className={thc + ' w-8 text-[9px] text-dgray'}>#</th>
            {cols.map(function(c, ci) {
              return (<th key={ci} className={thc + ' min-w-[120px]'}>
                <div className="flex items-center gap-1">
                  <input value={c} onChange={function(e) { setHeader(ci, up(e.target.value)) }} className={inCls + ' font-bold text-cyan'} />
                  <button onClick={function() { delCol(ci) }} title="DELETE COLUMN" className="text-dgray hover:text-red text-[10px] no-print">✕</button>
                </div>
              </th>)
            })}
            <th className={thc + ' w-6 no-print'}></th>
          </tr></thead>
          <tbody>
            {rows.map(function(row, ri) {
              return (<tr key={ri} className={ri % 2 ? 'bg-card2/20' : ''}>
                <td className={tdc + ' text-[9px] text-dgray text-center'}>{ri + 1}</td>
                {cols.map(function(c, ci) {
                  return <td key={ci} className={tdc}><input value={row[ci] == null ? '' : row[ci]} onChange={function(e) { setCell(ri, ci, up(e.target.value)) }} className={inCls + ' text-white'} /></td>
                })}
                <td className={tdc + ' no-print text-center'}><button onClick={function() { delRow(ri) }} title="DELETE ROW" className="text-dgray hover:text-red text-[10px]">✕</button></td>
              </tr>)
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
