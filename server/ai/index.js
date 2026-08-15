'use strict';
/**
 * ai/index.js — unified AI interface + provider registry.
 *
 * Mirrors `pi-ai`'s idea: one entry point (chatStream) that dispatches to the
 * configured provider. Providers share a common StreamingChat shape:
 *   chatStream(cfg, messages, opts) -> AsyncGenerator<{type:'text'|'done',...}>
 *   ping(cfg) -> Promise<boolean>
 *
 * `messages` are transport-neutral:
 *   { role: 'system'|'user'|'assistant'|'toolResult', content: string, toolCallId?: string }
 *
 * App-specific tool results (from the R agent) are injected as 'toolResult'
 * roles, letting any provider "remember" prior R steps — the same feedback
 * mechanism pi uses to feed tool results back into the loop.
 */

const { PROVIDER_DEFAULTS } = require('../config');
const openaiCompat = require('./providers/openai-compat');
const anthropic = require('./providers/anthropic');

// providerId -> adapter
const ADAPTERS = {
  ollama:     openaiCompat,
  custom:     openaiCompat,
  openai:     openaiCompat,
  groq:       openaiCompat,
  openrouter: openaiCompat,
  anthropic:  anthropic,
};

/**
 * Resolve the effective provider config from settings + per-provider defaults.
 * @param {object} settings loaded config
 * @param {object} [override] optional inline override
 */
function resolveConfig(settings, override = {}) {
  const provider = (override.provider || settings.ai?.provider || 'ollama').toLowerCase();
  const def = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.ollama;
  return {
    provider,
    baseUrl: override.baseUrl || settings.ai?.baseUrl || def.baseUrl,
    apiKey: override.apiKey !== undefined ? override.apiKey : (settings.ai?.apiKey || ''),
    model: override.model || settings.ai?.model || def.model,
    needsKey: !!def.key,
  };
}

/** Is an AI provider actually available (has adapter + key when required)? */
function available(settings) {
  const c = resolveConfig(settings || {});
  if (!ADAPTERS[c.provider]) return { ok: false, reason: `未知 provider: ${c.provider}` };
  if (c.needsKey && !c.apiKey) {
    return { ok: false, reason: `${c.provider} 需要 API Key，请在设置中填写，或切换到本地 Ollama。` };
  }
  return { ok: true, config: c };
}

/**
 * Unified streaming chat. Returns the done output with full accumulated text.
 * @param {object} settings
 * @param {Array} messages
 * @param {object} opts {provider, onDelta}
 * @returns {Promise<{content:string, provider:string}>}
 */
async function chat(settings, messages, opts = {}) {
  const conf = resolveConfig(settings, { provider: opts.provider });
  const adapter = ADAPTERS[conf.provider];
  if (!adapter) throw new Error(`不支持的 provider: ${conf.provider}`);
  if (conf.needsKey && !conf.apiKey) {
    throw new Error(`${conf.provider} 需要 API Key。请在设置里填写，或在设置里切换到本地 Ollama。`);
  }
  let full = '';
  for await (const ev of adapter.chatStream(conf, messages, { signal: opts.signal })) {
    if (ev.type === 'text') {
      full += ev.delta;
      if (opts.onDelta) opts.onDelta(ev.delta);
    }
  }
  return { content: full, provider: conf.provider };
}

/** Plain (non-stream) convenience. */
async function complete(settings, messages, opts = {}) {
  const out = await chat(settings, messages, { ...opts, onDelta: null });
  return out.content;
}

/** Check whether a provider endpoint responds (e.g. Ollama running?). */
async function ping(settings, provider) {
  const conf = resolveConfig(settings, { provider });
  const adapter = ADAPTERS[conf.provider];
  if (!adapter) return false;
  return adapter.ping(conf);
}

module.exports = { chat, complete, ping, resolveConfig, available };
