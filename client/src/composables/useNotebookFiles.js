/**
 * useNotebookFiles.js — file/project operations for a notebook, using the
 * File System Access API (browser save/open dialogs). Operates on a `nb`
 * (useNotebook result).
 */
import { state, aiSplitCode, loadImageB64, saveImageB64 } from '../store'
import { pickSaveFile } from './useFileDialog'
import { loadDir, ensureRW, writeToDir } from './usePersistentDir'
import { ref, watch } from 'vue'

export function useNotebookFiles(nb, opts = {}) {
  const title = () => opts.title || 'notebook'

  // ---- whether the .ipynb has unsaved code changes (blue/grey "存ipynb" button) ----
  const ipynbDirty = ref(false)
  let savedCellsJson = ''
  const cellsJson = () => { try { return JSON.stringify(nb.toJSON()) } catch (e) { return '' } }
  watch(cellsJson, (v) => { ipynbDirty.value = v !== savedCellsJson }, { immediate: true })

  // ---- import .R with AI auto-split (no code change) ----
  async function importR(file) {
    const text = await file.text()
    if (file.name) state.importDir = (file.name.split('/').slice(0, -1).join('/')) || state.importDir
    if (!text.trim()) return
    if (window.confirm('Use the AI to split this R script into code blocks automatically? (code content is not changed)\nOK = AI split, Cancel = simple split by blank lines/comments')) {
      const res = await aiSplitCode(text)
      if (res.ok && res.blocks.length) { nb.seedMany(res.blocks); return }
      window.alert('AI split failed, using simple split: ' + (res.error || ''))
    }
    nb.seedMany(simpleSplit(text))
  }
  function simpleSplit(text) {
    const blocks = []
    let cur = []
    const flush = () => { if (cur.join('\n').trim()) blocks.push(cur.join('\n')); cur = [] }
    for (const line of text.split('\n')) {
      // blank line -> end current block
      if (/^\s*$/.test(line) && cur.length) { flush(); continue }
      // a comment line starts a fresh (smaller) block, so imported code splits more finely
      if (/^\s*#/.test(line) && cur.length) { flush() }
      cur.push(line)
    }
    flush()
    return blocks.length ? blocks : [text]
  }

  // ---- import .ipynb ----
  async function importIpynb(file) {
    const text = await file.text()
    let j
    try { j = JSON.parse(text) } catch (e) { window.alert('Not a valid .ipynb file'); return }
    const codes = (j.cells || [])
      .filter((c) => c.cell_type === 'code')
      .map((c) => (Array.isArray(c.source) ? c.source.join('') : String(c.source || '')).trim())
      .filter(Boolean)
    if (!codes.length) { window.alert('This .ipynb has no code cells'); return }
    nb.seedMany(codes)
  }

  // ---- save as Jupyter .ipynb ----
  async function exportIpynb(paramsTitle) {
    const notebook = {
      nbformat: 4, nbformat_minor: 5,
      metadata: { kernelspec: { display_name: 'R', language: 'R', name: 'ir' }, language_info: { name: 'R' } },
      cells: nb.cells.value.map((c) => ({
        cell_type: 'code', execution_count: null,
        metadata: {}, outputs: [], source: splitLines(c.code),
      })),
    }
    const pick = await pickSaveFile((paramsTitle || title()) + '.ipynb', 'application/x-ipynb+json')
    if (!pick.ok) { if (pick.reason !== 'cancel') window.alert('Could not pick a save location (unsupported or cancelled)'); return }
    await pick.write(JSON.stringify(notebook, null, 1))
    // saved: record the snapshot so the 存ipynb button greys out until code changes again
    savedCellsJson = cellsJson()
    ipynbDirty.value = false
  }
  function splitLines(s) {
    const t = String(s || '')
    if (!t.includes('\n')) return t ? [t + '\n'] : []
    const lines = t.split('\n').map((l) => l + '\n')
    if (t.endsWith('\n')) lines.pop()
    return lines
  }

  // ---- save project: writes project.json + project.RData into the user's chosen 工程 folder ----
  // project.json (fast) completes immediately (no popup); the heavier .RData snapshot runs
  // in the background so "存工程" isn't blocked on saving the whole R environment.
  async function saveProject() {
    let dir = state.activeProject.src
    if (!dir) {
      const restored = await loadDir()
      if (restored && restored.handle) dir = restored.handle
    }
    if (!dir || typeof dir.getFileHandle !== 'function') {
      window.alert('No project folder yet. Pick one under "📁 New Project" first, then save the project.')
      return
    }
    const baseName = (state.activeProject.name) || dir.name || 'project'
    try {
      if (!(await ensureRW(dir))) {
        window.alert('No write permission. Allow it when prompted, then save again.')
        return
      }
      state.activeProject.src = dir
      if (!state.activeProject.name) state.activeProject.name = dir.name || baseName
      // 1) code cells manifest -> project.json (fast, completes the "save" action)
      const manifest = { app: 'r-analyzer', name: baseName, workDir: dir.name || '', rdata: baseName + '.RData', cells: nb.cells.value.map((c) => ({ code: c.code })) }
      await writeToDir(dir, 'project.json', JSON.stringify(manifest, null, 2))
      // 2) R workspace snapshot -> <baseName>.RData, in the background (no popup, no blocking)
      saveImageB64()
        .then((img) => {
          if (img.ok && img.b64) {
            const bytes = Uint8Array.from(atob(img.b64), (c) => c.charCodeAt(0))
            return writeToDir(dir, baseName + '.RData', bytes)
          }
        })
        .catch((e) => console.error('[save RData]', e))
    } catch (e) {
      // no popup on failure either; log so it can be investigated
      console.error('[save project]', e)
      window.alert('Failed to save project: ' + e.message)
    }
  }

  // ---- open project (manifest + auto-load RData from the same folder, no 2nd picker) ----
  async function openProject() {
    if (typeof window.showOpenFilePicker !== 'function') { window.alert('This browser does not support file dialogs'); return }
    const jsonHandle = await window.showOpenFilePicker({ types: [{ description: '工程', accept: { 'application/json': ['.json'] } }] }).catch(() => null)
    if (!jsonHandle || !jsonHandle[0]) return
    const file = await jsonHandle[0].getFile()
    const jsonContent = await file.text()
    try {
      const manifest = JSON.parse(jsonContent)
      if (Array.isArray(manifest.cells)) nb.seedMany(manifest.cells.map((c) => c.code || ''))
      // Auto-load the R workspace (<rdata>) from the same folder as project.json, if present.
      try {
        // prefer the recorded name; fall back to <folderName>.RData
        let rdataName = manifest && typeof manifest.rdata === 'string' ? manifest.rdata : null
        if (!rdataName) {
          const folderName = (jsonHandle[0].name || '').replace(/\.json$/i, '')
          rdataName = folderName + '.RData'
        }
        if (typeof jsonHandle[0].getParent === 'function') {
          const parent = await jsonHandle[0].getParent()
          if (parent && typeof parent.getFileHandle === 'function') {
            const rdHandle = await parent.getFileHandle(rdataName).catch(() => null)
            if (rdHandle) {
              const rdfile = await rdHandle.getFile()
              const img = await loadImageB64(await fileToBase64(rdfile))
              if (!img.ok && img.error) console.error('[open RData]', img.error)
            }
          }
        }
      } catch (e) { /* RData is optional; don't block opening the code */ }
      if (state.activeProject) state.activeProject.name = manifest.name || ''
    } catch (e) {
      window.alert('Could not parse the project file: ' + e.message)
    }
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader()
      rd.onload = () => resolve(String(rd.result).split(',')[1] || '')
      rd.onerror = reject
      rd.readAsDataURL(file)
    })
  }

  return { importR, importIpynb, exportIpynb, saveProject, openProject, ipynbDirty }
}
