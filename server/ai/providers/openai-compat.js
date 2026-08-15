'use strict';
/**
 * ai/providers/openai-compat.js
 * Generic adapter for ANY OpenAI Chat Completions–compatible endpoint.
 * This single adapter covers: Ollama, OpenRouter, Groq, Together, vLLM, LM
 * Studio, deepseek, etc. (the way pi's `pi-ai` routes many providers through
 * its `openai-completions` wire implementation).
 */
'use strict';

/**
 * Convert internal message list to OpenAI Chat Messages format.
 * @param {Array<{role:'system'|'user'|'assistant'|'toolResult'|'tool',content:string,name?:string}>} messages
 */
function toOpenAIMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'toolResult') {
      out.push({ role: 'assistant', content: '', name: m.name });
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId || `tc-${out.length}`,
        content: String(m.content),
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content) });
    } else {
      out.push({ role: m.role === 'system' ? 'system' : m.role, content: String(m.content) });
    }
  }
  return out;
}

/**
 * Stream a chat completion.
 * @param {object} cfg {baseUrl, apiKey, model}
 * @param {Array} messages internal message list
 * @returns {AsyncGenerator<{type:'text'|'done', delta?:string, output?:{content:string,finish_reason:string}}>}
 */
async function* chatStream(cfg, messages, opts = {}) {
  const url = `${String(cfg.baseUrl).replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const body = {
    model: cfg.model,
    messages: toOpenAIMessages(messages),
    stream: true,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0.2,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.body) throw new Error('AI 流式响应无内容');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    // SSE lines
    const lines = acc.split('\n');
    acc = lines.pop(); // keep partial last line
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') break;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length) {
        yield { type: 'text', delta };
      }
      if (json.choices?.[0]?.finish_reason) {
        const full = json.choices[0].message?.content ||
          json.choices[0].delta?.content || '';
        yield { type: 'done', output: { content: full, finish_reason: json.choices[0].finish_reason } };
      }
    }
  }
  // final done if never emitted
  const finalText = acc;
  yield { type: 'done', output: { content: finalText, finish_reason: 'stop' } };
}

/** Verify connect (e.g. Ollama reachable?) — light HEAD/POST. */
async function ping(cfg) {
  try {
    const url = `${String(cfg.baseUrl).replace(/\/$/, '')}/models`;
    const res = await fetch(url, { headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {} });
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { chatStream, ping, toOpenAIMessages };
