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
// When a message has an `images` array, content becomes an array of parts.
function toOpenAIMessages(messages) {
  return messages.map(m => {
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

async function chatStream(cfg, messages, onToken, options = {}) {
  const { signal, ...bodyOptions } = options;
  const res = await fetch(`${baseUrl(cfg)}/chat/completions`, {
    method:  'POST',
    headers: authHeaders(cfg),
    body:    JSON.stringify({ model: cfg.llmModel, messages: toOpenAIMessages(messages), stream: true, ...bodyOptions }),
    signal,
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf  = '';

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
        const token = obj.choices?.[0]?.delta?.content ?? '';
        if (token) { full += token; onToken?.(token); }
      } catch { /* skip malformed chunks */ }
    }
  }
  return full;
}

async function listModels(cfg) {
  const res = await fetch(`${baseUrl(cfg)}/models`, { headers: authHeaders(cfg) });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.data ?? []).map(m => m.id);
}

module.exports = { chat, chatStream, listModels };
