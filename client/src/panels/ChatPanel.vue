<template>
  <div class="chat-panel">
    <div class="chat-topbar">
      <label class="approve-toggle" :title="state.approvalMode ? uiT('reqApproveOn') : uiT('autoRun')">
        <input type="checkbox" :checked="state.approvalMode" @change="onTog" />
        <span>{{ uiT('requireAppr') }}</span>
      </label>
      <span class="font-ctrl" :title="uiT('chatFontTip')">
        <button class="ft" @click="bumpFont(-1)">A−</button>
        <button class="ft" @click="bumpFont(1)">A+</button>
        <span class="ftsize">{{ chatFont }}</span>
        <button class="ft" :title="uiT('aiLangTip')" @click="toggleAiLang">{{ state.aiLang === 'zh' ? 'AI→EN' : 'AI→中文' }}</button>
        <label class="ft tool-chk" :title="'Ask the AI to lay out steps first'">
          <input type="checkbox" :checked="state.aiPlan" @change="setAiPlan($event.target.checked)" /> Plan
        </label>
        <select class="ft tool-sel" :value="state.aiSkill ? state.aiSkill.name : ''" @change="onSkillChange($event.target.value)" :title="'Reusable analysis recipe (skill)'">
          <option value="">Skill</option>
          <option v-for="s in state.skills" :key="s.name" :value="s.name">{{ s.label }}</option>
        </select>
        <button class="ft clear" :title="uiT('chatClrTip')" @click="clearChat">{{ uiT('chatClr') }}</button>
      </span>
    </div>
    <div v-if="state.lastPlan && state.lastPlan.steps.length" class="plan-banner">
      <div class="plan-head">📋 Plan</div>
      <ol class="plan-list">
        <li v-for="(st, i) in state.lastPlan.steps" :key="i" class="plan-step">{{ st }}</li>
      </ol>
    </div>
    <div class="msg-list" ref="listEl" :style="{ fontSize: chatFont + 'px' }">
      <div class="empty" v-if="!state.aiEvents.length">
        {{ t('chatEmpty') }}<br />
        <em>{{ t('chatExample') }}</em><br />
        {{ t('chatEmptyMsg') }}
      </div>

      <div v-for="m in state.aiEvents" :key="m.id" class="conv">
        <div class="bubble user">{{ m.userText }}</div>
        <div class="ai-wrap" :class="{ streaming: m.status === 'running' }">
          <div v-if="m.error" class="bubble ai err">{{ m.error }}</div>
          <template v-else>
            <!-- structured segments -->
            <template v-if="m.segments.length">
              <div v-for="(seg, i) in m.segments" :key="i" class="seg">
                <div v-if="seg.kind === 'text'" class="text mono" v-html="md(seg.content)"></div>
                <div v-else-if="seg.kind === 'inspect'" class="r-code inspect">
                  <div class="r-code-head">{{ t('inspectVar') }}</div>
                  <pre class="r-code-body mono">{{ seg.content }}</pre>
                  <div class="r-result" v-if="seg.result">
                    <div v-if="seg.result.error" class="r-err mono">{{ seg.result.error }}</div>
                    <pre v-else class="r-inspect-body mono">{{ seg.result.output }}</pre>
                  </div>
                </div>
                <div v-else class="r-code">
                  <div class="r-code-head">{{ t('rcode') }}</div>
                  <pre class="r-code-body mono">{{ seg.content }}</pre>
                  <div class="r-result" v-if="seg.result">
                    <div class="plot-wrap" v-if="seg.result.plot">
                      <img :src="'data:image/png;base64,' + seg.result.plot" alt="R plot" />
                    </div>
                    <div v-if="seg.result.output" class="r-out mono">{{ seg.result.output }}</div>
                    <div v-if="seg.result.error" class="r-err mono">{{ seg.result.error }}</div>
                    <div v-if="seg.result.skipped" class="r-out mute">{{ t('skippedRun') }}</div>
                    <div v-if="seg.result.ok !== false && !seg.result.output && !seg.result.plot && !seg.result.skipped" class="r-out mute">{{ t('ranOkNoOut') }}</div>
                  </div>
                  <div v-else-if="seg.pendingToken" class="approve-bar">
                    <span class="approve-tip">{{ t('needsAppr') }}</span>
                    <button class="btn-approve ok" @click="approveSeg(seg)">{{ t('approveRun') }}</button>
                    <button class="btn-approve no" @click="skipSeg(seg)">{{ t('skip') }}</button>
                  </div>
                </div>
              </div>
              <div v-if="m.status === 'running'" class="thinking">{{ t('thinking') }}</div>
              <div v-else-if="hasCode(m)" class="apply-row">
                <button class="btn apply runbtn" @click="runThisCode(m)" :disabled="!!m._running" :title="t('runCodeTip')">{{ m._running ? t('running') : t('runCode') }}</button>
                <button class="btn apply" @click="applyWidget(m, 'main', 'append')" :title="t('toMainTip')">{{ t('toMain') }}</button>
                <button class="btn apply" @click="applyWidget(m, 'scratch', 'append')" :title="t('toScratchTip')">{{ t('toScratch') }}</button>
                <button class="btn apply repl-main" @click="applyWidget(m, 'main', 'replace')" :title="t('replMainTip')">{{ t('replMain') }}</button>
                <button class="btn apply repl-scratch" @click="applyWidget(m, 'scratch', 'replace')" :title="t('replScrTip')">{{ t('replScr') }}</button>
              </div>
              <div v-if="m.runResult" class="run-result" :class="{ err: m.runResult.ok === false }">
                <div class="run-head">{{ m.runResult.ok === false ? t('runFailed') : t('runResult') }}</div>
                <div class="plot-wrap" v-if="m.runResult.plot">
                  <img :src="'data:image/png;base64,' + m.runResult.plot" alt="R plot" />
                </div>
                <pre v-if="m.runResult.output" class="run-out">{{ m.runResult.output }}</pre>
                <pre v-if="m.runResult.error" class="run-err">{{ m.runResult.error }}</pre>
              </div>
            </template>
            <!-- raw streaming (before segments arrive) -->
            <div v-else class="bubble ai mono">{{ m.textStream || '…' }}</div>
          </template>
        </div>
      </div>
    </div>

    <div class="composer">
      <textarea
        v-model="input"
        rows="2"
        :placeholder="uiT('composerPh')"
        @keydown.enter.exact.prevent="send"
      ></textarea>
      <div class="composer-bar">
        <button class="btn send" @click="send" :disabled="!input.trim() || busy">{{ uiT('send') }}</button>
        <span v-if="busy" class="busy">{{ uiT('aiRunning') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, watch } from 'vue'
import { state, askAI, emitAiInsert, executeCell, approveCode, setApprovalMode, getCellsSnapshot, setAiLang, setAiPlan, setAiSkill } from '../store'
import { dictionaries } from '../i18n/strings'
import { useI18n } from '../composables/useI18n'

// 界面控件按钮（清屏/发送/需授权/字号等）跟随"界面语言"；对话内容才跟 AI 语言
const { t: uiT } = useI18n()

// AI 窗口的语言可单独切换：对话/内容文字用 state.aiLang
function t(key, ...args) {
  const entry = dictionaries[key]
  if (!entry) return key
  const val = state.aiLang === 'zh' ? entry.zh : entry.en
  return typeof val === 'function' ? val(...args) : val
}
const input = ref('')
const listEl = ref(null)
const busy = ref(false)

function toggleAiLang() {
  setAiLang(state.aiLang === 'zh' ? 'en' : 'zh')
}
function onSkillChange(name) {
  const skill = state.skills.find((s) => s.name === name) || null
  setAiSkill(skill)
}

// chat font size (localStorage-persisted)
const chatFont = ref(Number(localStorage.getItem('rafontsize') || 13))
function bumpFont(d) {
  chatFont.value = Math.min(20, Math.max(11, chatFont.value + d))
  localStorage.setItem('rafontsize', String(chatFont.value))
}

// clear the AI conversation directly (no confirmation), persisted via the store watch
function clearChat() {
  state.aiEvents.length = 0
}

function md(text) {
  // minimal safety: escape html, convert simple code ticks & line breaks
  let s = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')
}

function hasCode(m) {
  return (m.segments || []).some((s) => s.kind === 'code')
}
function codePartsOf(m) {
  return (m.segments || []).filter((s) => s.kind === 'code').map((s) => s.content)
}
function applyWidget(m, target = 'main', mode = 'append') {
  const parts = codePartsOf(m)
  if (!parts.length) return
  emitAiInsert(parts.join('\n'), target, mode)
  scrollBottom()
}
async function runThisCode(m) {
  const parts = codePartsOf(m)
  if (!parts.length || m._running) return
  m._running = true
  m.runResult = null
  try {
    m.runResult = await executeCell(parts.join('\n'))
    scrollBottom()
  } catch (e) {
    m.runResult = { ok: false, error: e.message || String(e) }
  } finally {
    m._running = false
  }
}
function onTog(e) { setApprovalMode(e.target.checked) }
function approveSeg(seg) {
  if (seg.pendingToken) approveCode(seg.pendingToken, true)
}
function skipSeg(seg) {
  if (seg.pendingToken) approveCode(seg.pendingToken, false)
}

/**
 * Expand shorthand references in the user's message before sending:
 *   ##          -> all code cells concatenated
 *   #代码块N / #N -> the Nth code cell's content
 * Replaced with a labelled block so the AI sees the exact code.
 */
function expandRefs(text) {
  let out = String(text)
  const cells = getCellsSnapshot()
  const all = (cells.length ? cells.map((c, i) => `[Block ${i + 1}]\n${c.code || '(empty)'}`).join('\n\n') : '(no code blocks)')
  // ## -> all cells
  out = out.replace(/##+/g, () => `\n===== All code blocks =====\n${all}\n===== End =====`)
  // #代码块N  (keep the shortcut, label in English)
  out = out.replace(/#代码块\s*(\d+)/g, (_, n) => {
    const i = Number(n) - 1
    const c = cells[i]
    return c ? `\n[Block ${n}]\n${c.code || '(empty)'}` : `(block ${n} does not exist)`
  })
  // #N (standalone cell reference, not inside a word)
  out = out.replace(/(?<!\w)#(\d+)(?!\w)/g, (_, n) => {
    const i = Number(n) - 1
    const c = cells[i]
    return c ? `\n[Block ${n}]\n${c.code || '(empty)'}` : `(block ${n} does not exist)`
  })
  return out
}

function send() {
  const raw = input.value.trim()
  if (!raw) return
  const text = expandRefs(raw)
  busy.value = true
  askAI(text)
  input.value = ''
  busy.value = false
  scrollBottom()
}

watch(() => state.aiEvents.length, scrollBottom, { flush: 'post' })
watch(() => state.aiEvents.map(x => x.segments.length + (x.textStream || '').length), scrollBottom, { flush: 'post' })

function scrollBottom() {
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  })
}
</script>

<style scoped>
.chat-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.chat-topbar { display: flex; justify-content: space-between; align-items: center; padding: 5px 10px 0; }
.tool-chk { display: inline-flex; align-items: center; gap: 3px; }
.tool-chk input { accent-color: var(--accent); cursor: pointer; margin: 0; }
.tool-sel { max-width: 120px; background: var(--bg-elev); color: var(--text); cursor: pointer; }
.tool-sel option { color: var(--text); background: var(--bg-panel); }
.plan-banner { margin: 6px 10px 0; border: 1px solid var(--accent); border-left: 3px solid var(--accent); border-radius: 6px; background: var(--bg-elev); padding: 6px 10px; flex: 0 0 auto; }
.plan-head { font-size: 11.5px; font-weight: 700; color: var(--accent); margin-bottom: 3px; }
.plan-list { margin: 0; padding-left: 18px; }
.plan-step { font-size: 12.5px; line-height: 1.6; }
.approve-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-dim); cursor: pointer; user-select: none; }
.approve-toggle input { accent-color: var(--accent); cursor: pointer; }
.font-ctrl { display: inline-flex; align-items: center; gap: 6px; }
.ft {
  background: var(--bg-elev); color: var(--text); border: 1px solid var(--border);
  border-radius: 5px; padding: 1px 8px; cursor: pointer; font-size: 12px; font-weight: 600;
}
.ft:hover { border-color: var(--accent); }
.ft.clear:hover { color: var(--err); border-color: var(--err); }
.ftsize { color: var(--text-dim); font-size: 12px; min-width: 18px; text-align: center; }
.msg-list { flex: 1; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 14px; }
.empty { color: var(--text-dim); text-align: center; padding: 20px; line-height: 1.9; }
.empty em { color: var(--text); font-style: normal; }
.conv { display: flex; flex-direction: column; gap: 8px; }
.bubble { padding: 8px 11px; border-radius: 9px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.bubble.user { background: var(--bg-elev); border: 1px solid var(--border); align-self: flex-end; max-width: 92%; }
.bubble.ai { background: var(--bg-elev); border: 1px solid var(--border); align-self: flex-start; }
.bubble.ai.err { border-color: var(--err); color: var(--err); }
.ai-wrap.streaming { opacity: 0.9; }
.text.mono { line-height: 1.7; }
.text :deep(code) { background: var(--bg-input); padding: 1px 5px; border-radius: 4px; color: var(--accent-2); font-family: var(--mono); font-size: 12px; }
.r-code {
  border: 1px solid #2c3c63; border-radius: 8px; overflow: hidden; margin-top: 6px; background: var(--bg-input);
}
.r-code.inspect { border-color: #35503f; }
.r-code-head { padding: 4px 9px; background: var(--bg-elev); color: var(--accent); font-size: 11.5px; font-weight: 600; }
.r-code.inspect .r-code-head { background: rgba(63,191,127,.12); color: var(--ok); }
.r-code-body { margin: 0; padding: 8px 10px; white-space: pre-wrap; color: var(--editor-fg); }
.r-inspect-body { margin: 0; padding: 8px 10px; white-space: pre-wrap; color: var(--accent-2); background: rgba(109,79,208,.06); }
.r-result { border-top: 1px dashed var(--border); }
.r-out { margin: 0; padding: 7px 10px; white-space: pre-wrap; color: var(--text); }
.r-out.mute { color: var(--text-dim); }
.r-err { margin: 0; padding: 7px 10px; white-space: pre-wrap; color: var(--err); background: rgba(255,93,108,.08); }
.plot-wrap { padding: 6px 10px; border-top: 1px dashed var(--border); background: var(--bg-input); }
.plot-wrap img { max-width: 100%; border-radius: 4px; display: block; }
.approve-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px dashed var(--border); background: rgba(255,180,84,.08); flex-wrap: wrap; }
.approve-tip { color: var(--warn); font-size: 12px; }
.btn-approve { border-radius: 6px; padding: 3px 12px; cursor: pointer; font-size: 12px; font-weight: 600; border: 1px solid; }
.btn-approve.ok { background: #17452b; color: #7fd6a5; border-color: #2f6a44; }
.btn-approve.ok:hover { filter: brightness(1.15); }
.btn-approve.no { background: var(--bg-elev); color: var(--text-dim); border-color: var(--border); }
.thinking { color: var(--text-dim); font-size: 12px; animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: 0.4; } }
.apply-row { margin-top: 8px; display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.run-result { margin-top: 6px; border: 1px solid var(--border); border-left: 3px solid var(--ok); border-radius: 6px; background: var(--bg-input); padding: 6px 10px; }
.run-result.err { border-left-color: var(--err); }
.run-head { font-size: 11.5px; font-weight: 600; color: var(--ok); margin-bottom: 4px; }
.run-result.err .run-head { color: var(--err); }
.run-out, .run-err { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12.5px; }
.run-err { color: var(--err); }
.btn.apply {
  background: #17452b; color: #7fd6a5; border: 1px solid #2f6a44;
  border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; font-weight: 600;
}
.btn.apply:hover { filter: brightness(1.15); }
.btn.apply.scratch { background: #4a3217; color: #d6b27f; border-color: #6a4f2f; }
.btn.apply.runbtn { background: #17456c; color: #8fc0ff; border-color: #2f5f8a; }
.composer { border-top: 1px solid var(--border); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.composer textarea {
  width: 100%; resize: none; background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-family: inherit; font-size: 13px;
}
.composer textarea:focus { outline: none; border-color: var(--accent); }
.composer-bar { display: flex; align-items: center; gap: 10px; }
.busy { color: var(--accent); font-size: 12px; }
.btn {
  background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 6px 18px;
  cursor: pointer; font-size: 12.5px; font-weight: 600;
}
.btn:disabled { opacity: 0.5; cursor: default; }
</style>
