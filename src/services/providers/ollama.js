'use strict';

async function chat(cfg, messages, options = {}) {
  const url = cfg.ollamaUrl || 'http://127.0.0.1:11434';
  const res = await fetch(`${url}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: cfg.llmModel, messages, stream: false, ...options }),
  });

  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  return (await res.json()).message.content;
}

async function chatStream(cfg, messages, onToken, options = {}) {
  const url = cfg.ollamaUrl || 'http://127.0.0.1:11434';
  const res = await fetch(`${url}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: cfg.llmModel, messages, stream: true, ...options }),
  });

  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

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
      if (!line.trim()) continue;
      try {
        const obj   = JSON.parse(line);
        const token = obj.message?.content ?? '';
        if (token) { full += token; onToken?.(token); }
      } catch { /* skip non-JSON lines */ }
    }
  }
  return full;
}

async function listModels(cfg) {
  const url = cfg.ollamaUrl || 'http://127.0.0.1:11434';
  const res = await fetch(`${url}/api/tags`);
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);
  return (await res.json()).models || [];
}

module.exports = { chat, chatStream, listModels };
