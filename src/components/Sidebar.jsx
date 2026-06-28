import { NavLink } from 'react-router-dom'

var nav = [
  { section: 'OVERVIEW', items: [
    { to: '/', icon: '\u{1F4CA}', label: 'DASHBOARD' },
    { to: '/panels', icon: '\u{1F532}', label: 'DDC PANELS', badge: null },
    { to: '/field-devices', icon: '\u{1F517}', label: 'FIELD DEVICES' },
    { to: '/tasks', icon: '✅', label: 'TASKS' },
  ]},
  { section: 'PROJECT', items: [
    { to: '/blockers', icon: '⚠️', label: 'BLOCKERS' },
    { to: '/reports', icon: '\u{1F4C8}', label: 'REPORTS' },
  ]},
]

export default function Sidebar(props) {
  var projectName = props.projectName
  return (
    <div className="fixed left-0 top-0 bottom-0 w-[220px] bg-card2 border-r border-border flex flex-col z-50">
      <div className="px-5 pt-5 pb-4 text-base font-extrabold uppercase">
        MINI<span className="text-cyan">MATE</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {nav.map(function(section) {
          return (
            <div key={section.section}>
              <div className="text-[10px] font-semibold text-dgray px-5 pt-3 pb-1 uppercase tracking-widest">
                {section.section}
              </div>
              {section.items.map(function(item) {
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={function(navProps) {
                      return 'flex items-center gap-2.5 px-5 py-2 text-[13px] transition-all cursor-pointer uppercase ' + (
                        navProps.isActive
                          ? 'bg-teal/12 text-cyan border-r-2 border-teal'
                          : 'text-slate-400 hover:bg-teal/8 hover:text-white'
                      )
                    }}
                  >
                    <span className="w-[18px] text-center text-sm">{item.icon}</span>
                    {item.label}
                    {item.badge && (
                      <span className="ml-auto text-[10px] font-bold bg-red text-white px-1.5 rounded-full">
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="mt-auto">
        <div className="px-4 pb-3">
          <label className="flex items-center gap-2 px-3 py-2 bg-orange/10 border border-orange/30 rounded-lg hover:bg-orange/20 transition cursor-pointer group">
            <span className="text-sm">+</span>
            <span className="text-[11px] text-orange font-semibold uppercase">IMPORT EXCEL</span>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={function(e){if(props.onImportFile)props.onImportFile(e)}} className="hidden"/>
          </label>
        </div>
        {!props.isDemo && props.onSwitchProject && (
          <div className="px-4 pb-3">
            <button onClick={props.onSwitchProject}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] text-dgray hover:text-white transition uppercase rounded-lg hover:bg-card">
              <span className="text-xs">↔</span> SWITCH PROJECT
            </button>
          </div>
        )}
        <div className="border-t border-border"></div>
        <div className="px-4 py-3 flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-teal flex items-center justify-center text-[11px] font-bold uppercase">
            FA
          </div>
          <div>
            <div className="text-xs font-medium uppercase">FAHAD AHMED</div>
            <div className="text-[10px] text-dgray uppercase">
              {projectName || 'PROJECT ENGINEER'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
