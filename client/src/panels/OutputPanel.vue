<template>
  <div class="out-panel">
    <div class="panelbar">
      <span class="counter" v-if="state.execHistory.length">{{ t('results', state.execHistory.length) }}</span>
      <button class="btn-clear" @click="clearResults" :title="t('clearResultsTip')"
        :disabled="!state.execHistory.length">{{ t('clearResults') }}</button>
    </div>
    <div class="empty" v-if="!state.execHistory.length">{{ t('noResults') }}</div>
    <div v-else class="log">
      <div v-for="(h, i) in state.execHistory" :key="h.id" class="entry">
        <div class="entry-head">
          <span class="n">#{{ state.execHistory.length - i }}</span>
          <span class="badge" :class="h.ok === null ? 'pending' : (h.ok ? 'ok' : 'err')">
            {{ h.ok === null ? t('outRunning') : (h.ok ? '✓' : '✗') }}
          </span>
          <span class="time">{{ fmt(h.ts) }}</span>
        </div>
        <pre class="code mono">{{ h.code }}</pre>
        <div class="out mono" v-if="h.output">{{ h.output }}</div>
        <div class="plot-wrap" v-if="h.plot">
          <img :src="'data:image/png;base64,' + h.plot" alt="R plot" />
        </div>
        <div class="err mono" v-if="h.error">{{ h.error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { state, clearExec } from '../store'
import { useI18n } from '../composables/useI18n'
const { t } = useI18n()
function clearResults() { clearExec() }
function fmt(ts) {
  const d = new Date(ts)
  return d.toTimeString().slice(0, 8)
}
</script>

<style scoped>
.out-panel { flex: 1; overflow: auto; padding: 8px; }
.panelbar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 2px 2px 8px; }
.counter { color: var(--text-dim); font-size: 11.5px; }
.btn-clear {
  background: var(--bg-elev); color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 12px;
}
.btn-clear:hover:not(:disabled) { color: var(--err); border-color: var(--err); }
.btn-clear:disabled { opacity: 0.4; cursor: default; }
.empty { color: var(--text-dim); padding: 20px; text-align: center; }
.log { display: flex; flex-direction: column; gap: 10px; }
.entry { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev); overflow: hidden; }
.entry-head { display: flex; gap: 8px; align-items: center; padding: 5px 9px; border-bottom: 1px solid var(--border); }
.n { color: var(--text-dim); font-family: var(--mono); }
.badge { border-radius: 4px; padding: 0 6px; font-size: 11px; font-weight: 600; }
.badge.pending { background: rgba(159, 140, 224, .2); color: var(--accent-2); }
.badge.ok { background: rgba(63,191,127,.15); color: var(--ok); }
.badge.err { background: rgba(255,93,108,.15); color: var(--err); }
.time { margin-left: auto; color: var(--text-dim); font-family: var(--mono); font-size: 11px; }
.code { margin: 0; padding: 7px 10px; color: #b7c4e0; white-space: pre-wrap; background: var(--bg-input); border-bottom: 1px dashed var(--border); }
.out { margin: 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; color: var(--text); }
.plot-wrap { padding: 8px 10px; border-top: 1px solid var(--border); background: var(--bg-input); }
.plot-wrap img { max-width: 100%; border-radius: 4px; display: block; }
.err { margin: 0; padding: 8px 10px; white-space: pre-wrap; color: var(--err); background: rgba(255,93,108,.06); }
</style>
