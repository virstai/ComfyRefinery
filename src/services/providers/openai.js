'use strict';

// OpenAI-compatible LLM provider.
// Works with Ollama (/v1 endpoint), real OpenAI, LM Studio, vLLM, and any other
// provider that implements the OpenAI chat completions API.

function baseUrl(cfg) {
  const url = cfg.llmBaseUrl || (cfg.ollamaUrl ? cfg.ollamaUrl.replace(/\/+$/, '') + '/v1' : 'http://127.0.0.1:11434/v1');
  return url.replace(/\/+$/, '');
}

function authHeaders(cfg) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.llmApiKey) headers['Authorization'] = `Bearer ${cfg.llmApiKey}`;
  return headers;
}

// Convert internal message format to OpenAI format.
// - `images: [...]` → content-array with image_url parts
// - role 'tool' and assistant `tool_calls` pass through unchanged (tool loop)
function toOpenAIMessages(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.tool_calls) return { role: m.role, content: m.content ?? null, tool_calls: m.tool_calls };
    if (!m.images?.length) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        ...m.images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${img}` },
        })),
      ],
    };
  });
}

async function chat(cfg, messages, options = {}) {
  const res = await fetch(`${baseUrl(cfg)}/chat/completions`, {
    method:  'POST',
    headers: authHeaders(cfg),
    body:    JSON.stringify({ model: cfg.llmModel, messages: toOpenAIMessages(messages), stream: false, ...options }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

// Returns a plain string when options.tools is absent/empty; { text, toolCalls: [{ id, name, args }] } otherwise.
async function chatStream(cfg, messages, onToken, options = {}) {
  const { signal, tools, ...bodyOptions } = options;
  const body = { model: cfg.llmModel, messages: toOpenAIMessages(messages), stream: true, ...bodyOptions };
  if (tools?.length) body.tools = tools;

  const res = await fetch(`${baseUrl(cfg)}/chat/completions`, {
    method:  'POST',
    headers: authHeaders(cfg),
    body:    JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf  = '';
  const toolCallAcc = new Map(); // stream index → { id, name, args (json string) }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      try {
        const obj   = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta;
        const token = delta?.content ?? '';
        if (token) { full += token; onToken?.(token); }
        for (const tc of delta?.tool_calls ?? []) {
          const cur = toolCallAcc.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id)                  cur.id   = tc.id;
          if (tc.function?.name)      cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolCallAcc.set(tc.index, cur);
        }
      } catch { /* skip malformed chunks */ }
    }
  }

  if (!tools?.length) return full;

  const toolCalls = [];
  for (const cur of toolCallAcc.values()) {
    try {
      toolCalls.push({ id: cur.id, name: cur.name, args: JSON.parse(cur.args || '{}') });
    } catch {
      console.warn(`[llm] dropping tool call "${cur.name}": malformed arguments`);
    }
  }
  return { text: full, toolCalls };
}

async function listModels(cfg) {
  const res = await fetch(`${baseUrl(cfg)}/models`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.data ?? []).map(m => m.id);
}

module.exports = { chat, chatStream, listModels };
