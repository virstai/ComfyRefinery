'use strict';

// LoRA catalog helpers + agent tool factories for the generate step's prompt
// builder. Tool factories return agent-style tools ({ name, description,
// parameters, guidance, execute }) — see src/services/agent.js. Guidance
// travels with each tool, so the system prompt only mentions capabilities the
// current step settings actually enable.

// Registry entries matching the architecture, excluding always-on names.
// Null-architecture (untagged) loras are never offered to the LLM.
function catalogForArch(registry, architecture, excludeNames = []) {
  const excluded = new Set(excludeNames);
  return Object.values(registry ?? {})
    .filter(l => l.architecture === architecture && !excluded.has(l.filename));
}

// System-prompt section for the step's always-on LoRAs. '' when none.
// Not tool guidance: it applies even when the LLM has no tools at all.
function alwaysOnSection(alwaysOn, registry) {
  if (!alwaysOn?.length) return '';
  const lines = alwaysOn.map(l => {
    const reg = registry?.[l.name];
    const triggers = reg?.triggerWords?.length ? ` Trigger words: ${reg.triggerWords.join(', ')}.` : '';
    return `- ${reg?.label ?? l.name}.${triggers}`;
  });
  return `These LoRAs are already applied to the model — include their trigger words in the prompt where given:\n${lines.join('\n')}`;
}

// add_lora agent tool. Applied loras accumulate in `chosen` (deduped, first
// call wins); invalid names go to `warnings` and the model gets corrective
// feedback so it can retry within the loop.
function addLoraTool(catalog, chosen, warnings) {
  const byName = new Map(catalog.map(l => [l.filename, l]));
  const lines = catalog.map(l => {
    const desc     = l.description ? ` ${l.description}.` : '';
    const triggers = l.triggerWords?.length ? ` Trigger words: ${l.triggerWords.join(', ')}.` : '';
    return `- ${l.filename} (${l.label}, default weight ${l.defaultWeight}):${desc}${triggers}`;
  });

  return {
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
    guidance:
      `Optional LoRAs — call add_lora when one clearly helps the description ` +
      `(include its trigger words in the prompt too):\n${lines.join('\n')}`,
    execute(args) {
      const entry = byName.get(args?.name);
      if (!entry) {
        warnings.push(`Ignored unknown LoRA: ${args?.name}`);
        return `Unknown LoRA "${args?.name}" — choose a name from the catalog.`;
      }
      if (chosen.some(l => l.name === entry.filename)) {
        return `${entry.filename} is already applied.`;
      }
      const weight = typeof args.weight === 'number' ? args.weight : entry.defaultWeight;
      chosen.push({ name: entry.filename, weight });
      return `Applied ${entry.filename} at weight ${weight}.`;
    },
  };
}

// request_pose agent tool. Sets state.wantsPose + state.description; the pose
// pre-pass renders the description with a detection-friendly template.
function requestPoseTool(state) {
  return {
    name:        'request_pose',
    description: 'Generate a pose guide image so the generation follows the expected pose and framing.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'The pose in plain physical body terms: stance, limbs, gesture, body orientation, how much of the body is in view',
        },
      },
      required: ['description'],
    },
    guidance:
      'A pose ControlNet is available: when the description implies specific pose(s), gesture(s), or ' +
      'framing, call the request_pose tool with a plain physical description of every subject\'s pose ' +
      '(e.g. "a woman standing facing the viewer, one arm raised pointing directly at the camera, the ' +
      'other relaxed at her side"). Head-to-toe stance descriptions extract the most reliable pose ' +
      'guides — prefer them unless the image really calls for closer framing. Multiple subjects are ' +
      'supported: describe each one. No art-style terms.',
    execute(args) {
      state.wantsPose   = true;
      state.description = args?.description || null;
      return 'Pose guide will be generated and applied via ControlNet.';
    },
  };
}

// Merge step always-on + LLM-chosen, deduped by name; step config wins.
function mergeLoras(stepLoras = [], llmLoras = []) {
  const merged = stepLoras.map(l => ({ name: l.name, weight: l.weight ?? 1.0, source: 'step' }));
  for (const l of llmLoras) {
    if (!merged.some(m => m.name === l.name)) merged.push({ name: l.name, weight: l.weight, source: 'llm' });
  }
  return merged;
}

module.exports = { catalogForArch, alwaysOnSection, addLoraTool, requestPoseTool, mergeLoras };
