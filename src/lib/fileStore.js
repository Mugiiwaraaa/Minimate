/* --- fileStore.js --- On-device drawing file cache ---
   Files are cached in IndexedDB keyed by SHA-256 content hash.
   The project JSONB stores only the hash + pins + traces (kilobytes).
   Later, get() can fall through to cloud storage (R2 / Supabase Storage)
   without changing any caller. */

var DB_NAME = 'minimate-files'
var STORE = 'files'

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

function hashFile(file) {
  return file.arrayBuffer().then(function(buf) {
    return crypto.subtle.digest('SHA-256', buf)
  }).then(function(digest) {
    var bytes = new Uint8Array(digest)
    var hex = ''
    for (var i = 0; i < bytes.length; i++) {
      hex += ('0' + bytes[i].toString(16)).slice(-2)
    }
    return hex
  })
}

/* Store a File. Resolves with its content hash. */
function putFile(file) {
  return hashFile(file).then(function(hash) {
    return openDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put({
          hash: hash,
          name: file.name || 'drawing',
          type: file.type || 'application/pdf',
          size: file.size,
          blob: file,
          storedAt: new Date().toISOString()
        })
        tx.oncomplete = function() { resolve(hash) }
        tx.onerror = function() { reject(tx.error || new Error('IndexedDB write failed')) }
      })
    })
  })
}

/* Get a cached file by hash. Resolves with a File, or null if not on this device. */
function getFile(hash) {
  if (!hash) return Promise.resolve(null)
  return openDb().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(STORE, 'readonly')
      var req = tx.objectStore(STORE).get(hash)
      req.onsuccess = function() {
        var rec = req.result
        if (!rec || !rec.blob) { resolve(null); return }
        resolve(new File([rec.blob], rec.name, { type: rec.type }))
      }
      req.onerror = function() { resolve(null) }
    })
  }).catch(function() { return null })
}

function hasFile(hash) {
  return getFile(hash).then(function(f) { return !!f })
}

export { putFile, getFile, hasFile, hashFile }
