<template>
  <section class="frame" :class="{ collapsed }">
    <div class="frame-head" @click="$emit('toggle')">
      <span class="chev">{{ collapsed ? '▶' : '▼' }}</span>
      <span class="title">{{ title }}</span>
      <span v-if="extent" class="count">{{ extent }}</span>
      <span v-if="hint" class="hint">{{ hint }}</span>
      <span class="head-extra" @click.stop><slot name="extra" /></span>
    </div>
    <div class="frame-body" v-show="!collapsed">
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  hint: { type: String, default: '' },
  extent: { type: String, default: '' },
  collapsed: { type: Boolean, default: false },
})
defineEmits(['toggle'])
</script>

<style scoped>
.frame {
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; min-height: 0;
  flex: 1;
}
.frame.collapsed { flex: 0 0 auto; }
.frame-head {
  padding: 7px 12px; font-weight: 600; font-size: 12.5px; letter-spacing: 0.3px;
  border-bottom: 1px solid var(--border); color: var(--text-dim);
  display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; flex: 0 0 auto;
}
.frame.collapsed .frame-head { border-bottom: none; }
.frame-head:hover { color: var(--text); }
.chev { font-size: 10px; opacity: 0.8; width: 12px; }
.title { color: var(--text); }
.count { background: var(--accent); color: #fff; border-radius: 10px; font-size: 11px; padding: 0 7px; }
.hint { font-weight: 400; font-size: 11.5px; opacity: 0.6; margin-left: auto; }
.head-extra { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.frame-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.frame-body > * { min-height: 0; }
</style>
