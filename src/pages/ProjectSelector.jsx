import { useState, useEffect } from 'react'
import { isDemo } from '../lib/supabase'
import { listProjects, createProject, listArchivedProjects, restoreProject, hardDeleteProject } from '../lib/supabaseDb'

export default function ProjectSelector(props) {
  var onSelectProject = props.onSelectProject
  var projectsState = useState([])
  var projects = projectsState[0]
  var setProjects = projectsState[1]
  var loadingState = useState(true)
  var loading = loadingState[0]
  var setLoading = loadingState[1]
  var errorState = useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var showCreateState = useState(false)
  var showCreate = showCreateState[0]
  var setShowCreate = showCreateState[1]
  var nameState = useState('')
  var newName = nameState[0]
  var setNewName = nameState[1]
  var clientState = useState('')
  var newClient = clientState[0]
  var setNewClient = clientState[1]
  var locState = useState('')
  var newLoc = locState[0]
  var setNewLoc = locState[1]
  var creatingState = useState(false)
  var creating = creatingState[0]
  var setCreating = creatingState[1]
  var archivedState = useState([])
  var archived = archivedState[0]
  var setArchived = archivedState[1]
  var showArchivedState = useState(false)
  var showArchived = showArchivedState[0]
  var setShowArchived = showArchivedState[1]

  useEffect(function() {
    if (isDemo) {
      setLoading(false)
      return
    }
    refreshLists()
  }, [])

  function refreshLists() {
    listProjects(function(err, data) {
      setLoading(false)
      if (err) { setError(err.message); return }
      setProjects(data || [])
    })
    listArchivedProjects(function(err, data) {
      if (!err) setArchived(data || [])
    })
  }

  function handleRestore(p) {
    restoreProject(p.id, function(err) {
      if (err) { setError(err.message); return }
      refreshLists()
    })
  }

  function handleHardDelete(p) {
    if (!window.confirm('PERMANENTLY DELETE "' + p.name + '"? THIS CANNOT BE UNDONE (ONLY BACKUP SNAPSHOTS REMAIN).')) return
    hardDeleteProject(p.id, function(err) {
      if (err) { setError(err.message); return }
      refreshLists()
    })
  }

  function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    createProject(newName, newClient, newLoc, function(err, project) {
      setCreating(false)
      if (err) { setError(err.message); return }
      onSelectProject(project)
    })
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleCreate()
    else if (e.key === 'Escape') setShowCreate(false)
  }

  function formatDate(dateStr) {
    if (!dateStr) return ''
    var d = new Date(dateStr)
    var now = new Date()
    var diff = now - d
    if (diff < 60000) return 'JUST NOW'
    if (diff < 3600000) return Math.floor(diff / 60000) + 'M AGO'
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'H AGO'
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'D AGO'
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).toUpperCase()
  }

  if (isDemo) {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center p-6" style={{textTransform:'uppercase'}}>
        <div className="max-w-lg text-center">
          <h1 className="text-3xl font-black mb-2">
            <span className="text-white">MINI</span><span className="text-teal">MATE</span>
          </h1>
          <p className="text-dgray text-sm mb-6">CONNECT SUPABASE TO ENABLE MULTI-PROJECT PERSISTENCE</p>
          <div className="bg-card rounded-xl border border-border p-6 text-left">
            <h3 className="text-xs font-bold text-orange mb-3">SETUP REQUIRED</h3>
            <div className="text-[11px] text-dgray space-y-2">
              <p>1. CREATE A FREE SUPABASE PROJECT AT SUPABASE.COM</p>
              <p>2. RUN THE SQL FROM <span className="text-cyan">SUPABASE/SCHEMA.SQL</span> IN THE SQL EDITOR</p>
              <p>3. COPY YOUR PROJECT URL AND ANON KEY</p>
              <p>4. CREATE <span className="text-cyan">.ENV</span> FILE WITH YOUR CREDENTIALS</p>
              <p>5. RESTART THE DEV SERVER</p>
            </div>
            <div className="mt-4 bg-navy rounded-lg p-3">
              <div className="text-[10px] text-dgray mb-1">ENV FILE FORMAT:</div>
              <pre className="text-[10px] text-cyan">VITE_SUPABASE_URL=https://xxxxx.supabase.co{'\n'}VITE_SUPABASE_ANON_KEY=eyJhbGciOi...</pre>
            </div>
          </div>
          <button onClick={function(){ onSelectProject(null) }}
            className="mt-4 px-6 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white transition">
            CONTINUE IN DEMO MODE (NO PERSISTENCE)
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-navy flex items-center justify-center p-4 md:p-6" style={{textTransform:'uppercase'}}>
      <div className="max-w-3xl w-full">
        <div className="text-center mb-6 md:mb-8">
          <h1 className="text-2xl md:text-3xl font-black mb-1">
            <span className="text-white">MINI</span><span className="text-teal">MATE</span>
          </h1>
          <p className="text-dgray text-sm">SELECT A PROJECT OR CREATE A NEW ONE</p>
        </div>

        {error && (
          <div className="bg-red/10 border border-red/30 rounded-lg p-3 mb-4 text-center">
            <div className="text-[10px] text-red font-bold">{error}</div>
          </div>
        )}

        {loading ? (
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-teal border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
            <div className="text-xs text-dgray">LOADING PROJECTS...</div>
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
              {projects.map(function(p) {
                return (
                  <button key={p.id} onClick={function(){ onSelectProject(p) }}
                    className="bg-card rounded-xl border border-border hover:border-teal p-5 text-left transition group">
                    <div className="text-sm font-bold text-white group-hover:text-cyan transition mb-1">{p.name}</div>
                    <div className="text-[10px] text-dgray mb-3">{p.client || 'NO CLIENT'}{p.location ? ' — ' + p.location : ''}</div>
                    <div className="flex gap-3 text-[10px]">
                      <div>
                        <span className="text-dgray">PANELS </span>
                        <span className="text-cyan font-bold">{p.panelCount || 0}</span>
                      </div>
                      <div>
                        <span className="text-dgray">IO PTS </span>
                        <span className="text-cyan font-bold">{p.pointCount || 0}</span>
                      </div>
                      <div>
                        <span className="text-dgray">LOOPS </span>
                        <span className="text-cyan font-bold">{p.loopCount || 0}</span>
                      </div>
                      <div>
                        <span className="text-dgray">DEVICES </span>
                        <span className="text-cyan font-bold">{p.deviceCount || 0}</span>
                      </div>
                    </div>
                    <div className="text-[9px] text-dgray mt-2">UPDATED {formatDate(p.updated_at)}</div>
                  </button>
                )
              })}

              {/* Create new project card */}
              {!showCreate && (
                <button onClick={function(){ setShowCreate(true) }}
                  className="bg-card/50 rounded-xl border-2 border-dashed border-border hover:border-teal p-5 text-center transition group min-h-[120px] flex flex-col items-center justify-center">
                  <div className="text-2xl text-dgray group-hover:text-teal transition mb-1">+</div>
                  <div className="text-xs text-dgray group-hover:text-white transition">CREATE PROJECT</div>
                </button>
              )}
            </div>

            {/* Create form */}
            {showCreate && (
              <div className="bg-card rounded-xl border-2 border-teal p-6 max-w-md mx-auto">
                <h3 className="text-sm font-bold mb-4">NEW PROJECT</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] text-dgray block mb-1">PROJECT NAME *</label>
                    <input autoFocus value={newName}
                      onChange={function(e){ setNewName(e.target.value) }}
                      onKeyDown={handleKeyDown}
                      style={{textTransform:'uppercase'}}
                      placeholder="E.G. BN01 ADEK SCHOOL"
                      className="w-full bg-navy border border-border rounded px-3 py-2 text-xs text-white outline-none focus:border-teal placeholder:text-dgray/40" />
                  </div>
                  <div>
                    <label className="text-[10px] text-dgray block mb-1">CLIENT</label>
                    <input value={newClient}
                      onChange={function(e){ setNewClient(e.target.value) }}
                      onKeyDown={handleKeyDown}
                      style={{textTransform:'uppercase'}}
                      placeholder="E.G. ADEK"
                      className="w-full bg-navy border border-border rounded px-3 py-2 text-xs text-white outline-none focus:border-teal placeholder:text-dgray/40" />
                  </div>
                  <div>
                    <label className="text-[10px] text-dgray block mb-1">LOCATION</label>
                    <input value={newLoc}
                      onChange={function(e){ setNewLoc(e.target.value) }}
                      onKeyDown={handleKeyDown}
                      style={{textTransform:'uppercase'}}
                      placeholder="E.G. ABU DHABI"
                      className="w-full bg-navy border border-border rounded px-3 py-2 text-xs text-white outline-none focus:border-teal placeholder:text-dgray/40" />
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <button onClick={handleCreate} disabled={creating || !newName.trim()}
                    className="px-5 py-2 bg-teal text-white text-xs font-bold rounded-md hover:bg-teal/80 disabled:opacity-40 transition">
                    {creating ? 'CREATING...' : 'CREATE PROJECT'}
                  </button>
                  <button onClick={function(){ setShowCreate(false) }}
                    className="px-5 py-2 bg-card2 text-dgray text-xs rounded-md hover:text-white transition">
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {projects.length === 0 && !showCreate && (
              <div className="text-center text-dgray text-xs mt-4">
                NO PROJECTS YET. CREATE YOUR FIRST ONE TO GET STARTED.
              </div>
            )}

            {/* Archived projects — soft-deleted, restorable */}
            {archived.length > 0 && (
              <div className="mt-8">
                <button onClick={function(){ setShowArchived(!showArchived) }}
                  className="mx-auto block text-[10px] text-dgray hover:text-white transition">
                  {showArchived ? '▾' : '▸'} ARCHIVED PROJECTS ({archived.length})
                </button>
                {showArchived && (
                  <div className="mt-3 max-w-md mx-auto space-y-2">
                    {archived.map(function(p) {
                      return (
                        <div key={p.id} className="bg-card/50 rounded-lg border border-border px-4 py-2.5 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold text-dgray truncate">{p.name}</div>
                            <div className="text-[9px] text-dgray/60">{p.client || 'NO CLIENT'} · ARCHIVED {formatDate(p.updated_at)}</div>
                          </div>
                          <button onClick={function(){ handleRestore(p) }}
                            className="px-3 py-1 bg-teal/20 text-teal text-[10px] font-bold rounded hover:bg-teal/30 transition shrink-0">RESTORE</button>
                          <button onClick={function(){ handleHardDelete(p) }}
                            className="px-2 py-1 text-dgray/60 hover:text-red text-[10px] transition shrink-0">DELETE FOREVER</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
