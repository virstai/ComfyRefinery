'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let tmpDir;
let fakeOllamaServer;
let lastReceivedMessages = null;
let skillResponse = 'SKILL\nUse short descriptive tags.\n\nENFORCE\nAlways adapt to model style.\n\nBLACKLIST\nbad-word, another-word';

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-refresher-test-'));
  process.env.SKILLS_DIR = path.join(tmpDir, 'skills');
  process.env.DATA_DIR   = tmpDir;

  fakeOllamaServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      lastReceivedMessages = parsed.messages;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: skillResponse }, finish_reason: 'stop' }],
      }));
    });
  });

  await new Promise(r => fakeOllamaServer.listen(0, r));

  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:  `http://127.0.0.1:${fakeOllamaServer.address().port}/v1`,
    llmModel:    'test-model',
    llmProvider: 'openai',
  }));
});

after(async () => {
  await new Promise(r => fakeOllamaServer.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SKILLS_DIR;
  delete process.env.DATA_DIR;
});

const skills        = require('../../src/services/skills');
const { refreshSkill } = require('../../src/services/skillRefresher');

function seedModel(id, accepts, rejects) {
  const dir = process.env.SKILLS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    workflowId: id, workflowLabel: id, architecture: 'sd15',
    skill: null, skillUpdatedAt: null,
    outcomes: { accepts, rejects },
    notes: [],
  }));
}

test('skips silently when skill file does not exist', async () => {
  lastReceivedMessages = null;
  await refreshSkill('ghost-model', 'Ghost', 'sd15');
  assert.equal(lastReceivedMessages, null, 'should not have called ollama');
});

test('skips when outcomes are zero and no correction note', async () => {
  seedModel('zero-outcomes', 0, 0);
  lastReceivedMessages = null;
  await refreshSkill('zero-outcomes', 'Zero', 'sd15');
  assert.equal(lastReceivedMessages, null, 'should not have called ollama');
});

test('runs when a correction note is provided even with zero outcomes', async () => {
  seedModel('note-only', 0, 0);
  lastReceivedMessages = null;
  await refreshSkill('note-only', 'NoteOnly', 'sd15', 'Always use danbooru tags.');
  assert.ok(lastReceivedMessages, 'should have called ollama');
});

test('correction note appears in the user message with priority wording', async () => {
  seedModel('with-note', 3, 1);
  await refreshSkill('with-note', 'WithNote', 'sd15', 'Never use natural language.');
  const userMsg = lastReceivedMessages.find(m => m.role === 'user');
  assert.ok(userMsg.content.includes('Never use natural language.'), 'note text should be in message');
  assert.ok(userMsg.content.includes('takes priority'), 'should mark the note as taking priority');
});

test('no correction note section when note is empty', async () => {
  seedModel('no-note', 8, 2); // ≥10 sessions so auto-refresh runs
  await refreshSkill('no-note', 'NoNote', 'sd15');
  const userMsg = lastReceivedMessages.find(m => m.role === 'user');
  assert.ok(!userMsg.content.includes('takes priority'), 'should not have correction note section');
});

test('updates skill text from SKILL section of response', async () => {
  seedModel('skill-parse', 8, 2); // ≥10 sessions
  skillResponse = 'SKILL\nThis is the updated skill text.';
  await refreshSkill('skill-parse', 'SkillParse', 'sd15');
  const data   = skills.get('skill-parse');
  const actVer = data.versions?.find(v => v.id === data.activeVersionId);
  assert.equal(actVer.skill, 'This is the updated skill text.');
  assert.ok(actVer.createdAt, 'version should have a createdAt timestamp');
  skillResponse = 'SKILL\nUse short descriptive tags.\n\nENFORCE\nAlways adapt to model style.\n\nBLACKLIST\nbad-word, another-word';
});

test('parses ENFORCE lines into auto notes (disabled by default)', async () => {
  seedModel('enforce-parse', 8, 2); // ≥10 sessions
  skillResponse = 'SKILL\nSome skill.\n\nENFORCE\nAlways use danbooru tags.\nAvoid natural language.';
  await refreshSkill('enforce-parse', 'EnforceParse', 'sd15');
  const data = skills.get('enforce-parse');
  const enforceNotes = data.notes.filter(n => n.type === 'enforce' && n.auto);
  assert.equal(enforceNotes.length, 2);
  assert.equal(enforceNotes[0].text, 'Always use danbooru tags.');
  assert.equal(enforceNotes[1].text, 'Avoid natural language.');
  assert.equal(enforceNotes[0].enabled, false, 'auto notes should default to disabled');
  skillResponse = 'SKILL\nUse short descriptive tags.\n\nENFORCE\nAlways adapt to model style.\n\nBLACKLIST\nbad-word, another-word';
});

test('parses BLACKLIST into one auto note per word', async () => {
  seedModel('blacklist-parse', 8, 2); // ≥10 sessions
  skillResponse = 'SKILL\nSome skill.\n\nBLACKLIST\nfoo, bar, baz';
  await refreshSkill('blacklist-parse', 'BlacklistParse', 'sd15');
  const data = skills.get('blacklist-parse');
  const blNotes = data.notes.filter(n => n.type === 'blacklist' && n.auto);
  assert.equal(blNotes.length, 3, 'should have one note per word');
  assert.deepEqual(blNotes.map(n => n.words[0]).sort(), ['bar', 'baz', 'foo']);
  assert.ok(blNotes.every(n => n.enabled === false), 'auto blacklist words should default to disabled');
  skillResponse = 'SKILL\nUse short descriptive tags.\n\nENFORCE\nAlways adapt to model style.\n\nBLACKLIST\nbad-word, another-word';
});

test('preserves per-word enabled state across blacklist refreshes', async () => {
  seedModel('blacklist-preserve', 8, 2); // ≥10 sessions for first auto-refresh
  skillResponse = 'SKILL\nSome skill.\n\nBLACKLIST\nfoo, bar';
  await refreshSkill('blacklist-preserve', 'BlacklistPreserve', 'sd15');

  // Enable 'foo' but leave 'bar' disabled
  const data = skills.get('blacklist-preserve');
  const fooNote = data.notes.find(n => n.type === 'blacklist' && n.words?.[0] === 'foo');
  fooNote.enabled = true;
  skills.saveNotes('blacklist-preserve', data.notes);

  // Second refresh: new active version has 0 sessions, use correction note to force it
  skillResponse = 'SKILL\nSome skill.\n\nBLACKLIST\nfoo, bar, baz';
  await refreshSkill('blacklist-preserve', 'BlacklistPreserve', 'sd15', 'keep same blacklist words');
  const updated = skills.get('blacklist-preserve');
  const blNotes = updated.notes.filter(n => n.type === 'blacklist');
  const foo = blNotes.find(n => n.words?.[0] === 'foo');
  const bar = blNotes.find(n => n.words?.[0] === 'bar');
  const baz = blNotes.find(n => n.words?.[0] === 'baz');
  assert.ok(foo, 'foo should still exist');
  assert.equal(foo.enabled, true, 'foo enabled state should be preserved');
  assert.ok(bar, 'bar should still exist');
  assert.equal(bar.enabled, false, 'bar should still be disabled');
  assert.ok(baz, 'new word baz should be added');
  skillResponse = 'SKILL\nUse short descriptive tags.\n\nENFORCE\nAlways adapt to model style.\n\nBLACKLIST\nbad-word, another-word';
});

test('preserves enabled state of existing auto notes across refreshes', async () => {
  seedModel('preserve-enabled', 8, 2); // ≥10 sessions for first auto-refresh
  // First refresh — creates auto enforce note (disabled)
  skillResponse = 'SKILL\nSome skill.\n\nENFORCE\nDo something specific.';
  await refreshSkill('preserve-enabled', 'PreserveEnabled', 'sd15');

  // Manually enable the auto note
  const data = skills.get('preserve-enabled');
  const note = data.notes.find(n => n.type === 'enforce' && n.auto);
  note.enabled = true;
  skills.saveNotes('preserve-enabled', data.notes);

  // Second refresh: new active version has 0 sessions, use correction note to force it
  await refreshSkill('preserve-enabled', 'PreserveEnabled', 'sd15', 'same enforce rules apply');
  const updated = skills.get('preserve-enabled');
  const updatedNote = updated.notes.find(n => n.type === 'enforce' && n.auto && n.text === 'Do something specific.');
  assert.ok(updatedNote, 'auto note should still exist');
  assert.equal(updatedNote.enabled, true, 'enabled state should be preserved');
  skillResponse = 'SKILL\nUse short descriptive tags.\n\nENFORCE\nAlways adapt to model style.\n\nBLACKLIST\nbad-word, another-word';
});

test('user-created notes are not overwritten by refresh', async () => {
  seedModel('user-notes', 8, 2); // ≥10 sessions so refresh actually runs
  // Add a user note directly
  const data = skills.get('user-notes');
  const userId = 'user-note-id';
  data.notes = [{ id: userId, type: 'enforce', text: 'My manual rule', enabled: true, auto: false }];
  skills.saveNotes('user-notes', data.notes);

  skillResponse = 'SKILL\nSome skill.\n\nENFORCE\nAuto-generated rule.';
  await refreshSkill('user-notes', 'UserNotes', 'sd15');

  const updated = skills.get('user-notes');
  const userNote = updated.notes.find(n => n.id === userId);
  assert.ok(userNote, 'user note should still exist');
  assert.equal(userNote.text, 'My manual rule');
  skillResponse = 'SKILL\nUse short descriptive tags.\n\nENFORCE\nAlways adapt to model style.\n\nBLACKLIST\nbad-word, another-word';
});
