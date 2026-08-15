<template>
  <!-- clicking anywhere on a block marks it as the "current working block",
       so AI-generated code lands in the block the user is actually working on -->
  <div class="nb-cell" :class="{ running: cell.status === 'running', err: cell.status === 'error', active: isActive }" @mousedown="$emit('active')">
    <div class="nb-head">
      <span class="nb-index" :title="t('codeBlock', cellId || (index + 1))">{{ cellId || ('[#' + (index + 1) + ']') }}</span>
      <span class="nb-tools">
        <button class="t" @click="$emit('run')" :title="t('runBlock')">▶</button>
        <button class="t" @click="$emit('insert')" :title="t('insertBelow')">＋</button>
        <button class="t" @click="$emit('up')" :disabled="index === 0" :title="t('moveUp')">↑</button>
        <button class="t" @click="$emit('down')" :disabled="isLast" :title="t('moveDown')">↓</button>
        <button class="t" @click="$emit('aiEdit')" :title="t('aiRewrite')">🤖</button>
        <button class="t del" @click="$emit('remove')" :title="t('delBlock')">✕</button>
      </span>
    </div>

    <div ref="editorEl" class="nb-editor"></div>

    <div class="nb-out" v-if="cell.status !== 'idle' && (cell.output || cell.plot || cell.error)" :style="{ fontSize: (Number(fontSize)||13) + 'px' }">
      <div class="plot-wrap" v-if="cell.plot">
        <img :src="'data:image/png;base64,' + cell.plot" alt="R plot" />
      </div>
      <pre v-if="cell.output" class="out mono">{{ cell.output }}</pre>
      <pre v-if="cell.error" class="err mono">{{ cell.error }}</pre>
      <div v-if="cell.status === 'running'" class="spin">{{ t('cellRunning') }}</div>
      <div v-if="cell.status === 'done' && !cell.output && !cell.plot" class="mute">{{ t('cellDone') }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as tgh } from '@lezer/highlight'
import { r } from '@codemirror/legacy-modes/mode/r'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { state, onRunCurrent } from '../store'
import { useI18n } from '../composables/useI18n'

const { t } = useI18n()

const props = defineProps({
  cell: { type: Object, required: true },
  index: { type: Number, default: 0 },
  isLast: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },
  cellId: { type: String, default: '' },
  fontSize: { type: [Number, String], default: 13 },
})
const emit = defineEmits(['run', 'runSel', 'insert', 'up', 'down', 'remove', 'aiEdit', 'active'])

const editorEl = ref(null)
let view = null
let editorial = false // true while the editor itself is writing back cell.code
const lang = new Compartment()

// Run the selected text; if nothing is selected, auto-expand to the WHOLE logical
// expression around the cursor (handles multi-line function calls, + / , / %>% continuations).
function parenBalance(text) {
  let b = 0, inStr = false, strCh = '', inComment = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (inComment) { if (c === '\n') inComment = false; continue }
    if (inStr) {
      if ((c === '\\' && n) ) { i++; continue }
      if (c === strCh) inStr = false
      continue
    }
    if (c === '#') { inComment = true; continue }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue }
    if (c === '(' || c === '[' || c === '{') b++
    else if (c === ')' || c === ']' || c === '}') b--
  }
  return b
}
function lineEndsContinuation(text) { // line continues below (trailing operator)
  const t = String(text).replace(/#.*$/, '').trimEnd()
  return /[+,\-*\/|&]$/.test(t) || /%[a-zA-Z]+%$/.test(t) || /(^|[^\w])<$/.test(t)
}
function lineStartsContinuation(text) { // line continues from above (leading operator/pipe)
  const t = String(text).trimStart()
  return /^[,+*\/&]/.test(t) || /^%[a-zA-Z]+%/.test(t) || /^\|>/.test(t)
}
function expressionRange(view, from, to) {
  const doc = view.state.doc
  let first = doc.lineAt(from).number
  let last = doc.lineAt(to).number
  let bal = 0
  for (let l = first; l <= last; l++) bal += parenBalance(doc.line(l).text)
  // expand upward while the expression is still open (unbalanced open) or previous line continues
  while (first > 1 && (bal > 0 || lineEndsContinuation(doc.line(first - 1).text))) {
    first--
    bal += parenBalance(doc.line(first).text)
  }
  // recompute balance over the new window, then expand downward
  bal = 0
  for (let l = first; l <= last; l++) bal += parenBalance(doc.line(l).text)
  while (last < doc.lines && (bal !== 0 || lineEndsContinuation(doc.line(last).text) || lineStartsContinuation(doc.line(last + 1).text))) {
    last++
    bal += parenBalance(doc.line(last).text)
  }
  return { from: doc.line(first).from, to: doc.line(last).to }
}
function runCodeFor(view) {
  if (!view) return { code: props.cell.code || '', endPos: 0 }
  const sel = view.state.selection.main
  if (!sel.empty) return { code: view.state.sliceDoc(sel.from, sel.to), endPos: sel.to }
  // nothing selected: expand cursor to the whole logical expression (may span lines)
  let from = sel.head, to = sel.head
  if (sel.from < sel.head) { from = sel.from } // selection start if any
  if (sel.to > sel.head) { to = sel.to }
  const r = expressionRange(view, from, to)
  return { code: view.state.sliceDoc(r.from, r.to).trim(), endPos: r.to }
}
function emitRunSel() {
  const info = view ? runCodeFor(view) : { code: props.cell.code || '', endPos: 0 }
  const code = (info.code || '').trim()
  // never silently do nothing: if the expanded expression is empty, run the whole block
  emit('runSel', code || props.cell.code || '')
  // move the cursor just past the run expression so the next run picks the next one
  if (view && info && info.endPos > 0) {
    view.dispatch({ selection: { anchor: info.endPos }, scrollIntoView: true })
  }
}
const themeC = new Compartment()

function buildTheme(fs) {
  const px = Number(fs) || 15
  return EditorView.theme({
    '&': { height: 'auto', fontSize: px + 'px', backgroundColor: 'var(--editor-bg)' },
    '.cm-scroller': { overflow: 'visible', maxHeight: 'none' },
    '.cm-content': { fontFamily: 'inherit', padding: '4px 0', minHeight: '18px', color: 'var(--editor-fg)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--editor-dim)', border: 'none' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(80,140,255,.08)' },
    '.cm-tooltip': { border: '1px solid var(--border) !important', background: 'var(--bg-panel) !important', color: 'var(--text) !important' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--accent)', color: '#fff' },
    '.cm-tooltip-autocomplete li .cm-completionLabel': { color: 'var(--text)' },
    '.cm-tooltip-autocomplete li[aria-selected] .cm-completionLabel': { color: '#fff' },
  })
}

// syntax colors that follow the app theme (light/dark via CSS vars)
const R_HIGHLIGHT = HighlightStyle.define([
  { tag: tgh.keyword, color: 'var(--accent-2)', fontWeight: '600' },
  { tag: tgh.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: tgh.string, color: '#2f9e63' },
  { tag: tgh.attributeName, color: 'var(--accent)' },
  { tag: tgh.function(tgh.variableName), color: 'var(--accent)' },
  { tag: tgh.number, color: '#d97f1e' },
  { tag: tgh.bool, color: '#c2579e' },
  { tag: tgh.null, color: '#c2579e' },
  { tag: tgh.operator, color: 'var(--text)' },
  { tag: tgh.punctuation, color: 'var(--text-dim)' },
])

// ---- R autocomplete: common keywords/functions + live session variables ----
const R_FUNCS = [
  // base
  'c', 'length', 'seq', 'rep', 'paste', 'paste0', 'sprintf', 'cat', 'print', 'str', 'typeof', 'class',
  'names', 'dim', 'nrow', 'ncol', 'rownames', 'colnames', 'dimnames', 'levels', 'is.na', 'na.omit', 'complete.cases',
  'as.numeric', 'as.character', 'as.factor', 'as.data.frame', 'as.matrix', 'as.Date', 'factor', 'ordered',
  'which', 'which.max', 'which.min', 'match', 'subset', 'merge', 'rbind', 'cbind', 'split', 'unlist', 'lapply', 'sapply', 'apply', 'tapply', 'mapply', 'vapply',
  'set.seed', 'sample', 'runif', 'rnorm', 'dnorm', 'pnorm', 'qnorm', 'table', 'unique', 'duplicated', 'sort', 'order', 'rank', 'rev',
  'min', 'max', 'sum', 'prod', 'diff', 'cumsum', 'cumprod', 'range', 'summary', 'quantile', 'nchar', 'tolower', 'toupper', 'gsub', 'sub', 'grep', 'grepl', 'strsplit',
  'sapply', 'ifelse', 'switch', 'paste0',
  // utils / data
  'read.csv', 'read.csv2', 'read.table', 'read.delim', 'readxl', 'readRDS', 'saveRDS', 'save.image', 'load', 'write.csv', 'write.table',
  'utils::head', 'head', 'tail', 'View', 'install.packages', 'library', 'require', 'detach', 'data',
  // stats
  'mean', 'median', 'sd', 'var', 'cov', 'cor', 'quantile', 'IQR', 'fivenum',
  't.test', 'wilcox.test', 'paired', 'var.test', 'chisq.test', 'fisher.test', 'prop.test', 'binom.test',
  'cor.test', 'ks.test', 'shapiro.test', 'bartlett.test', 'leveneTest', 'aov', 'kruskal.test', 'friedman.test', 'anova', 'manova',
  'lm', 'glm', 'summary.lm', 'coef', 'confint', 'predict', 'fitted', 'residuals', 'vcov', 'formula', 'anova',
  'step', 'drop1', 'add1', 'AIC', 'BIC', 'extractAIC', 'model.frame', 'model.matrix',
  'ts', 'acf', 'pacf', 'decompose', 'stl', 'lag',
  // graphics
  'plot', 'points', 'lines', 'abline', 'text', 'legend', 'title', 'axis', 'grid', 'par', 'layout',
  'hist', 'boxplot', 'barplot', 'pie', 'stripchart', 'dotchart', 'boxplot.stats',
  'qqnorm', 'qqline', 'qqplot', 'pairs', 'curve', 'segments',
  'dev.new', 'dev.off', 'png', 'jpeg', 'pdf', 'ggsave', 'image',
  // ggplot2
  'ggplot', 'aes', 'geom_point', 'geom_line', 'geom_bar', 'geom_histogram', 'geom_boxplot', 'geom_violin',
  'geom_density', 'geom_smooth', 'geom_errorbar', 'geom_hline', 'geom_vline', 'facet_wrap', 'facet_grid',
  'scale_color_manual', 'scale_fill_manual', 'scale_x_continuous', 'scale_y_log10', 'theme', 'theme_bw',
  'labs', 'ggtitle', 'xlab', 'ylab', 'xlim', 'ylim', 'coord_flip', 'guides', 'ggsave',
  // dplyr / tidyverse
  'select', 'filter', 'mutate', 'rename', 'arrange', 'summarise', 'summarize', 'group_by', 'ungroup',
  'inner_join', 'left_join', 'right_join', 'full_join', 'semi_join', 'anti_join', 'bind_rows', 'distinct', 'slice', 'pull',
]
const R_COMPLETE = R_FUNCS.map((f) => ({ label: f, type: 'function', apply: f + '()', detail: 'R' }))
// keywords that are not functions
const R_KW = ['library', 'require', 'if', 'else', 'for', 'while', 'repeat', 'function', 'return', 'next', 'break', 'TRUE', 'FALSE', 'NA', 'NULL', 'Inf', 'NaN']
R_KW.forEach((k) => R_COMPLETE.push({ label: k, type: 'keyword' }))

function rCompletionSource(ctx) {
  const word = ctx.matchBefore(/\w*$/)
  if (word.from === word.to && !ctx.explicit) return null
  const list = R_COMPLETE.slice()
  // add live R session variables so you can complete objects you created
  ;(state.variables || []).forEach((v) => {
    if (v && v.name) list.push({ label: v.name, type: v.class ? 'variable' : 'variable', detail: v.class })
  })
  return { from: word.from, options: list }
}

onMounted(() => {
  try {
    view = new EditorView({
      parent: editorEl.value,
      state: EditorState.create({
        doc: props.cell.code,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          lang.of(StreamLanguage.define(r)),
          syntaxHighlighting(R_HIGHLIGHT, { fallback: true }),
          autocompletion({ override: [rCompletionSource] }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, {
            key: 'Ctrl-Enter', run: () => { emitRunSel(); return true },
          }]),
          EditorView.updateListener.of((u) => {
            if (u.focusChanged && u.view.hasFocus) state.uiActiveEditorId = props.cell.id
            if (u.docChanged) {
              state.uiActiveEditorId = props.cell.id
              editorial = true
              props.cell.code = u.state.doc.toString()
              editorial = false
            }
          }),
          EditorView.domEventHandlers({
            focus: () => { state.uiActiveEditorId = props.cell.id; emit('active') },
          }),
          themeC.of(buildTheme(props.fontSize)),
          EditorView.lineWrapping,
        ],
      }),
    })
  } catch (e) {
    // fallback so this cell still renders (plain textarea) instead of crashing the panel
    console.error('[NotebookCell editor init failed]', e)
    if (editorEl.value) {
      editorEl.value.innerHTML = ''
      const ta = document.createElement('textarea')
      ta.value = props.cell.code || ''
      ta.style.width = '100%'; ta.style.margin = '4px 0'; ta.style.boxSizing = 'border-box'
      ta.addEventListener('input', () => { props.cell.code = ta.value })
      editorEl.value.appendChild(ta)
    }
  }
})

watch(() => props.fontSize, (fs) => {
  if (view) view.dispatch({ effects: themeC.reconfigure(buildTheme(fs)) })
})

// Reflect EXTERNAL changes to cell.code (replace-active "替换选中块", AI rewrite/fix)
// back into the CodeMirror editor. Skip when the edit originated from the editor
// itself (editorial), and no-op when the text is unchanged so the cursor/selection
// isn't disturbed.
watch(() => props.cell.code, (code) => {
  if (!view || editorial) return
  const cur = view.state.doc.toString()
  if (cur === code) return
  view.dispatch({ changes: { from: 0, to: cur.length, insert: code } })
})

// Toolbar "▶❘ 运行当前": the block whose editor last had the cursor runs its
// logical expression (handles multi-line calls/continuations) via its own view.
let offRunCur = onRunCurrent(() => {
  if (view && props.cell.id === state.uiActiveEditorId) emitRunSel()
})

onBeforeUnmount(() => { if (view) view.destroy(); if (offRunCur) offRunCur() })
</script>

<style scoped>
.nb-cell { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev); overflow: hidden; display: flex; flex-direction: column; flex: 0 0 auto; }
.nb-cell.running { border-color: var(--accent); }
.nb-cell.err { border-color: var(--err); }
.nb-cell.active { border-color: var(--accent); border-width: 2px; box-shadow: 0 0 0 2px rgba(90,140,255,.25); background: rgba(90,140,255,.07); }
.nb-cell.active .nb-head { background: rgba(90,140,255,.16); }
.nb-head { display: flex; align-items: center; padding: 3px 8px; background: rgba(0,0,0,.15); flex: 0 0 auto; }
.nb-index { color: var(--text-dim); font-family: var(--mono); font-size: 11px; }
.nb-tools { margin-left: auto; display: inline-flex; gap: 2px; }
.t {
  background: transparent; color: var(--text-dim); border: 1px solid transparent;
  border-radius: 4px; width: 22px; height: 20px; cursor: pointer; font-size: 12px; line-height: 1;
}
.t:hover:not(:disabled) { color: var(--text); border-color: var(--border); }
.t:disabled { opacity: 0.3; cursor: default; }
.t.del:hover { color: var(--err); border-color: var(--err); }
.nb-editor { padding: 0 6px; flex: 0 0 auto; }
.nb-out { border-top: 1px solid var(--border); background: var(--bg-input); }
.plot-wrap { padding: 6px 10px; }
.plot-wrap img { max-width: 100%; border-radius: 4px; display: block; }
.out { margin: 0; padding: 6px 10px; white-space: pre-wrap; word-break: break-all; color: var(--text); font-size: inherit; }
.err { margin: 0; padding: 6px 10px; white-space: pre-wrap; word-break: break-all; color: var(--err); font-size: inherit; }
.spin { padding: 6px 10px; color: var(--accent); font-size: inherit; }
.mute { padding: 6px 10px; color: var(--text-dim); font-size: inherit; }
</style>
