<template>
  <div class="app">
    <header class="topbar">
      <div class="brand-wrap">
        <div class="brand">{{ t('brand') }}</div>
        <div class="slogan">{{ t('slogan') }}</div>
      </div>
      <button class="btn-project" @click="openProjectDialog" :title="t('newProjectTip')">{{ t('newProject') }}</button>
      <button class="btn-ghost btn-pj" @click="emitOpenProject()" :title="t('openProjectTip')">{{ t('openProject') }}</button>
      <button class="btn-ghost btn-pj" @click="emitSaveProject()" :title="t('saveProjectTip')">{{ t('saveProject') }}</button>
      <span v-if="state.activeProject.name" class="project-chip" :title="state.activeProject.dir || ''">📂 {{ state.activeProject.name }}</span>
      <div class="status">
        <span class="dot" :class="state.connected ? 'on' : 'off'" />
        {{ state.connected ? t('connected') : t('disconnected') }}
        <span v-if="serverState" class="sep">·</span>
        <span v-if="serverState" class="rstat" :class="{ err: serverState.rError }">
          {{ serverState.ready ? t('rReady') : (serverState.rError ? t('rNotReady') : t('connectingR')) }}
        </span>
        <span v-if="serverState && !serverState.ai.ok" class="sep">·</span>
        <span v-if="serverState && !serverState.ai.ok" class="rstat warn">{{ t('aiNotConf') }}</span>
      </div>
      <button class="btn-ghost" @click="toggleTheme">{{ theme === 'light' ? '🌙' : '☀️' }}</button>
      <button class="btn-ghost" @click="toggleLang">{{ ui.lang === 'zh' ? 'EN' : '中' }}</button>
      <button class="btn-ghost" @click="showSettings = true">{{ t('settings') }}</button>
    </header>

    <main class="body">
      <!-- LEFT column: Code & Code 2 (resizable rows) -->
      <div class="col" :style="leftColStyle">
        <PanelFrame id="code" :title="t('titleCode')" :hint="t('codeHint')" :collapsed="isCollapsed('code')" @toggle="toggle('code')">
          <template #extra>
            <span class="headfont" :title="t('fontTip')">
              <button class="hf" @click="bumpCodeFont(-1)">A−</button>
              <button class="hf" @click="bumpCodeFont(1)">A+</button>
              <span class="hfval">{{ codeFont }}</span>
            </span>
          </template>
          <CodePanel />
        </PanelFrame>
        <div class="vs" @mousedown="hsplit.onDown">
          <div class="vs-knob" />
        </div>
        <PanelFrame id="scratch" :title="t('titleScratch')" :collapsed="isCollapsed('scratch')" @toggle="toggle('scratch')">
          <ScratchPanel />
        </PanelFrame>
      </div>

      <!-- vertical splitter -->
      <div class="vsplit" @mousedown="vsplit.onDown">
        <div class="vsplit-knob" />
      </div>

      <!-- RIGHT column: Variables & AI Assistant (resizable rows) -->
      <div class="col" :style="rightColStyle">
        <PanelFrame id="vars" :title="t('titleVars')" :extent="state.variables.length ? String(state.variables.length) : ''" :collapsed="isCollapsed('vars')" @toggle="toggle('vars')">
          <template #extra>
            <button class="btn-ghost btn-vclr" @click="clearVarsNow" :title="t('clearAllVarsTip')" :disabled="!state.variables.length">{{ t('clearAllVars') }}</button>
          </template>
          <VariablesPanel />
        </PanelFrame>
        <div class="vs" @mousedown="hsplit2.onDown">
          <div class="vs-knob" />
        </div>
        <PanelFrame id="chat" :title="t('titleChat')" :collapsed="isCollapsed('chat')" @toggle="toggle('chat')">
          <ChatPanel />
        </PanelFrame>
      </div>
    </main>

    <footer class="statusbar">
      <span v-if="state.activeProject.name" class="pj">📂 <code>{{ state.activeProject.dir || state.activeProject.name }}</code></span>
      <span v-if="serverState" class="sp">|</span>
      <span v-if="serverState">Rscript: <code>{{ serverState.rscript }}</code></span>
      <span v-else>{{ t('connecting') }}</span>
      <span v-if="serverState" class="sp">|</span>
      <span v-if="serverState">AI: <code>{{ providerLabel(serverState.settings?.ai?.provider) }} · {{ serverState.settings?.ai?.model }}</code></span>
    </footer>

    <SettingsDialog v-if="showSettings" @close="showSettings = false" />

    <div v-if="showProjectDialog" class="overlay" @click.self="showProjectDialog = false">
      <div class="project-dialog">
        <div class="p-head">{{ t('projectTitle') }}</div>
        <div class="p-body">
          <p class="p-hint">{{ t('projectHint') }}</p>
          <button class="btn p-pick" @click="pickFolder" :disabled="pickingFolder">
            {{ pickingFolder ? t('opening') : t('chooseFolder') }}
          </button>
          <div v-if="projectDir" class="p-picked">{{ t('currentFolder') }} <b>{{ projectDir }}</b></div>
          <div class="p-path-row">
            <label class="p-path-label">{{ t('pathOptional') }}</label>
            <input v-model="projectPath" class="p-input" :placeholder="t('pathPh')" @keydown.enter="confirmProject" />
          </div>
          <div v-if="projectDirMsg" class="p-msg" :class="projectDirMsgOk ? 'ok' : 'bad'">{{ projectDirMsg }}</div>
        </div>
        <div class="p-foot">
          <button class="btn p-cancel" @click="showProjectDialog = false">{{ t('cancel') }}</button>
          <button class="btn p-create" @click="confirmProject" :disabled="!state.activeProject.src">{{ t('done') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { state, clearVars, emitResetWorkspace, emitSaveProject, emitOpenProject, loadAiMemory, loadProjectSkills, ensureProjectSkillsDir } from './store'
import { pickDirectory } from './composables/useFileDialog'
import { saveDir, ensureRW } from './composables/usePersistentDir'
import { useResize } from './composables/usePanelLayout'
import { useNotebook } from './composables/useNotebook'
import { useCodeFont } from './composables/useCodeFont'
import { useI18n } from './composables/useI18n'
import PanelFrame from './components/PanelFrame.vue'
import CodePanel from './panels/CodePanel.vue'
import ScratchPanel from './panels/ScratchPanel.vue'
import VariablesPanel from './panels/VariablesPanel.vue'
import ChatPanel from './panels/ChatPanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'

const showSettings = ref(false)
const serverState = computed(() => state.serverState)

// ---- 新建工程 dialog: choose a folder (browser picker), remember it in IndexedDB ----
const { ui, t, setLang } = useI18n()
function toggleLang() { setLang(ui.lang === 'zh' ? 'en' : 'zh') }
function clearVarsNow() {
  if (window.confirm(t('clearVarsQ'))) clearVars()
}
const showProjectDialog = ref(false)
const projectDir = ref('')        // 已选文件夹名（回显）
const projectPath = ref('')       // 可选：用户填的完整绝对路径
const pickingFolder = ref(false)
const projectDirMsg = ref('')
const projectDirMsgOk = ref(false)
function openProjectDialog() {
  showProjectDialog.value = true
  projectDir.value = state.activeProject.name || ''
  projectPath.value = state.activeProject.dir || ''
  projectDirMsg.value = ''
  projectDirMsgOk.value = false
}
async function pickFolder() {
  if (pickingFolder.value) return
  pickingFolder.value = true
  projectDirMsg.value = t('opening')
  projectDirMsgOk.value = false
  const res = await pickDirectory()
  pickingFolder.value = false
  if (res && res.ok && res.handle) {
    // request read/write permission (may prompt once), then persist the handle
    const granted = await ensureRW(res.handle)
    if (!granted) {
      projectDirMsg.value = t('noWritePerm')
      projectDirMsgOk.value = false
      return
    }
    const saved = await saveDir(res.handle)
    if (!saved.ok) {
      projectDirMsg.value = t('rememberFail') + (saved.error || '')
      projectDirMsgOk.value = false
      return
    }
    state.activeProject.src = res.handle
    state.activeProject.name = res.name
    // load an optional previously-saved absolute path for this project (browser can't detect it)
    try { state.activeProject.dir = localStorage.getItem('raPath_' + res.name) || '' } catch (e) {}
    projectDir.value = res.name
    projectDirMsg.value = t('folderSaved', res.name)
    projectDirMsgOk.value = true
    // 新建工程：清空代码窗与 AI 对话，回归干净界面（全新开始）
    emitResetWorkspace()
    // 载入这个工程文件夹里的记忆笔记 memory.md（若有）+ 工程 skills/
    await loadAiMemory()
    await ensureProjectSkillsDir() // 在工程文件夹里创建 skills/ 目录（如无）
    await loadProjectSkills()
    // 新建工程时同时保存项目（写 project.json + RData 骨架）
    setTimeout(() => emitSaveProject(), 400)
  } else if (res && res.reason === 'no-api') {
    projectDirMsg.value = t('pickerUnsupported')
    projectDirMsgOk.value = false
  } else {
    projectDirMsg.value = t('noFolderChosen')
    projectDirMsgOk.value = false
  }
}
function confirmProject() {
  const p = projectPath.value.trim()
  state.activeProject.dir = p || ''
  try {
    if (p) localStorage.setItem('raPath_' + (state.activeProject.name || 'default'), p)
    else localStorage.removeItem('raPath_' + (state.activeProject.name || 'default'))
  } catch (e) {}
  showProjectDialog.value = false
}

// code font size control (shown in the Code panel title bar)
const { codeFont, bumpCodeFont } = useCodeFont()

// light/dark theme (default light per user request)
const theme = ref(localStorage.getItem('ratheme') || 'light')
function applyTheme() { document.documentElement.dataset.theme = theme.value }
function toggleTheme() { theme.value = theme.value === 'light' ? 'dark' : 'light'; localStorage.setItem('ratheme', theme.value); applyTheme() }
applyTheme()

// resizable columns & rows
const vsplit = useResize('col', 0.6)
const hsplit = useResize('row', 0.6, 0.3, 0.8)
const hsplit2 = useResize('row', 0.42, 0.25, 0.75)
const leftw = computed(() => `${(vsplit.ratio.value * 100).toFixed(1)}%`)
function rowsFor(ratio, topColl, botColl) {
  if (topColl) return 'auto 9px 1fr'
  if (botColl) return '1fr 9px auto'
  const a = (ratio * 100).toFixed(1)
  const b = ((1 - ratio) * 100).toFixed(1)
  return `${a}% 9px ${b}%`
}
const leftColStyle = computed(() => ({
  width: leftw.value, flex: 'none',
  display: 'grid',
  gridTemplateRows: rowsFor(hsplit.ratio.value, isCollapsed('code'), isCollapsed('scratch')),
}))
const rightColStyle = computed(() => ({
  flex: '1', minWidth: '0', display: 'grid',
  gridTemplateRows: rowsFor(hsplit2.ratio.value, isCollapsed('vars'), isCollapsed('chat')),
}))

// collapsible panels (Variables & Code 2 folded by default)
const collapsed = ref({ vars: true, scratch: true })
function isCollapsed(id) { return !!collapsed.value[id] }
function toggle(id) { collapsed.value[id] = !collapsed.value[id] }
// 状态栏对 provider 的显示名：本地引擎一律显示 "local"
function providerLabel(p) {
  if (p === 'ollama') return 'local'
  return p || '?'
}
</script>

<style scoped>
.app { height: 100%; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 16px; padding: 8px 14px; background: var(--bg-elev); border-bottom: 1px solid var(--border); }
.brand { font-weight: 600; font-size: 14px; letter-spacing: 0.5px; }
.brand-wrap { display: flex; align-items: baseline; gap: 8px; }
.brand-wrap .brand { font-size: 14px; }
.brand-wrap .slogan { font-size: 11px; color: var(--accent); font-weight: 500; white-space: nowrap; }
.btn-project {
  background: var(--accent); color: #fff; border: none; border-radius: 6px;
  padding: 5px 12px; cursor: pointer; font-size: 12.5px; font-weight: 600; white-space: nowrap;
}
.btn-project:hover { filter: brightness(1.1); }
.project-chip {
  background: var(--bg-elev); color: var(--accent); border: 1px solid var(--accent);
  border-radius: 6px; padding: 3px 10px; font-size: 12px; font-weight: 600; white-space: nowrap;
}
.overlay { position: fixed; inset: 0; background: rgba(5,8,15,.65); display: flex; align-items: center; justify-content: center; z-index: 60; }
.project-dialog { width: 400px; max-width: 92vw; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.p-head { padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; }
.p-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.p-hint { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--text-dim); }
.p-pick { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer; font-size: 12.5px; font-weight: 600; align-self: flex-start; }
.p-pick:hover { filter: brightness(1.1); }
.p-pick:disabled { opacity: 0.5; cursor: default; }
.p-name-row { display: flex; flex-direction: column; gap: 4px; }
.p-name-label { font-size: 11.5px; color: var(--text-dim); }
.p-picked { font-size: 12.5px; color: var(--text); background: var(--bg-elev); border: 1px dashed var(--accent); border-radius: 6px; padding: 6px 10px; word-break: break-all; }
.p-input { background: var(--bg-input); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.p-input:focus { outline: none; border-color: var(--accent); }
.p-msg { font-size: 12.5px; }
.p-msg.ok { color: var(--ok); } .p-msg.bad { color: var(--err); }
.p-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.p-foot .btn { border-radius: 6px; padding: 7px 16px; cursor: pointer; font-size: 12.5px; }
.p-foot .btn:disabled { opacity: 0.5; cursor: default; }
.p-cancel { background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); }
.p-create { background: var(--accent); color: #fff; border: none; font-weight: 600; }
.status { display: flex; align-items: center; gap: 6px; flex: 1; color: var(--text-dim); }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.dot.on { background: var(--ok); } .dot.off { background: var(--text-dim); }
.sep { opacity: 0.4; }
.rstat.err { color: var(--err); } .rstat.warn { color: var(--warn); }
.btn-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12.5px; }
.btn-ghost:hover { color: var(--text); border-color: var(--accent); }
.btn-vclr { padding: 2px 8px; font-size: 11.5px; }
.btn-vclr:hover:not(:disabled) { color: var(--err); border-color: var(--err); }
.btn-vclr:disabled { opacity: 0.4; cursor: default; }
.vclr-lbl { margin-left: 3px; }

.body { flex: 1; display: flex; min-height: 0; padding: 8px; gap: 6px; }
.col { display: flex; flex-direction: column; gap: 6px; min-height: 0; min-width: 0; }

.tab.active { border-color: var(--accent); color: var(--accent); }
.tab-title { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 0 2px; font-size: 11px; }
.tab-close:hover { color: var(--err); }
.tab-add { background: var(--bg-elev); border: 1px dashed var(--border); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.tab-add:hover { border-color: var(--accent); }
.headfont { display: inline-flex; align-items: center; gap: 5px; }
.hf { background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 1px 7px; cursor: pointer; font-size: 11px; font-weight: 600; }
.hf:hover { border-color: var(--accent); }
.hfval { color: var(--text-dim); font-size: 11px; min-width: 16px; text-align: center; }

/* horizontal row splitter (drag up/down to resize stacked panels) */
.vs { cursor: row-resize; flex: 0 0 11px; display: flex; align-items: center; justify-content: center; touch-action: none; position: relative; }
.vs-knob { width: 44px; height: 5px; border-radius: 3px; background: var(--border); }
.vs:hover .vs-knob, .vs:active .vs-knob { background: var(--accent); height: 7px; }

/* vertical column splitter (drag left/right to resize Code vs Variables/AI) */
.vsplit { cursor: col-resize; flex: 0 0 11px; display: flex; align-items: center; justify-content: center; touch-action: none; position: relative; }
.vsplit-knob { width: 5px; height: 52px; border-radius: 3px; background: var(--border); }
.vsplit:hover .vsplit-knob, .vsplit:active .vsplit-knob { background: var(--accent); width: 7px; }

.statusbar { display: flex; gap: 14px; padding: 6px 14px; font-size: 12px; color: var(--text-dim); border-top: 1px solid var(--border); background: var(--bg-elev); }
.pj { color: var(--text); }
.pj code { color: var(--accent); }
.sp { opacity: 0.4; }
</style>
