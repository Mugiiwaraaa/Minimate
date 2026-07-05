import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

var nav = [
  { section: 'OVERVIEW', items: [
    { to: '/', icon: '\u{1F4CA}', label: 'DASHBOARD' },
    { to: '/panels', icon: '\u{1F532}', label: 'DDC PANELS', badge: null },
    { to: '/field-devices', icon: '\u{1F517}', label: 'FIELD DEVICES' },
    { to: '/drawings', icon: '\u{1F4D0}', label: 'DRAWINGS' },
    { to: '/tasks', icon: '✅', label: 'TASKS' },
  ]},
  { section: 'PROJECT', items: [
    { to: '/blockers', icon: '⚠️', label: 'BLOCKERS' },
    { to: '/reports', icon: '\u{1F4C8}', label: 'REPORTS' },
  ]},
]

export default function Sidebar(props) {
  var projectName = props.projectName
  var openState = useState(false)
  var isOpen = openState[0]
  var setIsOpen = openState[1]
  var location = useLocation()

  // Close sidebar on nav click (mobile)
  function handleNavClick() {
    setIsOpen(false)
  }

  // Close sidebar on import (mobile)
  function handleImport(e) {
    setIsOpen(false)
    if (props.onImportFile) props.onImportFile(e)
  }

  function handleSwitch() {
    setIsOpen(false)
    if (props.onSwitchProject) props.onSwitchProject()
  }

  return (
    <div className="no-print">
      {/* ─── Mobile top bar ─────────────────────────────── */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-12 bg-card2 border-b border-border flex items-center justify-between px-4 z-50">
        <button onClick={function(){ setIsOpen(!isOpen) }}
          className="w-8 h-8 flex items-center justify-center text-white text-lg">
          {isOpen ? '✕' : '☰'}
        </button>
        <div className="text-sm font-extrabold uppercase">
          MINI<span className="text-cyan">MATE</span>
        </div>
        <div className="w-8"></div>
      </div>

      {/* ─── Backdrop (mobile only) ─────────────────────── */}
      {isOpen && (
        <div className="md:hidden fixed inset-0 bg-black/60 z-50" onClick={function(){ setIsOpen(false) }}></div>
      )}

      {/* ─── Sidebar panel ──────────────────────────────── */}
      <div className={'fixed left-0 top-0 bottom-0 w-[220px] bg-card2 border-r border-border flex flex-col z-50 transition-transform duration-200 ' + (isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')}>
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
                      onClick={handleNavClick}
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
              <input type="file" accept=".xlsx,.xls,.csv,.docx,.doc,.pdf" onChange={handleImport} className="hidden"/>
            </label>
          </div>
          {props.onImportDrawing && (
            <div className="px-4 pb-3">
              <button onClick={function(){if(props.onImportDrawing)props.onImportDrawing();setIsOpen(false)}} className="w-full flex items-center gap-2 px-3 py-2 bg-teal/10 border border-teal/30 rounded-lg hover:bg-teal/20 transition cursor-pointer">
                <span className="text-sm">📐</span>
                <span className="text-[11px] text-teal font-semibold uppercase">IMPORT DRAWINGS</span>
              </button>
            </div>
          )}
          {props.onExportProject && (
            <div className="px-4 pb-3 flex gap-2">
              <button onClick={function(){props.onExportProject();setIsOpen(false)}} title="DOWNLOAD A JSON BACKUP OF THIS PROJECT" className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-card border border-border rounded-lg hover:border-teal/50 transition text-[10px] text-dgray hover:text-white uppercase font-semibold">
                ⬇ BACKUP
              </button>
              <label title="RESTORE FROM A JSON BACKUP FILE" className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-card border border-border rounded-lg hover:border-orange/50 transition text-[10px] text-dgray hover:text-white uppercase font-semibold cursor-pointer">
                ⬆ RESTORE
                <input type="file" accept=".json" onChange={function(e){setIsOpen(false);if(props.onRestoreProject)props.onRestoreProject(e)}} className="hidden"/>
              </label>
            </div>
          )}
          {!props.isDemo && props.onSwitchProject && (
            <div className="px-4 pb-3">
              <button onClick={handleSwitch}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] text-dgray hover:text-white transition uppercase rounded-lg hover:bg-card">
                <span className="text-xs">{'⇔'}</span> SWITCH PROJECT
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
    </div>
  )
}
