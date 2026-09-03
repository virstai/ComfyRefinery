'use strict';

// LLM provider router. All AI text generation goes through here.
// The active provider is read from cfg.llmProvider (defaults to 'openai').
// To add a new provider: create src/services/providers/<name>.js implementing
// { chat(cfg, messages), chatStream(cfg, messages, onToken), listModels(cfg) }
// and add an entry to the registry below.
//
// The 'openai' provider speaks the OpenAI chat completions API and works with
// Ollama (point llmBaseUrl at its /v1 endpoint), real OpenAI, LM Studio, vLLM, etc.

const registry = {
  openai: require('./providers/openai'),
};

function getProvider(cfg) {
  const name     = cfg.llmProvider ?? 'openai';
  const provider = registry[name];
  if (!provider) throw new Error(`Unknown LLM provider "${name}". Valid: ${Object.keys(registry).join(', ')}`);
  return provider;
}

function chat(cfg, messages, options) {
  return getProvider(cfg).chat(cfg, messages, options);
}

function chatStream(cfg, messages, onToken, options) {
  return getProvider(cfg).chatStream(cfg, messages, onToken, options);
}

function listModels(cfg) {
  return getProvider(cfg).listModels(cfg);
}

// Ask the LLM server to drop its model from the GPU (best effort, opt-in via
// cfg.llmUnloadEnabled). Used before ComfyUI jobs that run for minutes without
// needing the LLM, so a GPU shared between the two (e.g. a VAE placed on the
// LLM's card) is not silently oversubscribed. The OpenAI-compatible API has no
// unload call, so the request is configurable: URL, method, optional JSON body
// with "{model}" substituted. The server reloads the model on its next request.
// Returns true when the call succeeded.
function unloadRequest(cfg) {
  const url = (cfg?.llmUnloadUrl ?? '').trim();
  if (!cfg?.llmUnloadEnabled || !url) return null;
  const method = String(cfg.llmUnloadMethod ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const bodyTemplate = (cfg.llmUnloadBody ?? '').trim();
  const body = method === 'POST' && bodyTemplate ? bodyTemplate.replace(/\{model\}/g, cfg.llmModel ?? '') : null;
  return { url, method, body };
}

async function release(cfg, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const req = unloadRequest(cfg);
  if (!req) return false;
  try {
    const res = await fetchImpl(req.url, {
      method: req.method,
      ...(req.body != null ? { headers: { 'Content-Type': 'application/json' }, body: req.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { console.warn(`[llm] unload request to ${req.url} returned ${res.status}`); return false; }
    return true;
  } catch (e) {
    console.warn(`[llm] unload request to ${req.url} failed: ${e.message}`);
    return false;
  }
}

module.exports = { chat, chatStream, listModels, release, unloadRequest, providers: Object.keys(registry) };
