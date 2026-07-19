/* --- traceDraftStore.js --- Trace Studio autosave drafts ---
   In-progress pins/traces/zones for a drawing, saved locally (IndexedDB)
   before the user presses DONE, so a killed tab/browser doesn't lose an
   editing session. Keyed by the same file content hash fileStore.js uses.
   Cleared once DONE commits the real drawing record. */

var DB_NAME = 'minimate-trace-drafts'
var STORE = 'drafts'

function openDb() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = function() {
      var db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'hash' })
      }
    }
    req.onsuccess = function() { resolve(req.result) }
    req.onerror = function() { reject(req.error || new Error('IndexedDB open failed')) }
  })
}

/* data: {pins, loops, zones, meta, pageNum} */
function saveDraft(hash, data) {
  if (!hash) return Promise.resolve()
  return openDb().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(Object.assign({ hash: hash }, data, { savedAt: new Date().toISOString() }))
      tx.oncomplete = function() { resolve() }
      tx.onerror = function() { reject(tx.error || new Error('IndexedDB write failed')) }
    })
  }).catch(function() { /* best-effort — never block the UI on this */ })
}

function getDraft(hash) {
  if (!hash) return Promise.resolve(null)
  return openDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE, 'readonly')
      var req = tx.objectStore(STORE).get(hash)
      req.onsuccess = function() { resolve(req.result || null) }
      req.onerror = function() { resolve(null) }
    })
  }).catch(function() { return null })
}

function clearDraft(hash) {
  if (!hash) return Promise.resolve()
  return openDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(hash)
      tx.oncomplete = function() { resolve() }
      tx.onerror = function() { resolve() }
    })
  }).catch(function() {})
}

export { saveDraft, getDraft, clearDraft }
