/**
 * useFileDialog.js — thin wrapper over the File System Access API
 * (showSaveFilePicker / showDirectoryPicker). Lets the user pick a real
 * save location / folder. Only available in Chromium (Chrome/Edge) on secure
 * contexts (localhost qualifies). Returns null when unsupported or cancelled,
 * letting callers fall back.
 */
/** Does the browser expose the File System Access API save-picker? (Chromium + secure ctx) */
export function hasSavePicker() {
  return typeof window.showSaveFilePicker === 'function'
}
/** Does the browser expose showOpenFilePicker? */
export function hasOpenPicker() {
  return typeof window.showOpenFilePicker === 'function'
}
export { hasSavePicker as hasFileSystemAPI }

/**
 * Ask the user for a save location for a single file.
 * @param {string} suggestedName default filename
 * @param {string} mime MIME type (e.g. 'application/json')
 * @returns {Promise<{ok:true, name:string, write:(text|Blob)=>Promise} | {ok:false, reason:string}>}
 */
export async function pickSaveFile(suggestedName, mime = 'text/plain') {
  if (!hasSavePicker()) return { ok: false, reason: 'no-api' }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'File', accept: { [mime]: [extOf(suggestedName)] } }],
    })
    const writable = await handle.createWritable()
    return {
      ok: true,
      name: handle.name,
      write: async (content) => {
        await writable.write(content)
        await writable.close()
      },
    }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, reason: 'cancel' }
    return { ok: false, reason: String(e.message || e) }
  }
}

/** Ask the user to pick a directory; returns its handle + name + helpers. */
export async function pickDirectory() {
  if (typeof window.showDirectoryPicker !== 'function') return { ok: false, reason: 'no-api' }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
    return {
      ok: true,
      name: dir.name, // the folder name (used by the backend as the path)
      handle: dir,    // keep the raw handle so callers can write into it
      getFile: async (name) => {
        const fh = await dir.getFileHandle(name)
        return await fh.getFile()
      },
      hasFile: async (name) => {
        const it = await dir.entries()
        for await (const [n] of it) if (n === name) return true
        return false
      },
      /** Create/overwrite a file inside this folder. content: string, Blob, or ArrayBuffer. */
      writeFile: async (name, content) => {
        const fh = await dir.getFileHandle(name, { create: true })
        const w = await fh.createWritable()
        await w.write(content)
        await w.close()
        return { ok: true, name }
      },
    }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, reason: 'cancel' }
    return { ok: false, reason: String(e.message || e) }
  }
}

function extOf(name) {
  const i = String(name).lastIndexOf('.')
  return i >= 0 ? String(name).slice(i) : '*'
}

/**
 * Pick a single file to OPEN, starting in a chosen directory.
 * @param {FileSystemDirectoryHandle|string} startIn current 工程 folder handle, or a token
 *        like 'downloads'/'documents' (browser default) when no 工程 folder exists.
 * @returns {Promise<{ok:true, file:File} | {ok:false, reason:string}>}
 */
export async function pickOpenFile(startIn, label = '文件', mime = 'text/plain', ext = '.txt') {
  if (typeof window.showOpenFilePicker !== 'function') return { ok: false, reason: 'no-api' }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: label, accept: { [mime]: Array.isArray(ext) ? ext : [ext] } }],
      startIn: startIn || 'downloads',
    })
    return { ok: true, file: await handle.getFile(), name: handle.name }
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, reason: 'cancel' }
    return { ok: false, reason: String(e.message || e) }
  }
}
