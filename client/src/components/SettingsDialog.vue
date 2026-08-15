<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="head">
        <span>{{ t('settingsTitle') }}</span>
        <button class="x" @click="$emit('close')">✕</button>
      </div>

      <div class="body">
        <div class="notice" v-if="needsKey">
          {{ t('needsKeyNote') }}
        </div>

        <fieldset>
          <legend>{{ t('aiHead') }}</legend>
          <div class="field">
            <label>{{ t('provider') }}</label>
            <select v-model="form.ai.provider">
              <option value="off">{{ t('offOpt') }}</option>
              <option value="ollama">{{ t('localOpt') }}</option>
              <option value="custom">{{ t('customOpt') }}</option>
              <option value="openai">OpenAI</option>
              <option value="groq">Groq</option>
              <option value="openrouter">OpenRouter</option>
              <option value="anthropic">Anthropic Claude</option>
            </select>
          </div>
          <div class="field">
            <label>{{ t('baseUrl') }}</label>
            <input v-model="form.ai.baseUrl" :disabled="form.ai.provider === 'off'" :placeholder="t('svcEndpoint')" />
          </div>
          <div class="field">
            <label>{{ t('apiKey') }} <span v-if="form.ai.provider === 'ollama' || form.ai.provider === 'custom'" class="dim">{{ t('keyOptional') }}</span></label>
            <input v-model="form.ai.apiKey" type="password" :disabled="form.ai.provider === 'ollama' || form.ai.provider === 'off'" :placeholder="t('keyPh')" autocomplete="off" />
          </div>
          <div class="field">
            <label>{{ t('model') }}</label>
            <input v-model="form.ai.model" :disabled="form.ai.provider === 'off'" />
          </div>
          <button class="test" @click="testPing" :disabled="testing">
            {{ testing ? t('testing_') : t('testConn') }}
          </button>
          <div v-if="pingMsg" class="ping" :class="pingOk ? 'ok' : 'bad'">{{ pingMsg }}</div>
        </fieldset>

        <fieldset>
          <legend>{{ t('rHead') }}</legend>
          <div class="field">
            <label>{{ t('rscriptPath') }} <span class="dim">{{ t('rscriptDim') }}</span></label>
            <input v-model="form.rscript" :placeholder="t('rscriptPh')" />
          </div>
        </fieldset>
      </div>

      <div class="foot">
        <button class="btn cancel" @click="$emit('close')">{{ t('cancel') }}</button>
        <button class="btn save" @click="save">{{ t('save_') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { state, emit as sockEmit } from '../store'
import { useI18n } from '../composables/useI18n'

const { t } = useI18n()
const emit = defineEmits(['close'])

const form = reactive({ ai: { provider: '', baseUrl: '', apiKey: '', model: '' }, rscript: '' })
const s = state.serverState?.settings
if (s) {
  form.ai = { provider: s.ai.provider, baseUrl: s.ai.baseUrl, apiKey: s.ai.apiKey, model: s.ai.model }
  form.rscript = s.rscript
}

const testing = ref(false)
const pingMsg = ref('')
const pingOk = ref(false)
const needsKey = computed(() => ['openai', 'groq', 'openrouter', 'anthropic'].includes(form.ai.provider))

function save() {
  sockEmit('save_settings', { settings: { ai: form.ai, rscript: form.rscript } })
  pingMsg.value = t('saved_')
  pingOk.value = true
  setTimeout(() => emit('close'), 0)
}

function testPing() {
  testing.value = true; pingMsg.value = ''
  // probe via a chat ping through the server: reuse settings save + state refresh is complex;
  // here we just validate by issuing a tiny request using the provider's raw endpoint.
  const baseUrl = form.ai.baseUrl
  const needsAuthKey = ['openai', 'groq', 'openrouter', 'anthropic'].includes(form.ai.provider)
  if (needsAuthKey && !form.ai.apiKey) {
    testing.value = false; pingOk.value = false; pingMsg.value = t('needsKeyProv')
    return
  }
  if (form.ai.provider === 'off') { testing.value = false; pingOk.value = false; pingMsg.value = t('aiOff'); return }
  const url = form.ai.provider === 'anthropic'
    ? `${baseUrl.replace(/\/$/, '')}/v1/messages`
    : `${baseUrl.replace(/\/$/, '')}/models`
  fetch(url, {
    headers: form.ai.provider === 'anthropic'
      ? { 'x-api-key': form.ai.apiKey, 'anthropic-version': '2023-06-01' }
      : (form.ai.apiKey ? { Authorization: `Bearer ${form.ai.apiKey}` } : {}),
  }).then((r) => {
    testing.value = false
    pingOk.value = r.ok
    pingMsg.value = r.ok ? t('connOk') : `✖ HTTP ${r.status}`
  }).catch(() => {
    testing.value = false; pingOk.value = false
    pingMsg.value = t('connFail')
  })
}
</script>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(5,8,15,.65); display: flex; align-items: center; justify-content: center; z-index: 50; }
.dialog { width: 520px; max-width: 92vw; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; }
.x { background: none; border: none; color: var(--text-dim); font-size: 15px; cursor: pointer; }
.body { padding: 14px 16px; max-height: 70vh; overflow: auto; }
.notice { background: rgba(255,180,84,.1); border: 1px solid var(--warn); color: var(--warn); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; font-size: 12.5px; line-height: 1.6; }
fieldset { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 14px; padding: 10px 12px 12px; }
legend { padding: 0 6px; color: var(--accent); font-size: 12.5px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.field label { font-size: 12px; color: var(--text-dim); }
.field input, .field select { background: var(--bg-input); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; font-size: 13px; }
.field input:focus, .field select:focus { outline: none; border-color: var(--accent); }
.dim { opacity: 0.6; }
.test { background: transparent; color: var(--accent); border: 1px solid var(--accent); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
.test:disabled { opacity: 0.5; }
.ping { margin-top: 8px; font-size: 12.5px; }
.ping.ok { color: var(--ok); } .ping.bad { color: var(--err); }
.foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.btn { border-radius: 6px; padding: 7px 16px; cursor: pointer; font-size: 12.5px; }
.btn.cancel { background: var(--bg-elev); color: var(--text); border: 1px solid var(--border); }
.btn.save { background: var(--accent); color: #fff; border: none; font-weight: 600; }
</style>
