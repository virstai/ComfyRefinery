'use strict';

// Generic tool-calling agent loop over llm.chatStream.
//
// A tool is { name, description, parameters, guidance?, execute? }:
// - `guidance` is appended to the system message (messages[0]) so the model
//   knows when to use the tool — tool schemas alone are not enough for many
//   local models, especially when the system prompt demands plain-text output.
//   Because guidance travels with the tool, the prompt automatically adapts to
//   whichever tools the current settings enable.
// - `execute(args)` runs when the model calls the tool; its return string is
//   sent back as the tool result so the model gets real feedback (validation
//   errors, dedup notices) and can correct itself within the loop.
//
// Returns { text, calls: [{ name, args }], warnings }.

const llm = require('./llm');

const DEFAULT_MAX_ROUNDS = 3;

async function run(cfg, messages, tools, { onToken, signal, maxRounds = DEFAULT_MAX_ROUNDS } = {}) {
  const calls    = [];
  const warnings = [];

  if (!tools?.length) {
    const text = await llm.chatStream(cfg, messages, onToken, { signal });
    return { text, calls, warnings };
  }

  const guidance = tools.map(t => t.guidance).filter(Boolean).join('\n\n');
  let convo = guidance
    ? [{ ...messages[0], content: `${messages[0].content}\n\n${guidance}` }, ...messages.slice(1)]
    : [...messages];

  const apiTools = tools.map(t => ({
    type:     'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const byName = new Map(tools.map(t => [t.name, t]));

  let text = '';
  for (let round = 0; round < maxRounds; round++) {
    const result = await llm.chatStream(cfg, convo, onToken, { signal, tools: apiTools });
    text = result.text;
    if (!result.toolCalls.length) break;

    const replies = result.toolCalls.map(tc => {
      const tool = byName.get(tc.name);
      let content;
      if (!tool) {
        warnings.push(`Ignored unknown tool call: ${tc.name}`);
        content = `Unknown tool "${tc.name}" — not applied.`;
      } else {
        calls.push({ name: tc.name, args: tc.args });
        content = tool.execute?.(tc.args) ?? 'applied';
      }
      return { role: 'tool', tool_call_id: tc.id, content };
    });

    convo = [
      ...convo,
      {
        role: 'assistant', content: result.text || null,
        tool_calls: result.toolCalls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      },
      ...replies,
    ];
  }

  // Round cap hit while the model was still calling tools → one final no-tools call.
  if (!text?.trim()) text = await llm.chatStream(cfg, convo, onToken, { signal });

  return { text, calls, warnings };
}

module.exports = { run, DEFAULT_MAX_ROUNDS };
