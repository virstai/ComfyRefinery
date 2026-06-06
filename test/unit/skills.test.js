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

test('get returns null when no skill file exists', () => {
  assert.equal(skills.get('unknown-model'), null);
});

test('record creates a skill file with outcome data', () => {
  skills.record('m1', 'Model 1', 'sd15', 'ACCEPT');
  const data = skills.get('m1');
  assert.ok(data);
  assert.equal(data.outcomes.accepts, 1);
  assert.equal(data.outcomes.rejects, 0);
});

test('record accumulates accepts and rejects', () => {
  skills.record('m2', 'Model 2', 'flux', 'REJECT');
  skills.record('m2', 'Model 2', 'flux', 'REJECT');
  skills.record('m2', 'Model 2', 'flux', 'ACCEPT');
  const data = skills.get('m2');
  assert.equal(data.outcomes.accepts, 1);
  assert.equal(data.outcomes.rejects, 2);
});

test('getSummary returns null when no data exists', () => {
  assert.equal(skills.getSummary('no-model'), null);
});

test('getSummary returns null when outcomes are all zero', () => {
  // Manually write a file with zero outcomes
  const dir = process.env.SKILLS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'zero-model.json'), JSON.stringify({
    workflowId: 'zero-model', workflowLabel: 'Zero', architecture: 'sd15',
    skill: null, skillUpdatedAt: null,
    outcomes: { accepts: 0, rejects: 0, notes: [] },
  }));
  assert.equal(skills.getSummary('zero-model'), null);
});

test('getSummary returns stats text when no synthesised skill exists', () => {
  skills.record('m3', 'Model 3', 'sdxl', 'ACCEPT', 'fine');
  const summary = skills.getSummary('m3');
  assert.ok(summary.includes('1/1'));
  assert.ok(summary.includes('100%'));
});

test('getSummary returns synthesised skill text when one exists', () => {
  skills.record('m4', 'Model 4', 'sdxl', 'ACCEPT', 'fine');
  skills.setSkill('m4', 'Use short descriptive tags for best results.');
  const summary = skills.getSummary('m4');
  assert.ok(summary.includes('Use short descriptive tags'));
  assert.ok(summary.includes('learned from previous sessions'));
});

test('setSkill updates the skill text and timestamp', () => {
  skills.record('m5', 'Model 5', 'flux', 'REJECT', 'bad');
  skills.setSkill('m5', 'New skill text.');
  const data = skills.get('m5');
  assert.equal(data.skill, 'New skill text.');
  assert.ok(data.skillUpdatedAt);
});
