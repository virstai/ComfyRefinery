'use strict';

// LoRA catalog + tool-calling helpers for the generate step's prompt builder.

// Registry entries matching the architecture, excluding always-on names.
// Null-architecture (untagged) loras are never offered to the LLM.
function catalogForArch(registry, architecture, excludeNames = []) {
  const excluded = new Set(excludeNames);
  return Object.values(registry ?? {})
    .filter(l => l.architecture === architecture && !excluded.has(l.filename));
}

// System-prompt section describing always-on + selectable LoRAs. '' when empty.
function loraSystemSection(catalog, alwaysOn, registry) {
  const parts = [];
  if (alwaysOn.length) {
    const lines = alwaysOn.map(l => {
      const reg = registry?.[l.name];
      const triggers = reg?.triggerWords?.length ? ` Trigger words: ${reg.triggerWords.join(', ')}.` : '';
      return `- ${reg?.label ?? l.name}.${triggers}`;
    });
    parts.push(`These LoRAs are already applied to the model — include their trigger words in the prompt where given:\n${lines.join('\n')}`);
  }
  if (catalog.length) {
    const lines = catalog.map(l => {
      const desc     = l.description ? ` ${l.description}.` : '';
      const triggers = l.triggerWords?.length ? ` Trigger words: ${l.triggerWords.join(', ')}.` : '';
      return `- ${l.filename} (${l.label}, default weight ${l.defaultWeight}):${desc}${triggers}`;
    });
    parts.push(`Optional LoRAs — call add_lora when one clearly helps the description (include its trigger words in the prompt too):\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

// OpenAI tools array for the prompt-building call.
function buildTools(catalog, offerPose) {
  const tools = [];
  if (catalog.length) {
    tools.push({
      type: 'function',
      function: {
        name:        'add_lora',
        description: 'Apply a LoRA from the catalog to this generation. Call once per LoRA.',
        parameters: {
          type: 'object',
          properties: {
            name:   { type: 'string', enum: catalog.map(l => l.filename), description: 'LoRA filename from the catalog' },
            weight: { type: 'number', description: 'Strength 0-2; omit to use the default weight' },
          },
          required: ['name'],
        },
      },
    });
  }
  if (offerPose) {
    tools.push({
      type: 'function',
      function: {
        name:        'request_pose',
        description: 'Generate a pose/composition guide first so the image follows the expected framing. Use when the description implies specific poses, framing, or composition.',
        parameters: {
          type:       'object',
          properties: { reason: { type: 'string', description: 'Why a pose guide helps here' } },
          required:   [],
        },
      },
    });
  }
  return tools;
}

// Interpret accumulated tool calls against the catalog.
// Unknown lora names / unknown tools are dropped into warnings, never fatal.
function interpretToolCalls(toolCalls, catalog) {
  const byName   = new Map(catalog.map(l => [l.filename, l]));
  const loras    = [];
  const warnings = [];
  let wantsPose  = false;

  for (const tc of toolCalls ?? []) {
    if (tc.name === 'request_pose') { wantsPose = true; continue; }
    if (tc.name !== 'add_lora') { warnings.push(`Ignored unknown tool call: ${tc.name}`); continue; }
    const entry = byName.get(tc.args?.name);
    if (!entry) { warnings.push(`Ignored unknown LoRA: ${tc.args?.name}`); continue; }
    if (loras.some(l => l.name === entry.filename)) continue;
    loras.push({
      name:   entry.filename,
      weight: typeof tc.args.weight === 'number' ? tc.args.weight : entry.defaultWeight,
    });
  }
  return { loras, wantsPose, warnings };
}

// Merge step always-on + LLM-chosen, deduped by name; step config wins.
function mergeLoras(stepLoras = [], llmLoras = []) {
  const merged = stepLoras.map(l => ({ name: l.name, weight: l.weight ?? 1.0, source: 'step' }));
  for (const l of llmLoras) {
    if (!merged.some(m => m.name === l.name)) merged.push({ name: l.name, weight: l.weight, source: 'llm' });
  }
  return merged;
}

module.exports = { catalogForArch, loraSystemSection, buildTools, interpretToolCalls, mergeLoras };
