<template>
  <div class="nb-panel">
    <div class="toolbar">
      <button class="btn clear-all" @click="clearAll" :title="t('clearAllTip')">{{ t('clearAll') }}</button>
      <template v-if="files">
        <button class="btn" @click="doImportR" :title="t('importRTip')">{{ t('importR') }}</button>
        <button class="btn" @click="doImportIpynb" :title="t('importItip')">{{ t('importIpynb') }}</button>
        <button class="btn" @click="files.exportIpynb()" :disabled="!files.ipynbDirty.value" :title="files.ipynbDirty.value ? t('saveIpynbTip') : t('ipynbSaved')">{{ t('saveIpynb') }}</button>
      </template>
      <button class="btn" @click="add" :title="t('addBlockTip')" :disabled="!connected">{{ t('addBlock') }}</button>
      <span class="spacer"></span>
      <button class="btn run-all" @click="runAll" :disabled="!connected || nb.runningAll.value" :title="t('runAllTip')">
        {{ nb.runningAll.value ? t('running') : t('runAll') }}
      </button>
      <button class="btn run-cur" @click="emitRunCurrent()" :title="'Run the selected code; if nothing is selected, expand to the whole logical expression'">▶❘ {{ t('runCurrent') }}</button>
    </div>
    <div class="pause-banner" v-if="nb.pausedAt.value >= 0">
      <div class="pause-txt">
        ⛔ {{ t('outErrBlock', nb.pausedAt.value + 1) }}
        <span class="pause-err">{{ ((nb?.cells?.value)||[])[nb.pausedAt.value]?.error }}</span>
      </div>
      <div class="pause-btns">
        <button class="btn fix" @click="aiFixResume" :disabled="fixResumeBusy">
          {{ fixResumeBusy ? t('aiFixing') : t('fixResume') }}
        </button>
        <button class="btn" @click="skipResume" :disabled="fixResumeBusy">{{ t('skipCont') }}</button>
        <button class="btn" @click="nb.resumeFrom(nb.pausedAt.value + 1)" :disabled="fixResumeBusy">{{ t('retryBlock') }}</button>
      </div>
    </div>
    <div class="cells-wrap">
      <div class="empty" v-if="!((nb?.cells?.value)||[]).length">{{ t('emptyCells') }}</div>
      <NotebookCell
        v-for="(c, i) in ((nb?.cells?.value)||[])"
        :key="c.id"
        :cell="c"
        :index="i"
        :is-last="i === ((nb?.cells?.value)||[]).length - 1"
        :is-active="isFocusWin && nb.activeIndex.value === i"
        :cell-id="cidFor(i)"
        :font-size="codeFont"
        @run="nb.runCell(i)"
        @run-sel="runSelectionInCell(i, $event)"
        @insert="nb.insertAfter(i)"
        @up="nb.moveUp(i)"
        @down="nb.moveDown(i)"
        @aiEdit="aiEditCell(i)"
        @remove="nb.del(i)"
        @active="focusCell(i)"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import NotebookCell from './NotebookCell.vue'
import { state, onAiInsert, registerNotebook, aiEditSelection, onSaveProject, onOpenProject, executeCell, emitRunCurrent } from '../store'
import { useNotebookFiles } from '../composables/useNotebookFiles'
import { useCodeFont } from '../composables/useCodeFont'
import { useI18n } from '../composables/useI18n'
import { pickOpenFile } from '../composables/useFileDialog'

const { t } = useI18n()

const props = defineProps({
  nb: { type: Object, required: true },      // useNotebook() result
  title: { type: String, default: '' },
  winCode: { type: String, default: '' },   // stable window ordinal (overrides title parsing) so renames don't break ids
  initialCode: { type: String, default: '' },
  initialCells: { type: Array, default: () => [] }, // optional list of starter codes
  insertTarget: { type: String, default: 'main' }, // which AI-insert bus to listen on
})

const connected = computed(() => state.connected)
// only the window the user is currently using shows the "selected block" highlight
const isFocusWin = computed(() => state.uiFocus === props.insertTarget)
function focusCell(i) {
  props.nb.setActive(i)
  state.uiFocus = props.insertTarget
}

// code font size (shared via localStorage so Code title-bar A−/A+ also affects cells)
const { codeFont } = useCodeFont()

// 窗口序号：优先用面板传入的稳定 winCode（改名不影响）；否则从标题末尾数字提取兜底。
const winCode = computed(() => {
  if (props.winCode != null && String(props.winCode).trim()) return String(props.winCode).trim()
  const n = String(props.title || '').match(/(\d+)\s*$/)
  return n ? n[1] : '0'
})
// 是否临时窗（Scratch）：其代码块编号用独立前缀 scratch-M，避免和主代码窗的 code2… 冲突
const isScratch = computed(() => props.insertTarget === 'scratch' || /scratch|临时/i.test(String(props.title || '')))
function cidFor(idx) {
  return isScratch.value ? `scratch-${idx + 1}` : `code${winCode.value}-${idx + 1}`
}

// file operations act on this window's notebook
const files = useNotebookFiles(props.nb, { title: props.title })
// 导入的默认目录：有工程就用当前工程文件夹；未建工程则用系统下载目录。
function importStartDir() {
  const src = state.activeProject && state.activeProject.src
  if (src) return src
  return 'downloads'
}
async function doImportR() {
  const r = await pickOpenFile(importStartDir(), 'R script', 'text/plain', ['.R', '.r', '.txt'])
  if (r.ok && r.file) files.importR(r.file)
}
async function doImportIpynb() {
  const r = await pickOpenFile(importStartDir(), 'Jupyter notebook', 'application/x-ipynb+json', ['.ipynb', '.json'])
  if (r.ok && r.file) files.importIpynb(r.file)
}

function add() { props.nb.insertAfter(Math.max(0, props.nb.cells.value.length - 1)) }
function clearAll() {
  if (window.confirm(t('clearAllQs'))) props.nb.clear()
}
function runAll() { props.nb.runAll() }
function resumeFrom(i) { props.nb.resumeFrom(i) }

// Run just the selected code (or the current line), showing the result in this block.
async function runSelectionInCell(i, code) {
  const cell = props.nb.cells.value[i]
  if (!cell || !code || !String(code).trim()) return
  cell.status = 'running'; cell.error = null; cell.output = ''; cell.plot = null
  try {
    const res = await executeCell(String(code))
    if (res.ok) { cell.status = 'done'; cell.output = res.output || ''; cell.plot = res.plot || null }
    else { cell.status = 'error'; cell.error = res.error || 'Error'; cell.output = res.output || '' }
  } catch (e) {
    cell.status = 'error'; cell.error = (e && e.message) || 'Error'
  }
}

const aiBusyIdx = ref(-1)
const fixResumeBusy = ref(false)
let offInsert = null // AI-insert bus subscription (declared here so onMounted/onBeforeUnmount can both reach it)
let offCells = null // notebook snapshot provider (so switched-away tabs stop feeding the AI)
let offSave = null // save-project request listener (main code window saves on "new project")
let offOpen = null // open-project request listener (main code window opens on top-bar button)

async function aiEditCell(i) {
  const cell = props.nb.cells.value[i]
  if (!cell || aiBusyIdx.value >= 0) return
  const instruction = window.prompt(t('promptEdit'), '')
  if (instruction === null) return
  aiBusyIdx.value = i
  try {
    await rewriteCell(i, cell.code, instruction || 'Optimize this code', `Rewrite code block ${i + 1}`)
  } finally {
    aiBusyIdx.value = -1
  }
}

async function rewriteCell(i, code, instruction, label = 'AI rewrite code') {
  const res = await aiEditSelection(code, instruction, { showInChat: true, label })
  const cell = props.nb.cells.value[i]
  if (!cell) return
  if (res.ok && res.content) {
    props.nb.updateCode(i, res.content)
    cell.status = 'idle'; cell.output = ''; cell.error = null; cell.plot = null
  } else if (!res.ok) {
    window.alert(t('aiRewriteFail') + ' ' + (res.error || t('noCode')))
  }
  return res
}

// Stage III: pause-resume with AI fix
async function aiFixResume() {
  const i = props.nb.pausedAt.value
  if (i < 0 || fixResumeBusy.value) return
  const cell = props.nb.cells.value[i]
  if (!cell) return
  fixResumeBusy.value = true
  try {
    const instruction = `This code errored when run: ${cell.error || ''}. Fix it so it runs correctly. If the error is because a variable/package wasn't defined earlier, add the necessary setup steps.`
    await rewriteCell(i, cell.code, instruction, `Fix code block ${i + 1}`)
    // re-run the fixed cell; if still error, keep paused; else resume from i+1
    const r = await props.nb.runCell(i)
    if (r.status === 'error') { props.nb.pausedAt.value = i }
    else { await props.nb.resumeFrom(i + 1) }
  } finally {
    fixResumeBusy.value = false
  }
}

function skipResume() {
  const i = props.nb.pausedAt.value
  if (i < 0) return
  props.nb.resumeFrom(i + 1)
}

onMounted(() => {
  // Seed default starter cells ONLY the first time a notebook mounts (so
  // switching windows and coming back does NOT re-apply defaults after the
  // user deleted cells). Track with a non-reactive-ish flag on the (markRaw) nb.
  if (!props.nb._seededInitially) {
    props.nb._seededInitially = true
    if (!props.nb.cells.value.length) {
      if (props.initialCells && props.initialCells.length) props.nb.seedMany(props.initialCells)
      else if (props.initialCode) props.nb.seed(props.initialCode)
      else props.nb.addCell('') // 空白但自带一个空块，方便直接输入
    }
  }
  // register this notebook's cells so the AI can read them (and reference their code-N-M id)
  // each cell carries `window` (tab title) + `cid` (unique id) so the AI can tell tabs/blocks apart
  offCells = registerNotebook(() => props.nb.cells.value.map((c, idx) => ({
    window: props.title || '',
    cid: cidFor(idx),
    status: c.status, code: c.code, output: c.output, error: c.error,
  })))
  // receive AI-written code for this window (append new cell, or replace active)
  // IMPORTANT: keep the unsubscribe fn; drop it on unmount so a panel isn't still
  // mounted-and-listening to the 'main'/'scratch' bus after being recycled/recreated
  // (otherwise "到主代码窗" would fire into stale instances too).
  offInsert = onAiInsert((code, mode, cid) => {
    if (mode === 'replace') {
      props.nb.replaceActive(code)
      return
    }
    if (mode === 'cid-run' && cid) {
      // user named a target block (codeN-M for code windows, scratch-M for the scratch window):
      // only THIS matching window writes; otherwise ignore.
      const cidStr = String(cid)
      let targetIdx = -1
      if (isScratch.value) {
        const ms = cidStr.match(/^scratch-(\d+)$/i)
        targetIdx = ms ? Number(ms[1]) - 1 : -1
      } else {
        const mc = cidStr.match(/^code(\d+)-(\d+)$/i)
        targetIdx = (mc && winCode.value === mc[1]) ? Number(mc[2]) - 1 : -1
      }
      const cells = props.nb.cells.value
      if (targetIdx >= 0 && cells[targetIdx]) {
        props.nb.updateCode(targetIdx, code)
        props.nb.runCell(targetIdx)
      }
      return
    }
    // append-run / append: always add a new block and run (no "selected block" reliance)
    const i = props.nb.insertAfter(Math.max(0, props.nb.cells.value.length - 1), code)
    if (mode === 'append-run') props.nb.runCell(i)
  }, props.insertTarget)
  // 新建工程时自动保存：主代码窗响应保存请求（临时窗不重复存）
  if (props.insertTarget === 'main') {
    offSave = onSaveProject(() => files.saveProject())
    offOpen = onOpenProject(() => files.openProject())
  }
})
onBeforeUnmount(() => {
  if (offInsert) offInsert(); if (offCells) offCells(); if (offSave) offSave(); if (offOpen) offOpen()
})
</script>

<style scoped>
.nb-panel { flex: 1; height: 100%; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.toolbar { display: flex; gap: 8px; padding: 8px; border-bottom: 1px solid var(--border); align-items: center; flex-wrap: wrap; flex: 0 0 auto; }
.btn {
  background: var(--bg-elev); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12.5px;
}
.btn:hover:not(:disabled) { border-color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.clear-all:hover { color: var(--err); border-color: var(--err); }
.btn.fix { background: #17452b; color: #7fd6a5; border-color: #2f6a44; font-weight: 600; }
.spacer { flex: 1; }
.hint { color: var(--text-dim); font-size: 11.5px; }
.pause-banner { display: flex; align-items: center; gap: 12px; padding: 8px; border-bottom: 1px solid var(--err); background: rgba(255,93,108,.08); flex-wrap: wrap; flex: 0 0 auto; }
.pause-txt { color: var(--err); font-size: 12.5px; }
.pause-err { display: block; color: var(--err); font-family: var(--mono); font-size: 11.5px; margin-top: 2px; opacity: 0.9; }
.pause-btns { display: flex; gap: 6px; margin-left: auto; }
.cells-wrap { flex: 1 1 0; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 8px; display: flex; flex-direction: column; gap: 8px; scrollbar-gutter: stable; }
.cells-wrap::-webkit-scrollbar { width: 10px; }
.cells-wrap::-webkit-scrollbar-track { background: transparent; }
.cells-wrap::-webkit-scrollbar-thumb { background: #3a4560; border-radius: 5px; }
.cells-wrap::-webkit-scrollbar-thumb:hover { background: var(--accent); }
.empty { color: var(--text-dim); padding: 20px; text-align: center; }
</style>
