<template>
  <div class="scratch-wrap">
    <div v-if="renderErr" class="scratch-err">⚠ Render error here: {{ renderErr }}</div>
    <NotebookPanel v-else :nb="nb" title="Scratch" insert-target="scratch" />
  </div>
</template>

<script setup>
import { watch, onBeforeUnmount, onErrorCaptured, ref } from 'vue'
import NotebookPanel from '../components/NotebookPanel.vue'
import { onResetWorkspace } from '../store'
import { useNotebook } from '../composables/useNotebook'

// capture any runtime error from this panel's children and show it here (diagnostic)
const renderErr = ref('')
onErrorCaptured((err) => {
  renderErr.value = (err && err.message) ? err.message : String(err)
  return false // don't let Vue keep bubbling/rewriting
})

const LS_KEY = 'raScratch'

const nb = useNotebook()

// ---- persistent scratch notebook: survives browser refresh ----
function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(nb.toJSON())) } catch (e) { /* ignore quota */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return false
    const arr = JSON.parse(raw)
    // keep only meaningful (non-empty-code) cells; a blank-only snapshot means the
    // panel should fall through to the default initialCode block.
    // NOTE: useNotebook.load() expects [{code}] objects — passing raw strings here
    // would give every cell an empty `code` and render blank blocks.
    const cellRows = (Array.isArray(arr) ? arr : [])
      .map((c) => (c && typeof c.code === 'string' ? c.code : ''))
      .filter((code) => code.trim() !== '')
      .map((code) => ({ code }))
    if (!cellRows.length) {
      // corrupted/empty snapshot — drop it so it doesn't keep suppressing the default block
      try { localStorage.removeItem(LS_KEY) } catch (e) {}
      return false
    }
    nb.load(cellRows) // load() marks _seededInitially so the default initialCode won't re-apply
    return true
  } catch (e) {
    try { localStorage.removeItem(LS_KEY) } catch (e2) {}
    return false
  }
}
restore() // synchronous: runs before NotebookPanel's onMounted seeds the default

// 新建工程时：临时窗也重置为干净状态（一个空块），并清掉持久化以免旧内容回来
onResetWorkspace(() => {
  nb.clear() // clear() => one empty block, ready to type
  try { localStorage.removeItem(LS_KEY) } catch (e) {}
})

let saveTimer = null
watch(
  () => JSON.stringify(nb.toJSON()),
  () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 300) }
)
onBeforeUnmount(() => { clearTimeout(saveTimer); persist() })
// On tab close / F5 refresh, Vue's onBeforeUnmount often does NOT run, so also flush
// synchronously on page hide/unload so just-typed blocks aren't lost within the debounce.
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); persist() })
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); persist() })
</script>

<style scoped>
.scratch-wrap { flex: 1; height: 100%; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.scratch-err { margin: 12px; padding: 10px 12px; border: 1px solid var(--err); background: rgba(255,93,108,.08); color: var(--err); border-radius: 8px; font-size: 13px; line-height: 1.6; word-break: break-word; }
</style>
