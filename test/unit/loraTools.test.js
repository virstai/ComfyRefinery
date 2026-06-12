'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { catalogForArch, alwaysOnSection, addLoraTool, requestPoseTool, mergeLoras } =
  require('../../src/lib/loraTools');

const REGISTRY = {
  'anima_turbo.safetensors': { filename: 'anima_turbo.safetensors', label: 'Anima Turbo', architecture: 'anima', triggerWords: ['turbo'], description: 'speed lora', defaultWeight: 1.0 },
  'anima_pose.safetensors':  { filename: 'anima_pose.safetensors',  label: 'Pose Helper', architecture: 'anima', triggerWords: [], description: '', defaultWeight: 0.8 },
  'xl_detail.safetensors':   { filename: 'xl_detail.safetensors',   label: 'XL Detail',   architecture: 'sdxl',  triggerWords: [], description: '', defaultWeight: 1.0 },
  'untagged.safetensors':    { filename: 'untagged.safetensors',    label: 'Untagged',    architecture: null,    triggerWords: [], description: '', defaultWeight: 1.0 },
};

test('catalogForArch filters by architecture and excludes always-on names', () => {
  const cat = catalogForArch(REGISTRY, 'anima', ['anima_turbo.safetensors']);
  assert.deepEqual(cat.map(l => l.filename), ['anima_pose.safetensors']);
});

test('catalogForArch hides null-architecture loras', () => {
  const cat = catalogForArch(REGISTRY, 'anima', []);
  assert.ok(!cat.some(l => l.filename === 'untagged.safetensors'));
});

test('alwaysOnSection lists trigger words; empty string when no always-on loras', () => {
  const text = alwaysOnSection([{ name: 'anima_turbo.safetensors', weight: 1.0 }], REGISTRY);
  assert.match(text, /already applied/);
  assert.match(text, /turbo/);
  assert.equal(alwaysOnSection([], REGISTRY), '');
});

test('addLoraTool: guidance lists the catalog, schema enum constrains names', () => {
  const cat  = catalogForArch(REGISTRY, 'anima', []);
  const tool = addLoraTool(cat, [], []);
  assert.equal(tool.name, 'add_lora');
  assert.match(tool.guidance, /add_lora/);
  assert.match(tool.guidance, /anima_pose\.safetensors/);
  assert.match(tool.guidance, /speed lora/);
  assert.deepEqual(tool.parameters.properties.name.enum,
    ['anima_turbo.safetensors', 'anima_pose.safetensors']);
  assert.deepEqual(tool.parameters.required, ['name']);
});

test('addLoraTool.execute: applies with explicit weight and with catalog default', () => {
  const cat = catalogForArch(REGISTRY, 'anima', []);
  const chosen = [], warnings = [];
  const tool = addLoraTool(cat, chosen, warnings);

  assert.match(tool.execute({ name: 'anima_pose.safetensors', weight: 0.5 }), /Applied/);
  assert.match(tool.execute({ name: 'anima_turbo.safetensors' }), /Applied/);
  assert.deepEqual(chosen, [
    { name: 'anima_pose.safetensors',  weight: 0.5 },
    { name: 'anima_turbo.safetensors', weight: 1.0 },
  ]);
  assert.equal(warnings.length, 0);
});

test('addLoraTool.execute: dedupes repeats (first wins) and rejects unknown names with feedback', () => {
  const cat = catalogForArch(REGISTRY, 'anima', []);
  const chosen = [], warnings = [];
  const tool = addLoraTool(cat, chosen, warnings);

  tool.execute({ name: 'anima_pose.safetensors', weight: 0.5 });
  assert.match(tool.execute({ name: 'anima_pose.safetensors', weight: 0.9 }), /already applied/i);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].weight, 0.5);

  const reply = tool.execute({ name: 'evil.safetensors' });
  assert.match(reply, /Unknown LoRA/);
  assert.match(reply, /catalog/i, 'corrective feedback points back to the catalog');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /evil\.safetensors/);
});

test('requestPoseTool: guidance explains when to call; execute flips state', () => {
  const state = { wantsPose: false };
  const tool  = requestPoseTool(state);
  assert.equal(tool.name, 'request_pose');
  assert.match(tool.guidance, /request_pose/);
  assert.match(tool.guidance, /pose/i);
  assert.match(tool.execute({ reason: 'framing' }), /[Pp]ose guide/);
  assert.equal(state.wantsPose, true);
});

test('mergeLoras: step always-on first, llm additions deduped, step wins', () => {
  const merged = mergeLoras(
    [{ name: 'anima_turbo.safetensors', weight: 1.0 }],
    [{ name: 'anima_turbo.safetensors', weight: 0.3 }, { name: 'anima_pose.safetensors', weight: 0.5 }],
  );
  assert.deepEqual(merged, [
    { name: 'anima_turbo.safetensors', weight: 1.0, source: 'step' },
    { name: 'anima_pose.safetensors',  weight: 0.5, source: 'llm' },
  ]);
});
