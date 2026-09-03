'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { buildFilmContext, buildAttemptsContext } = require('../../src/services/filmRunner');

const project = {
  id: 'p1', logline: 'A courier crosses a flooded city.',
  format: { width: 1344, height: 768, fps: 24 }, gen: { frames: 124 },
  refs: [
    { id: 'r1', kind: 'character', name: 'Mira', description: 'red scarf, short black hair' },
    { id: 'r2', kind: 'voice', name: 'Mira voice', description: '' },
    { id: 'r3', kind: 'location', name: 'Diner', description: 'neon, rain on glass' },
  ],
  segments: [{ id: 's1', index: 0 }, { id: 's2', index: 1, frames: 90 }, { id: 's3', index: 2 }],
  script: [{ segmentId: 's1', beat: 'Mira left the diner.' }, { segmentId: 's2', beat: 'Rain started.' }],
};

test('buildFilmContext: cut with references lists the tags in order', () => {
  const resolved = {
    mode: 'cut', isR2V: true,
    pictures: [{ ref: project.refs[0] }, { ref: project.refs[2] }],
    videos:   [{ label: 'the last 5.0s of segment 2, with its soundtrack' }],
    audios:   [{ ref: project.refs[1] }],
    otherImages: [],
  };
  const ctx = buildFilmContext(project, project.segments[2], resolved);
  assert.match(ctx, /Logline: A courier crosses a flooded city\./);
  assert.match(ctx, /Story so far:\n  1\. Mira left the diner\.\n  2\. Rain started\./);
  assert.match(ctx, /segment 3 of 3, about 5\.2s\. It is a new shot \(a cut\)/);
  assert.match(ctx, /<Picture 1> Mira \(character\): red scarf, short black hair/);
  assert.match(ctx, /<Picture 2> Diner \(location\): neon, rain on glass/);
  assert.match(ctx, /<Video 1> the last 5\.0s of segment 2, with its soundtrack/);
  assert.match(ctx, /<Audio 1> Mira voice \(voice\)$/m);
  assert.ok(!ctx.includes('not fed to the model'));
});

test('buildFilmContext: continue from the previous take explains the first frame; bank images are advisory', () => {
  const resolved = {
    mode: 'continue', isI2V: true,
    prevTake: { lastFrame: 'clips/seg1-x-last.png' }, inputs: { firstFrame: 'clips/seg1-x-last.png' },
    pictures: [], videos: [], audios: [],
    otherImages: [{ ref: project.refs[0] }],
  };
  const ctx = buildFilmContext(project, project.segments[1], resolved);
  assert.match(ctx, /segment 2 of 3, about 3\.8s\. It continues directly from the previous shot/);
  assert.match(ctx, /not fed to the model[^\n]*\n  Mira \(character\): red scarf/);
  assert.ok(!ctx.includes('<Picture'));

  const fromImage = buildFilmContext(project, project.segments[0], { ...resolved, prevTake: null, inputs: { firstFrame: 'refs/a.png' } });
  assert.match(fromImage, /starts from the given image as its first frame/);
});

test('buildFilmContext: omits empty logline and script', () => {
  const ctx = buildFilmContext({ ...project, logline: '', script: [] }, project.segments[0], { mode: 'cut', isR2V: false, pictures: [], videos: [], audios: [], otherImages: [] });
  assert.ok(!ctx.includes('Logline'));
  assert.ok(!ctx.includes('Story so far'));
  assert.match(ctx, /new shot with no visual references/);
});

test('buildAttemptsContext lists earlier takes with verdicts and notes, rejected notes first-class', () => {
  assert.equal(buildAttemptsContext({ takes: [] }), null);
  const seg = { takes: [
    { prompt: 'p1', verdict: 'rejected', note: 'she never turned around' },
    { prompt: 'p2', verdict: null, note: '' },
    { prompt: 'p3', verdict: 'approved', note: 'good but darker' },
  ] };
  const ctx = buildAttemptsContext(seg);
  assert.match(ctx, /PREVIOUS ATTEMPTS at this shot \(3 so far\)/);
  assert.match(ctx, /Take 1 — REJECTED; the director said: "she never turned around"\n    prompt used: p1/);
  assert.match(ctx, /Take 2 — undecided\n/);
  assert.match(ctx, /Take 3 — approved; the director said: "good but darker"/);
  assert.match(ctx, /rejection notes above are the priority/);
  const many = buildAttemptsContext({ takes: Array.from({ length: 6 }, (_, i) => ({ prompt: `p${i + 1}` })) });
  assert.ok(!many.includes('Take 1 —') && many.includes('Take 3 —') && many.includes('Take 6 —'), 'only the last four');
  assert.ok(!many.includes('priority'));
});
