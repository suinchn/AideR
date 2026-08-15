<template>
  <div class="code-windows">
    <div class="winbar">
      <div
        v-for="w in windows"
        :key="w.id"
        class="chip"
        :class="{ active: w.id === activeId }"
        @click="activeId = w.id"
        @dblclick="renameWindow(w)"
        :title="t('renameTip')"
      >
        <span class="chip-title">{{ w.title }}</span>
        <button class="chip-close" @click.stop="closeWindow(w.id)" :title="t('closeWin')">✕</button>
      </div>
      <button class="chip-add" @click="addWindow" :title="t('addWindowTip')">{{ t('addWindow') }}</button>
    </div>
    <NotebookPanel
      v-if="activeWindow"
      :key="activeId"
      :nb="activeWindow.nb"
      :title="activeWindow.title"
      :win-code="activeWindow.num != null ? String(activeWindow.num) : ''"
      :initial-cells="[]"
      :insert-target="insertBusForActive"
    />
    <div class="empty" v-else>{{ t('noWin') }}</div>
  </div>
</template>

<script setup>
import { ref, computed, markRaw, onBeforeUnmount, watch } from 'vue'
import NotebookPanel from '../components/NotebookPanel.vue'
import { useNotebook } from '../composables/useNotebook'
import { useI18n } from '../composables/useI18n'
import { onResetWorkspace } from '../store'

const { t } = useI18n()

const LS_KEY = 'racodeproj'

// ---- multiple standalone "代码窗口" (代码1, 代码2, 代码3…) ----
let seq = 1
const windows = ref([])
const activeId = ref(null)
const activeWindow = computed(() => windows.value.find((w) => w.id === activeId.value) || null)
// The only mounted NotebookPanel always targets the "main" insert bus, so "到主代码窗"
// lands in whatever tab is currently visible — never broadcast into every tab.
const insertBusForActive = computed(() => (activeWindow.value ? 'main' : '__none__'))

function newWindow(cells, title) {
  const id = 'w' + (++seq)
  const nb = markRaw(useNotebook())
  if (cells && cells.length) nb.load(cells)
  windows.value.push({ id, num: seq, title: title || `Code ${seq}`, nb })
  return id
}
function addWindow() { newWindow(); activeId.value = windows.value[windows.value.length - 1].id }
function closeWindow(id) {
  const i = windows.value.findIndex((w) => w.id === id)
  if (i === -1) return
  windows.value.splice(i, 1)
  if (activeId.value === id) {
    const nxt = windows.value[Math.min(i, windows.value.length - 1)]
    activeId.value = nxt ? nxt.id : null
  }
}
function renameWindow(w) { const name = window.prompt(t('winName'), w.title); if (name) w.title = name }

// ---- persistence: save all windows + active, restore on load ----
function persist() {
  try {
    const data = { active: activeId.value, windows: windows.value.map((w) => ({ id: w.id, title: w.title, cells: w.nb.toJSON() })) }
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch (e) { /* ignore quota errors */ }
}
let saveTimer = null
function schedulePersist() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 500) }

function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return false
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.windows) || !data.windows.length) return false
    windows.value = []
    for (const w of data.windows) newWindow(w.cells, w.title)
    activeId.value = windows.value[0].id
    return true
  } catch (e) { return false }
}

const restored = restore()
if (!restored) addWindow() // 代码1 default

// watch windows' cells + titles + active -> persist (debounced)
watch(() => windows.value.map((w) => ({ t: w.title, j: JSON.stringify(w.nb.toJSON()) })), schedulePersist, { deep: true })
watch(activeId, schedulePersist)

// On new-project (workspace reset): reset to ONE clean code window named "Code 1",
// and reset the window counter so newly added windows start from "Code 2" (not 4/5…).
onResetWorkspace(() => {
  const keep = windows.value[0]
  if (keep) {
    seq = 1 // so the next addWindow() yields "Code 2"
    keep.id = 'w1' // reset identity so future window ids never collide (avoids double-highlight)
    keep.num = 1 // reset ordinal so block ids restart at code1-x
    keep.title = 'Code 1'
    keep.nb.clear()
    windows.value.splice(1)
    activeId.value = keep.id
  } else {
    seq = 0 // so addWindow() yields "Code 1"
    addWindow()
  }
  schedulePersist()
})

onBeforeUnmount(() => { clearTimeout(saveTimer); persist() })
</script>

<style scoped>
.code-windows { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.winbar { display: flex; gap: 5px; padding: 6px 8px 2px; align-items: center; flex-wrap: wrap; flex: 0 0 auto; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; cursor: pointer; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
.chip.active { border-color: var(--accent); color: var(--accent); background: rgba(90,140,255,.15); border-width: 2px; font-weight: 700; }
.chip-title { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip-close { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 0 2px; font-size: 11px; }
.chip-close:hover { color: var(--err); }
.chip-add { background: var(--bg-elev); border: 1px dashed var(--border); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 12px; white-space: nowrap; }
.chip-add:hover { border-color: var(--accent); }
.empty { color: var(--text-dim); padding: 20px; text-align: center; }
</style>
