export default function ProgressBar(props) {
  var value = props.value
  var max = props.max
  var showLabel = props.showLabel !== undefined ? props.showLabel : true
  var height = props.height || 'h-5'
  var pct = max > 0 ? Math.round((value / max) * 100) : 0
  var color = pct >= 100 ? 'bg-green' : pct >= 50 ? 'bg-teal' : pct > 0 ? 'bg-orange' : 'bg-red'

  return (
    <div className="flex items-center gap-2">
      <div className={'flex-1 ' + height + ' bg-card2 rounded overflow-hidden'}>
        <div
          className={height + ' ' + color + ' rounded transition-all duration-500'}
          style={{ width: pct + '%' }}
        />
      </div>
      {showLabel && (
        <span className="text-[11px] font-bold text-slate-400 w-10 text-right">{pct}%</span>
      )}
    </div>
  )
}
