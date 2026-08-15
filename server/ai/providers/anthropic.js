'use strict';
/**
 * ai/providers/anthropic.js
 * Anthropic Messages API adapter (SSE streaming).
 * Aligns tool-result shape the same way pi's anthropic-messages impl does.
 */

function toAnthropicMessages(messages) {
  const out = [];
  let pendingToolResult = null;
  for (const m of messages) {
    if (m.role === 'toolResult') {
      // Anthropic wants consecutive user blocks after assistant tool_use; fold the
      // result into a single user message of tool_result blocks.
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content) }],
      });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: String(m.content) });
    } else if (m.role === 'system') {
      // system handled separately below; skip re-emit
    } else {
      out.push({ role: 'user', content: String(m.content) });
    }
  }
  return out;
}

function extractSystem(messages) {
  const parts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  return parts.join('\n\n');
}

/**
 * @returns {AsyncGenerator<{type:'text'|'done', delta?:string, output?:object}>}
 */
async function* chatStream(cfg, messages, opts = {}) {
  const url = `${String(cfg.baseUrl).replace(/\/$/, '')}/v1/messages`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
  };
  const sys = extractSystem(messages);
  const body = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? 2048,
    ...(sys ? { system: sys } : {}),
    messages: toAnthropicMessages(messages),
    stream: true,
    temperature: opts.temperature ?? 0.2,
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.body) throw new Error('AI 流式响应无内容');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  let content = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    const lines = acc.split('\n');
    acc = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        content += j.delta.text;
        yield { type: 'text', delta: j.delta.text };
      }
      if (j.type === 'message_delta' || j.type === 'message_stop') {
        break;
      }
    }
  }
  yield { type: 'done', output: { content, finish_reason: 'end_turn' } };
}

async function ping(cfg) {
  return Boolean(cfg.apiKey && String(cfg.apiKey).length > 0);
}

module.exports = { chatStream, ping };
