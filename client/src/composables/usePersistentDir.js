/**
 * usePersistentDir.js — persist a browser FileSystemDirectoryHandle across refreshes
 * using IndexedDB. A FileSystemDirectoryHandle is structured-cloneable, so storing it
 * in IndexedDB lets us recover the user's chosen project folder after a page reload
 * (the handle itself is otherwise lost on refresh).
 *
 * Exposes (functions, no component state):
 *   saveDir(handle)  -> {ok}            store {name, handle} under key 'dir'
 *   loadDir()        -> {name, handle} | null
 *   ensureRW(handle) -> boolean         request read/write permission (may prompt once)
 */

const DB_NAME = 'ra_project'
const STORE = 'files'

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('浏览器不支持 IndexedDB')); return }
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'))
  })
}

export async function saveDir(handle) {
  if (!handle || typeof handle.name !== 'string') return { ok: false, error: '无效的文件夹' }
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ name: handle.name, handle }, 'dir')
      tx.oncomplete = () => resolve({ ok: true })
      tx.onerror = () => resolve({ ok: false, error: '保存文件夹授权失败' })
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function loadDir() {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get('dir')
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    })
  } catch (e) {
    return null
  }
}

/** Ensure the handle has read/write permission (may prompt the user once). */
export async function ensureRW(handle) {
  if (!handle) return false
  try {
    if (typeof handle.queryPermission === 'function') {
      const p = await handle.queryPermission({ mode: 'readwrite' })
      if (p === 'granted') return true
    }
    if (typeof handle.requestPermission === 'function') {
      const r = await handle.requestPermission({ mode: 'readwrite' })
      return r === 'granted'
    }
    return typeof handle.getFileHandle === 'function' // older / optimistic fallback
  } catch (e) {
    return false
  }
}

/**
 * Write a file into a FileSystemDirectoryHandle using the native File System Access API.
 * content may be a string, Blob, or ArrayBuffer. Returns {ok, name} or throws on error.
 */
export async function writeToDir(handle, name, content) {
  const fh = await handle.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(content)
  await w.close()
  return { ok: true, name }
}
