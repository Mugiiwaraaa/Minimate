var styles = {
  done: 'bg-green/15 text-green',
  progress: 'bg-teal/15 text-cyan',
  blocked: 'bg-red/15 text-red',
  pending: 'bg-slate-500/15 text-slate-400',
  testing: 'bg-orange/15 text-orange',
}

export default function StatusBadge(props) {
  var status = props.status
  var label = props.label
  var size = props.size || 'sm'
  var cls = styles[status] || styles.pending
  var sz = size === 'sm' ? 'text-[9px] px-2 py-0.5' : 'text-[11px] px-3 py-1'
  return (
    <span className={cls + ' ' + sz + ' rounded font-semibold inline-block uppercase'}>
      {label || status}
    </span>
  )
}
