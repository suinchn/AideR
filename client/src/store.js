import { reactive, watch } from 'vue'
import { io } from 'socket.io-client'
import { loadDir, writeToDir, ensureRW } from './composables/usePersistentDir'

const state = reactive({
  connected: false,
  serverState: null,   // {ready, rscript, rError, ai, settings}
  variables: [],        // variable snapshot
  execHistory: [],      // {id, code, ok, error, output, ts}
  aiEvents: [],         // [{id, type, ...}]
  notices: [],          // [{kind, message, ts}]
  editorSelection: '',   // currently selected text in the code editor (shared)
  approvalMode: false,    // AI runs code automatically; toggle on to require authorization
  importDir: '',          // directory of the last imported .R file (project workdir fallback)
  activeProject: { name: '', dir: '', src: null }, // dir = R working dir (backend), src = browser-picked files folder handle
  lastTargetCid: null,    // last "code-N-M" the user named; AI code goes into that block, else adds a new one
  aiLang: 'zh',           // AI output language ('zh' | 'en')
  uiFocus: '',            // which box has the "selected block" highlight ('main' | 'scratch')
  uiActiveEditorId: '',   // cell id of the block whose editor last had the cursor
  aiMemory: '',           // remembered notes for the current project (cross-session)
  aiPlan: false,          // ask the AI to produce a step-by-step plan first
  aiSkill: null,          // { name, label, prompt } reusable analysis skill
  lastPlan: null,         // latest step list from the AI ({ steps: [] })
  skills: [],             // skills loaded from the skills/ folder
})

let socket = null
const cellRunners = new Map() // id -> {resolve} for promise-based cell runs

const CHAT_LS = 'raaichat'
function persistChat() {
  try {
    const save = state.aiEvents
      .filter((m) => m.userText || (m.segments && m.segments.length))
      .map((m) => ({ id: m.id, userText: m.userText, segments: m.segments, ts: m.ts, status: 'done' }))
    localStorage.setItem(CHAT_LS, JSON.stringify(save))
  } catch (e) { /* ignore quota */ }
}
let chatSaveTimer = null
function scheduleChatPersist() { clearTimeout(chatSaveTimer); chatSaveTimer = setTimeout(persistChat, 400) }
watch(() => state.aiEvents.map((m) => m.segments?.length || 0), scheduleChatPersist, { deep: true })

function restoreChat() {
  try {
    const raw = localStorage.getItem(CHAT_LS)
    if (!raw) return
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length) {
      state.aiEvents.push(...arr.map((m) => ({
        id: (m.id || '') || ('ai-r' + Date.now() + Math.random().toString(36).slice(2, 6)),
        userText: m.userText || '',
        segments: m.segments || [],
        ts: m.ts || Date.now(),
        status: 'done',
        textStream: '', error: null,
      })))
    }
  } catch (e) { /* ignore */ }
}

function connect() {
  socket = io('/', { transports: ['websocket', 'polling'] })
  restoreChat() // restore previous AI chat history (browser refresh)

  // restore the persisted project folder handle (survives refresh)
  loadDir().then((d) => {
    if (d && d.handle) {
      state.activeProject.src = d.handle
      if (!state.activeProject.name && d.name) state.activeProject.name = d.name
    }
    // now that the project handle is restored, load its skills (if any)
    loadProjectSkills()
  })

  socket.on('connect', () => {
    state.connected = true
    loadSkills()
    loadProjectSkills()
  })
  socket.on('disconnect', () => { state.connected = false })

  socket.on('state', (s) => { state.serverState = s })
  socket.on('variables', (p) => { state.variables = p.variables || [] })
  socket.on('exec_result', (r) => {
    const last = state.execHistory.find((h) => h.id === r.id)
    if (last) Object.assign(last, { ok: r.ok, error: r.error, output: r.output, plot: r.plot || null })
    // resolve any pending cell-run for this id
    const cr = cellRunners.get(r.id)
    if (cr) { cellRunners.delete(r.id); cr.resolve({ ok: r.ok, error: r.error, output: r.output, plot: r.plot || null }) }
  })
  socket.on('ai', (ev) => {
    let entry = state.aiEvents.find((e) => e.id === ev.id)
    if (!entry) {
      entry = { id: ev.id, userText: '', ts: Date.now(), status: 'running',
                textStream: '', segments: [], error: null }
      state.aiEvents.push(entry)
    }
    applyAiEvent(entry, ev)
  })
  socket.on('notice', (n) => {
    state.notices.push({ ...n, ts: Date.now() })
  })
  socket.on('ai_edit_result', (r) => {
    rewriteListeners.forEach((fn) => { try { fn(r) } catch (e) {} })
  })
  socket.on('split_result', (r) => {
    splitListeners.forEach((fn) => { try { fn(r) } catch (e) {} })
  })
  socket.on('save_image_result', (r) => dispatchResultEvent('save_image_result', r))
  socket.on('write_file_result', (r) => dispatchResultEvent('write_file_result', r))
  socket.on('read_file_result', (r) => dispatchResultEvent('read_file_result', r))
  socket.on('settings', (p) => {
    if (state.serverState) state.serverState.settings = p.settings
  })
  socket.on('project_state', (p) => {
    state.activeProject = {
      name: (p && p.name) || '',
      dir: (p && p.dir) || '',
      src: state.activeProject.src, // keep the browser folder handle across project_state pushes
    }
  })
  socket.on('approval_mode', (p) => { state.approvalMode = p.enabled !== false })
  socket.on('skills_result', (r) => { if (r && Array.isArray(r.skills)) state.skills = r.skills })
}

function emit(event, payload) { if (socket) socket.emit(event, payload) }

function execute(code) {
  const id = 'exe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
  state.execHistory.push({ id, code, ok: null, error: null, output: '', plot: null, ts: Date.now() })
  emit('execute', { id, code })
  return id
}

/**
 * Run code in the shared R session and await its result (for notebook cells).
 * Resolves with {ok, error, output, plot} — does not clutter the results feed.
 */
function executeCell(code) {
  const id = 'exe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
  return new Promise((resolve) => {
    cellRunners.set(id, { resolve })
    emit('execute', { id, code })
  })
}

let chatSeq = 0
function askAI(text) {
  const id = 'ai-' + Date.now() + '-' + (chatSeq++).toString()
  const entry = { id, userText: text, segments: [], step: 0, status: 'running',
                  textStream: '', error: null, ts: Date.now() }
  state.aiEvents.push(entry)
  // remember a block the user named (codeN-M for code windows, scratch-M for scratch)
  // so AI code lands there; null = add a new block
  const t = String(text || '')
  const mc = t.match(/code(\d+)-(\d+)/i)
  const ms = t.match(/scratch-(\d+)/i)
  state.lastTargetCid = mc ? `code${mc[1]}-${mc[2]}` : (ms ? `scratch-${ms[1]}` : null)
  state.lastPlan = null
  emit('chat', {
    id, text, cells: collectCells(), lang: state.aiLang,
    memory: state.aiMemory, plan: state.aiPlan, skill: state.aiSkill,
    // if the user hasn't pinned a skill, offer the available skills so the AI can pick one itself
    skillList: state.aiSkill ? [] : state.skills,
  })
}

/** AI 输出语言：'zh' 中文 / 'en' English（此后 AI 生成内容按此语言）。 */
function setAiLang(l) {
  state.aiLang = l === 'en' ? 'en' : 'zh'
  try { localStorage.setItem('raailang', state.aiLang) } catch (e) {}
}
// restore persisted AI language
try { if (localStorage.getItem('raailang') === 'en') state.aiLang = 'en' } catch (e) {}

// ---- per-project AI memory: a real `memory.md` file inside the project folder ----
const MEMORY_FILENAME = 'memory.md'

async function persistAiMemory() {
  const h = state.activeProject && state.activeProject.src
  if (h) {
    try { await writeToDir(h, MEMORY_FILENAME, state.aiMemory || '') } catch (e) { console.error('[memory write]', e) }
  } else {
    try { localStorage.setItem('raMemory_fallback', state.aiMemory) } catch (e) {}
  }
}
async function loadAiMemory() {
  state.lastPlan = null
  const h = state.activeProject && state.activeProject.src
  if (h && typeof h.getFileHandle === 'function') {
    try {
      const fh = await h.getFileHandle(MEMORY_FILENAME).catch(() => null)
      if (fh) {
        const file = await fh.getFile()
        state.aiMemory = await file.text()
      } else {
        state.aiMemory = ''
      }
      return
    } catch (e) { /* fall through to fallback */ }
  }
  try { state.aiMemory = localStorage.getItem('raMemory_fallback') || '' } catch (e) { state.aiMemory = '' }
}
function clearAiMemory() {
  state.aiMemory = ''
  state.lastPlan = null
  // best-effort remove the memory.md from the project folder too
  const h = state.activeProject && state.activeProject.src
  if (h && typeof h.removeEntry === 'function') {
    try { h.removeEntry(MEMORY_FILENAME).catch(() => {}) } catch (e) {}
  }
}
function setAiPlan(on) { state.aiPlan = !!on }
function setAiSkill(skill) { state.aiSkill = skill ? { ...skill } : null }
function loadSkills() {
  emit('get_skills', {})
}
/* Create the project folder's `skills/` directory if missing (so the user has a
   ready place to drop skill folders). Call after creating/opening a project. */
async function ensureProjectSkillsDir() {
  const root = state.activeProject && state.activeProject.src
  if (!root || typeof root.getDirectoryHandle !== 'function') return
  try {
    await root.getDirectoryHandle('skills', { create: true })
  } catch (e) { /* ignore */ }
}
/* Parse a skill's text (first '# label' line -> label, rest -> prompt). */
function parseSkillText(name, txt) {
  const lines = String(txt || '').replace(/\r\n/g, '\n').split('\n')
  const labelLine = lines.find((l) => /^\s*#\s*/.test(l)) || ''
  return {
    name,
    label: labelLine.replace(/^\s*#\s*/, '').trim() || name,
    prompt: lines.filter((l) => l !== labelLine).join('\n').trim(),
  }
}
/* Read skills from the current project folder's `skills/` dir (a folder per skill) and
   merge them into state.skills. Called after picking a project folder. */
async function loadProjectSkills() {
  const root = state.activeProject && state.activeProject.src
  if (!root || typeof root.getDirectoryHandle !== 'function') return
  // ensure read/write access (restored handles may need a one-time permission prompt)
  const okPerm = await ensureRW(root)
  if (!okPerm) return
  try {
    const skDir = await root.getDirectoryHandle('skills', { create: false }).catch(() => null)
    if (!skDir) return
    const added = []
    const it = skDir.entries()
    for await (const [name, handle] of it) {
      if (handle && handle.kind === 'directory') {
        // a folder per skill; file is skill.md (fall back to any .md/.txt)
        let txt = ''
        const innerIt = handle.entries()
        const found = []
        for await (const [fname, fh] of innerIt) { found.push([fname, fh]) }
        const pick = found.find(([f]) => f === 'skill.md') || found.find(([f]) => /\.(md|txt)$/i.test(f))
        if (pick) txt = await (await pick[1].getFile()).text()
        if (txt) added.push(parseSkillText(name, txt))
      } else if (/\.(md|txt)$/i.test(name)) {
        const txt = await (await handle.getFile()).text()
        added.push(parseSkillText(name.replace(/\.(md|txt)$/i, ''), txt))
      }
    }
    if (added.length) {
      // merge: project skills override/add global ones by name
      const merged = state.skills.filter((g) => !added.some((p) => p.name === g.name))
      state.skills = merged.concat(added)
    }
  } catch (e) { /* no project skills */ }
}

// ---- notebook cell snapshot collection (so the AI can read the code cells) ----
const notebookSnapshots = []
/** Register a notebook's snapshot provider; returns an unsubscribe so panels that are
 *  no longer mounted (e.g. switched-away code tabs) stop contributing cells. */
function registerNotebook(fn) {
  notebookSnapshots.push(fn)
  return () => { const i = notebookSnapshots.indexOf(fn); if (i !== -1) notebookSnapshots.splice(i, 1) }
}
function collectCells() {
  const out = []
  notebookSnapshots.forEach((fn) => { const c = fn(); if (c) out.push(...c) })
  return out
}
/** Public: currently collected code cells (for #代码块N / ## expansion). */
function getCellsSnapshot() {
  return collectCells()
}

function applyAiEvent(entry, ev) {
  switch (ev.type) {
    case 'assistant_delta':
      entry.textStream += ev.delta || ''
      break
    case 'memory':
      if (ev.content) {
        state.aiMemory = (state.aiMemory ? state.aiMemory + '\n' : '') + ev.content
        persistAiMemory().catch(() => {})
      }
      break
    case 'plan':
      state.lastPlan = { steps: (ev.steps || []).slice() }
      break
    case 'segments':
      // append this turn's blocks to the conversation (multi-step agent emits
      // a new segments event per turn; replacing would wipe earlier steps).
      {
        const newSegs = (ev.segments || []).map((s) => ({
          kind: s.kind, content: s.content, result: null,
        }))
        entry.segments = entry.segments.concat(newSegs)
        // 让 AI 自动把代码块写到编号对应的窗/块；无编号则新增一块
        newSegs.forEach((s) => {
          if (s.kind === 'code' && s.content) {
            const mode = state.lastTargetCid ? 'cid-run' : 'append-run'
            // cid-run 广播给所有代码窗，由窗口序号匹配者写入；append-run 只进主代码窗
            const target = state.lastTargetCid ? '*' : 'main'
            emitAiInsert(s.content, target, mode, state.lastTargetCid)
          }
        })
        // append this turn's display text (tags stripped) to the stream
        const clean = (ev.fullContent || '')
          .replace(/<r_code>[\s\S]*?<\/r_code>/g, '')
          .replace(/<r_inspect>[\s\S]*?<\/r_inspect>/g, '')
          .trim()
        if (clean) entry.textStream = (entry.textStream ? entry.textStream + '\n\n' : '') + clean
        break
      }
    case 'r_exec_result': {
      // attach this block's outcome to the matching (next unmatched) code segment
      const seg = entry.segments.find((s) => s.kind === 'code' && s.content === ev.code && !s.result)
      const outcome = { ok: ev.ok, error: ev.error, output: ev.output, plot: ev.plot || null }
      if (seg) seg.result = outcome
      // clear any pending-authorization marker on this segment
      entry.segments.forEach((s2) => { if (s2.kind === 'code' && s2.content === ev.code) s2.pendingToken = null })
      break
    }
    case 'r_skipped': {
      const seg = entry.segments.find((s) => s.kind === 'code' && s.content === ev.code && !s.result)
      if (seg) { seg.result = { ok: false, error: null, output: '', skipped: true }; seg.pendingToken = null }
      break
    }
    case 'approval_needed': {
      // mark the matching (next unmatched) code segment as awaiting authorization
      const seg = entry.segments.find((s) => s.kind === 'code' && (s.content === ev.code) && !s.result)
      if (seg) seg.pendingToken = ev.token
      break
    }
    case 'inspect_result': {
      // attach inspected content to the matching inspect segment
      const seg = entry.segments.find((s) => s.kind === 'inspect' && s.content === ev.expr && !s.result)
      const outcome = { ok: ev.ok, error: ev.error, output: ev.content, inspect: true }
      if (seg) seg.result = outcome
      break
    }
    case 'done':
      entry.status = 'done'
      entry.step = ev.step
      break
    case 'max_steps':
      entry.status = 'done'
      entry.error = ev.message
      break
    case 'error':
      entry.status = 'error'
      entry.error = ev.message
      break
  }
  if (ev.type === 'variables') { /* handled globally by 'variables' event */ }
}

function clearExec() { state.execHistory.length = 0 }

/** Delete a variable from the shared R session (no result-log clutter). */
function removeVar(name) {
  emit('remove_var', { name: String(name) })
}

/** Clear all user variables from the shared R session. */
function clearVars() {
  emit('clear_vars', {})
}

/** Ask the backend to write a file into the configured export directory. */
function exportFile(filename, content) {
  emit('export_file', { filename, content: String(content ?? '') })
}

/** Grant/deny the pending AI code segment identified by token. */
function approveCode(token, allowed) {
  emit('approve_code', { token, allowed: !!allowed })
}
/** Toggle "require user authorization before AI runs code". */
function setApprovalMode(enabled) {
  state.approvalMode = !!enabled
  emit('set_approval_mode', { enabled: !!enabled })
}

// ---- AI rewrite/edit of editor selection ----
const rewriteListeners = []
let rewriteSeq = 0
function onAiEditResult(fn) { rewriteListeners.push(fn) }
/** Asks the AI to rewrite `code`; resolve is called with {ok, content, error} when done.
 *  opts.showInChat: true → surface the AI's process + result into the AI chat window. */
function aiEditSelection(code, instruction, opts = {}) {
  return new Promise((resolve) => {
    const id = 'ae-' + Date.now() + '-' + (rewriteSeq++).toString() + '-' + Math.random().toString(36).slice(2, 6)
    let chatEntry = null
    if (opts.showInChat) {
      const label = opts.label || 'AI 改写代码'
      chatEntry = {
        id,
        userText: (instruction ? `[${label}] ${instruction}` : label),
        segments: [],
        step: 0, status: 'running', textStream: '', error: null, ts: Date.now(),
      }
      state.aiEvents.push(chatEntry)
      // IMPORTANT: re-fetch the reactive PROXY from the array. Mutating the
      // original object would bypass Vue reactivity and the UI wouldn't update
      // until some other change (e.g. font) forces a re-render.
      chatEntry = state.aiEvents[state.aiEvents.length - 1]
    }
    let acc = ''
    const handler = (r) => {
      if (r.id !== id) return
      if (r.type === 'delta') {
        acc += r.delta || ''
        if (chatEntry) {
          // show clean streaming text (strip <r_code> tags) for real-time display
          chatEntry.textStream = acc.replace(/<r_code>[\s\S]*?<\/r_code>/g, '').trim()
        }
      } else if (r.type === 'done') {
        removeRewriteListener(handler)
        if (chatEntry) {
          chatEntry.textStream = ''
          if (r.ok && r.content) {
            chatEntry.segments = []
            if (r.explanation) chatEntry.segments.push({ kind: 'text', content: r.explanation })
            chatEntry.segments.push({ kind: 'code', content: r.content, result: { ok: true, output: '' } })
          } else if (r.error) {
            chatEntry.segments = [{ kind: 'text', content: '失败：' + r.error }]
          }
          chatEntry.status = 'done'
        }
        resolve({ ok: r.ok, content: r.content, explanation: r.explanation, error: r.error })
      } else if (r.type === 'error') {
        removeRewriteListener(handler)
        if (chatEntry) { chatEntry.status = 'error'; chatEntry.error = r.message }
        resolve({ ok: false, content: '', error: r.message })
      }
    }
    rewriteListeners.push(handler)
    emit('ai_edit', { id, code, instruction })
  })
}
function removeRewriteListener(fn) {
  const i = rewriteListeners.indexOf(fn)
  if (i !== -1) rewriteListeners.splice(i, 1)
}

// ---- project / file persistence (promise-based) ----
const onceHandlers = new Map() // resultEvent -> resolver
/** Emit `event`; resolve when `resultEvent` arrives (or timeout). */
function emitAndAwait(event, payload, resultEvent, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const resolver = (r) => { onceHandlers.delete(resultEvent); clearTimeout(timer); resolve(r) }
    onceHandlers.set(resultEvent, resolver)
    emit(event, payload)
    const timer = setTimeout(() => { onceHandlers.delete(resultEvent); resolve({ ok: false, error: '超时' }) }, timeoutMs)
  })
}
function dispatchResultEvent(name, r) {
  const h = onceHandlers.get(name)
  if (h) h(r)
}
async function saveImage(path) { return emitAndAwait('save_image', { path }, 'save_image_result') }
async function loadImage(path) { return emitAndAwait('load_image', { path }, 'save_image_result') }
async function saveImageB64() { return emitAndAwait('save_image_b64', {}, 'save_image_result') }
async function loadImageB64(b64) { return emitAndAwait('load_image_b64', { b64 }, 'save_image_result') }
async function writeFile(path, content) { return emitAndAwait('write_file', { path, content }, 'write_file_result') }
async function readFile(path) { return emitAndAwait('read_file', { path }, 'read_file_result') }

/** Ask the AI to split an R script into code blocks (import, no code change). */
function aiSplitCode(code) {
  return new Promise((resolve) => {
    const id = 'sp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    const handler = (r) => {
      if (r.id !== id) return
      if (r.type === 'done') { removeRewHandler(); resolve({ ok: r.ok, blocks: r.blocks || [], error: r.error }) }
      else if (r.type === 'error') { removeRewHandler(); resolve({ ok: false, blocks: [], error: r.message }) }
    }
    const removeRewHandler = () => {
      const i = splitListeners.indexOf(handler)
      if (i !== -1) splitListeners.splice(i, 1)
    }
    splitListeners.push(handler)
    emit('split_code', { id, code })
  })
}
const splitListeners = []

/**
 * Natural-language edit of the editor's selected code (or append new code).
 * `target` ('main'|'scratch') chooses which code window to apply to.
 * Returns a promise of {ok, content, error}.
 */
function aiRewriteToEditor(text, target = 'main') {
  const selection = state.editorSelection || ''
  return aiEditSelection(selection, text).then((res) => {
    if (res.ok && res.content) {
      emitAiInsert(res.content, target) // CodePanel/ScratchPanel applies
    }
    return res
  })
}

// ---- lightweight in-app event bus (no external dep) ----
const insertListeners = []  // {fn, target}
/** Subscribe to AI-insert bus; returns an unsubscribe function (call on unmount). */
function onAiInsert(fn, target = '*') {
  insertListeners.push({ fn, target })
  return () => {
    const i = insertListeners.findIndex((l) => l.fn === fn)
    if (i !== -1) insertListeners.splice(i, 1)
  }
}
function emitAiInsert(code, target = 'main', mode = 'append', cid = null) {
  insertListeners.forEach(({ fn, target: t }) => {
    // cid-run must reach EVERY window panel so the one whose number matches can write it
    const match = mode === 'cid-run' ? true : (t === '*' || t === target)
    if (match) { try { fn(code, mode, cid) } catch (e) {} }
  })
}

// ---- workspace reset (清空代码窗 + AI 对话)，用于「新建工程」时回归干净界面 ----
const resetListeners = []
function onResetWorkspace(fn) {
  resetListeners.push(fn)
  return () => { const i = resetListeners.indexOf(fn); if (i !== -1) resetListeners.splice(i, 1) }
}
// ---- request to save the project (main code window responds) ----
const saveListeners = []
function onSaveProject(fn) {
  saveListeners.push(fn)
  return () => { const i = saveListeners.indexOf(fn); if (i !== -1) saveListeners.splice(i, 1) }
}
function emitSaveProject() {
  saveListeners.forEach((fn) => { try { fn() } catch (e) {} })
}
// ---- request to run the current line/selection (the focused code block responds) ----
const runCurListeners = []
function onRunCurrent(fn) {
  runCurListeners.push(fn)
  return () => { const i = runCurListeners.indexOf(fn); if (i !== -1) runCurListeners.splice(i, 1) }
}
function emitRunCurrent() {
  runCurListeners.forEach((fn) => { try { fn() } catch (e) {} })
}
// ---- request to open a project (main code window responds) ----
const openListeners = []
function onOpenProject(fn) {
  openListeners.push(fn)
  return () => { const i = openListeners.indexOf(fn); if (i !== -1) openListeners.splice(i, 1) }
}
function emitOpenProject() {
  openListeners.forEach((fn) => { try { fn() } catch (e) {} })
}
function emitResetWorkspace() {
  // clear AI chat + execution history (persisted chat is wiped too)
  state.aiEvents.length = 0
  state.execHistory.length = 0
  persistChat()
  // clear the per-project AI memory (new project = fresh start)
  clearAiMemory()
  // clear the R session variables (Variables window) and default AI to AUTO-RUN (no auth popup)
  clearVars()
  setApprovalMode(false)
  resetListeners.forEach((fn) => { try { fn() } catch (e) {} })
}

export { state, connect, emit, execute, executeCell, askAI, setAiLang, loadAiMemory, clearAiMemory, setAiPlan, setAiSkill, loadProjectSkills, ensureProjectSkillsDir, clearExec, removeVar, clearVars, onAiInsert, emitAiInsert, onResetWorkspace, emitResetWorkspace, onSaveProject, emitSaveProject, onOpenProject, emitOpenProject, onRunCurrent, emitRunCurrent, aiEditSelection, aiSplitCode, onAiEditResult, aiRewriteToEditor, exportFile, approveCode, setApprovalMode, registerNotebook, getCellsSnapshot, saveImage, loadImage, saveImageB64, loadImageB64, writeFile, readFile }
