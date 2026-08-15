<template>
  <div class="var-panel">
    <div class="panelbar" v-if="state.variables.length">
      <span class="counter">{{ t('items', state.variables.length) }}</span>
    </div>
    <div class="empty" v-if="!state.variables.length">
      {{ t('noVars') }}<br />{{ t('runToShow') }}
    </div>
    <div v-else class="list">
      <div
        v-for="v in state.variables"
        :key="v.name"
        class="row"
        :class="{ open: open === v.name }"
        @click="toggle(v.name)"
        :title="t('type_', v.type)"
      >
        <div class="main">
          <span class="name">{{ v.name }}</span>
          <span class="cls">{{ v.class }}</span>
          <span class="dim" v-if="v.dim">{{ v.dim }}</span>
          <span class="size">{{ v.size }}</span>
          <button class="expand" @click.stop="toggle(v.name)">{{ open === v.name ? '▾' : '▸' }}</button>
          <button class="del" @click.stop="doDelete(v.name)" :title="t('delVarTip')">✕</button>
        </div>
        <div v-if="open === v.name" class="detail">
          <div class="meta mono">
            <span>class: {{ v.class }}</span>
            <span v-if="v.dim"> · dim: {{ v.dim }}</span>
            <span> · size: {{ v.size }}</span>
          </div>
          <pre class="head mono">{{ v.head || t('noPrev') }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { state, removeVar, clearVars } from '../store'
import { useI18n } from '../composables/useI18n'
const { t } = useI18n()
const open = ref(null)
function toggle(name) { open.value = open.value === name ? null : name }
function doDelete(name) {
  if (window.confirm(t('delVarQ', name))) {
    if (open.value === name) open.value = null
    removeVar(name)
  }
}
function doClearAll() {
  if (window.confirm(t('clearVarsQ'))) {
    open.value = null
    clearVars()
  }
}
</script>

<style scoped>
.var-panel { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 6px; scrollbar-gutter: stable; }
.var-panel::-webkit-scrollbar { width: 10px; }
.var-panel::-webkit-scrollbar-track { background: transparent; }
.var-panel::-webkit-scrollbar-thumb { background: #3a4560; border-radius: 5px; }
.var-panel::-webkit-scrollbar-thumb:hover { background: var(--accent); }
.panelbar { display: flex; justify-content: space-between; align-items: center; padding: 2px 4px 8px; }
.counter { color: var(--text-dim); font-size: 11.5px; }
.btn-clear {
  background: var(--bg-elev); color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px;
}
.btn-clear:hover { color: var(--err); border-color: var(--err); }
.empty { color: var(--text-dim); padding: 20px; text-align: center; line-height: 1.8; }
.list { display: flex; flex-direction: column; gap: 4px; }
.row { border: 1px solid var(--border); border-radius: 7px; background: var(--bg-elev); }
.row.open { border-color: var(--accent); }
.main { display: flex; align-items: center; gap: 8px; padding: 6px 9px; cursor: pointer; }
.name { font-weight: 600; font-family: var(--mono); color: var(--accent); }
.cls { color: #9be0a8; background: rgba(63,191,127,.12); border-radius: 4px; padding: 0 5px; font-size: 11px; }
.dim { color: var(--text-dim); font-family: var(--mono); font-size: 11.5px; }
.size { color: var(--text-dim); font-size: 11px; margin-left: auto; }
.expand { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 12px; }
.del {
  background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 13px;
  line-height: 1; padding: 0 2px; border-radius: 4px;
}
.del:hover { color: var(--err); background: rgba(255,93,108,.12); }
.detail { border-top: 1px solid var(--border); background: var(--bg-input); }
.meta {
  padding: 5px 10px; color: var(--text-dim); border-bottom: 1px dashed var(--border);
  font-size: 11px; display: flex; gap: 12px; flex-wrap: wrap;
}
.head {
  margin: 0; padding: 7px 10px; color: var(--text); white-space: pre-wrap; word-break: break-all; font-size: 12.5px;
}
</style>
