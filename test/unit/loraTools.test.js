'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { catalogForArch, loraSystemSection, buildTools, interpretToolCalls, mergeLoras } =
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

test('loraSystemSection lists always-on trigger words and selectable catalog', () => {
  const cat  = catalogForArch(REGISTRY, 'anima', ['anima_turbo.safetensors']);
  const text = loraSystemSection(cat, [{ name: 'anima_turbo.safetensors', weight: 1.0 }], REGISTRY);
  assert.match(text, /already applied/);
  assert.match(text, /turbo/);
  assert.match(text, /add_lora/);
  assert.match(text, /anima_pose\.safetensors/);
});

test('loraSystemSection empty when nothing to say', () => {
  assert.equal(loraSystemSection([], [], REGISTRY), '');
});

test('buildTools: add_lora enum from catalog, request_pose only when offered', () => {
  const cat = catalogForArch(REGISTRY, 'anima', []);
  const withPose = buildTools(cat, true);
  assert.equal(withPose.length, 2);
  assert.deepEqual(withPose[0].function.parameters.properties.name.enum,
    ['anima_turbo.safetensors', 'anima_pose.safetensors']);
  assert.equal(withPose[1].function.name, 'request_pose');

  assert.equal(buildTools(cat, false).length, 1);
  assert.equal(buildTools([], false).length, 0);
  assert.equal(buildTools([], true).length, 1, 'pose tool offered even with empty catalog');
});

test('interpretToolCalls: known loras kept, unknown dropped with warning, pose flag set', () => {
  const cat = catalogForArch(REGISTRY, 'anima', []);
  const out = interpretToolCalls([
    { id: 'c1', name: 'add_lora',     args: { name: 'anima_pose.safetensors', weight: 0.5 } },
    { id: 'c2', name: 'add_lora',     args: { name: 'evil.safetensors' } },
    { id: 'c3', name: 'add_lora',     args: { name: 'anima_turbo.safetensors' } },
    { id: 'c4', name: 'request_pose', args: { reason: 'specific framing' } },
    { id: 'c5', name: 'mystery_tool', args: {} },
  ], cat);
  assert.deepEqual(out.loras, [
    { name: 'anima_pose.safetensors',  weight: 0.5 },
    { name: 'anima_turbo.safetensors', weight: 1.0 },
  ]);
  assert.equal(out.wantsPose, true);
  assert.equal(out.warnings.length, 2);
});

test('interpretToolCalls dedupes repeated add_lora for the same name', () => {
  const cat = catalogForArch(REGISTRY, 'anima', []);
  const out = interpretToolCalls([
    { id: 'c1', name: 'add_lora', args: { name: 'anima_pose.safetensors', weight: 0.5 } },
    { id: 'c2', name: 'add_lora', args: { name: 'anima_pose.safetensors', weight: 0.9 } },
  ], cat);
  assert.equal(out.loras.length, 1);
  assert.equal(out.loras[0].weight, 0.5, 'first call wins');
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
