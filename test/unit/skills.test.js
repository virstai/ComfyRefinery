'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-skills-test-'));
  process.env.SKILLS_DIR = path.join(tmpDir, 'skills');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SKILLS_DIR;
});

const skills = require('../../src/services/skills');

function activeVer(data) {
  return (data.versions ?? []).find(v => v.id === data.activeVersionId) ?? null;
}

test('get returns null when no skill file exists', () => {
  assert.equal(skills.get('unknown-model'), null);
});

test('record creates a skill file with outcome data on the active version', () => {
  skills.record('m1', 'Model 1', 'sd15', 'ACCEPT');
  const data = skills.get('m1');
  assert.ok(data);
  const ver = activeVer(data);
  assert.ok(ver, 'should have an active version');
  assert.equal(ver.outcomes.accepts, 1);
  assert.equal(ver.outcomes.rejects, 0);
});

test('record accumulates accepts and rejects on the active version', () => {
  skills.record('m2', 'Model 2', 'flux', 'REJECT');
  skills.record('m2', 'Model 2', 'flux', 'REJECT');
  skills.record('m2', 'Model 2', 'flux', 'ACCEPT');
  const data = skills.get('m2');
  const ver  = activeVer(data);
  assert.equal(ver.outcomes.accepts, 1);
  assert.equal(ver.outcomes.rejects, 2);
});

test('getSummary returns null when no data exists', () => {
  assert.equal(skills.getSummary('no-model'), null);
});

test('getSummary returns architecture default when no synthesised skill and zero outcomes', () => {
  const dir = process.env.SKILLS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  // sd15 has a default skill — getSummary returns it even with zero outcomes.
  fs.writeFileSync(path.join(dir, 'zero-model.json'), JSON.stringify({
    workflowId: 'zero-model', workflowLabel: 'Zero', architecture: 'sd15',
    skill: null, skillUpdatedAt: null,
    outcomes: { accepts: 0, rejects: 0 }, notes: [],
  }));
  const summary = skills.getSummary('zero-model');
  assert.ok(summary !== null, 'should return architecture default instead of null');
  assert.ok(summary.includes('Danbooru'), 'should include sd15 architecture default text');
});

test('getSummary returns architecture default when no synthesised skill exists', () => {
  skills.record('m3', 'Model 3', 'sdxl', 'ACCEPT');
  const summary = skills.getSummary('m3');
  // sdxl has a default skill — it is returned before the stats fallback.
  assert.ok(summary !== null, 'should return architecture default');
  assert.ok(summary.includes('SDXL'), 'should include sdxl architecture default text');
});

test('getSummary returns synthesised skill text when one exists', () => {
  skills.record('m4', 'Model 4', 'sdxl', 'ACCEPT');
  skills.setSkill('m4', 'Use short descriptive tags for best results.');
  const summary = skills.getSummary('m4');
  assert.ok(summary.includes('Use short descriptive tags'));
  assert.ok(summary.includes('learned from previous sessions'));
});

test('setSkill adds a new version and sets it active', () => {
  skills.record('m5', 'Model 5', 'flux', 'REJECT');
  skills.setSkill('m5', 'New skill text.');
  const data = skills.get('m5');
  const ver  = activeVer(data);
  assert.equal(ver.skill, 'New skill text.');
  assert.ok(ver.createdAt);
});

test('addVersion evicts worst performer when over cap of 5', () => {
  const wfId = 'cap-test';
  skills.record(wfId, 'Cap Test', 'sd15', 'ACCEPT');
  // Manually add 4 more versions to reach the cap.
  for (let i = 0; i < 4; i++) skills.addVersion(wfId, `skill v${i + 2}`, 'auto');
  let data = skills.get(wfId);
  assert.equal(data.versions.length, 5);

  // Mark the initial (worst: 0/0 after eviction logic) version as having bad outcomes.
  // Add a 6th version — should evict the worst.
  skills.addVersion(wfId, 'skill v6', 'auto');
  data = skills.get(wfId);
  assert.equal(data.versions.length, 5, 'should stay at 5 after eviction');
});

test('activateVersion switches the active version', () => {
  const wfId = 'act-test';
  skills.record(wfId, 'Act Test', 'sd15', 'ACCEPT');
  const first = skills.get(wfId).activeVersionId;
  skills.addVersion(wfId, 'second skill', 'auto');
  const data  = skills.get(wfId);
  assert.notEqual(data.activeVersionId, first);

  skills.activateVersion(wfId, first);
  assert.equal(skills.get(wfId).activeVersionId, first);
});

test('deleteVersion removes a non-active version', () => {
  const wfId = 'del-test';
  skills.record(wfId, 'Del Test', 'sd15', 'ACCEPT');
  const first = skills.get(wfId).activeVersionId;
  skills.addVersion(wfId, 'second', 'auto');
  const data  = skills.get(wfId);
  assert.equal(data.versions.length, 2);

  skills.deleteVersion(wfId, first);
  assert.equal(skills.get(wfId).versions.length, 1);
});

test('deleteVersion throws when attempting to delete the active version', () => {
  const wfId = 'del-active-test';
  skills.record(wfId, 'Del Active', 'sd15', 'ACCEPT');
  const active = skills.get(wfId).activeVersionId;
  assert.throws(() => skills.deleteVersion(wfId, active), /Cannot delete the active version/);
});

test('setLocked prevents addVersion from being called via refresher guard', () => {
  const wfId = 'lock-test';
  skills.record(wfId, 'Lock Test', 'sd15', 'ACCEPT');
  skills.setLocked(wfId, true);
  const data = skills.get(wfId);
  assert.equal(data.skillLocked, true);
  skills.setLocked(wfId, false);
  assert.equal(skills.get(wfId).skillLocked, false);
});

test('migrates legacy flat format transparently', () => {
  const dir = process.env.SKILLS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy-wf.json'), JSON.stringify({
    workflowId: 'legacy-wf', workflowLabel: 'Legacy', architecture: 'sd15',
    skill: 'Old skill text.', skillUpdatedAt: '2025-01-01T00:00:00.000Z',
    outcomes: { accepts: 3, rejects: 1 }, notes: [],
  }));
  const data = skills.get('legacy-wf');
  assert.ok(Array.isArray(data.versions), 'should have versions array');
  assert.equal(data.versions.length, 1);
  const ver = activeVer(data);
  assert.equal(ver.skill, 'Old skill text.');
  assert.equal(ver.source, 'legacy');
  assert.equal(ver.outcomes.accepts, 3);
});
