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

module.exports = { chat, chatStream, listModels, providers: Object.keys(registry) };
