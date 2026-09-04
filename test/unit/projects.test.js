'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'film-projects-'));
  process.env.PROJECTS_DIR = tmp;
});
after(() => { delete process.env.PROJECTS_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

const projects = require('../../src/services/projects');

const CFG = {
  models: {
    h3:  { id: 'h3', label: 'H3', architecture: 'minimaxh3', unetName: 'fl.safetensors', clipName: 'c', vaeName: 'v' },
    wan: { id: 'wan', label: 'Wan', architecture: 'wanvideo', unetName: 'w', clipName: 'c', vaeName: 'v' },
    ltx: { id: 'ltx', label: 'LTX', architecture: 'ltxvideo', checkpoint: 'l.safetensors', clipName: 'g' },
  },
};

test('newProject seeds format/gen from the arch and refuses non-film models', () => {
  const p = projects.newProject({ title: '  Rain  ', modelId: 'h3' }, CFG);
  assert.equal(p.title, 'Rain');
  assert.deepEqual(p.format, { width: 1344, height: 768, fps: 24 });
  assert.equal(p.gen.frames, 124);
  assert.equal(p.gen.sampler, null, 'sampler left to the arch builder');
  assert.deepEqual(p.refs, []); assert.deepEqual(p.segments, []); assert.deepEqual(p.script, []);
  assert.throws(() => projects.newProject({ title: 'x', modelId: 'wan' }, CFG), /cannot drive a Film project/);
  assert.throws(() => projects.newProject({ title: 'x', modelId: 'nope' }, CFG), /not found/);
});

test('save / load / list / delete round-trip on disk', () => {
  const p = projects.newProject({ title: 'A', modelId: 'h3' }, CFG);
  projects.saveProject(p);
  assert.ok(fs.existsSync(path.join(tmp, `${p.id}.json`)));
  assert.equal(projects.loadProject(p.id).title, 'A');
  const list = projects.listProjects();
  assert.ok(list.find(x => x.id === p.id));
  assert.deepEqual(Object.keys(list[0]).sort(), ['approvedCount', 'createdAt', 'id', 'modelId', 'segmentCount', 'title', 'updatedAt']);
  fs.mkdirSync(projects.projectDir(p.id), { recursive: true });
  fs.writeFileSync(path.join(projects.projectDir(p.id), 'x.txt'), 'x');
  projects.deleteProject(p.id);
  assert.equal(projects.loadProject(p.id), null);
  assert.ok(!fs.existsSync(projects.projectDir(p.id)), 'media folder removed');
});

test('mediaPath refuses traversal; mediaUrl encodes segments', () => {
  const p = projects.newProject({ title: 'A', modelId: 'h3' }, CFG);
  assert.equal(projects.mediaPath(p.id, 'clips/a.mp4'), path.join(tmp, p.id, 'clips', 'a.mp4'));
  assert.throws(() => projects.mediaPath(p.id, '../other.json'), /invalid media path/);
  assert.throws(() => projects.mediaPath(p.id, '/etc/passwd'), /invalid media path/);
  assert.throws(() => projects.mediaPath(p.id, ''), /invalid media path/);
  assert.equal(projects.mediaUrl(p.id, 'clips/seg 1.mp4'), `/api/projects/${p.id}/media/clips/seg%201.mp4`);
});

test('segments: defaults, updates, and the first-segment cut rule', () => {
  const p = projects.newProject({ title: 'A', modelId: 'h3' }, CFG);
  const r = projects.addRef(p, { kind: 'character', name: 'Mira', pinned: true });
  projects.addRef(p, { kind: 'location', name: 'Diner' });
  const s1 = projects.addSegment(p);
  assert.equal(s1.index, 0);
  assert.equal(s1.start.mode, 'cut', 'no previous take → cut');
  assert.deepEqual(s1.refIds, [r.id], 'pinned refs pre-selected');
  assert.equal(s1.frames, 124);

  projects.updateSegment(p, s1.id, { intent: 'she leaves', frames: '130', seed: '7', refIds: [r.id, 'unknown'] });
  assert.equal(s1.intent, 'she leaves'); assert.equal(s1.frames, 130); assert.equal(s1.seed, 7);
  assert.deepEqual(s1.refIds, [r.id], 'unknown ids dropped');
  assert.throws(() => projects.updateSegment(p, s1.id, { start: { mode: 'sideways' } }), /start.mode/);
  assert.throws(() => projects.updateSegment(p, s1.id, { start: { startImage: { refId: r.id, mediaId: 'nope' } } }), /startImage/);

  const s2 = projects.addSegment(p);
  assert.equal(s2.start.mode, 'cut', 'still no approved take');
  const t = projects.addTake(p, s1.id, { prompt: 'p', localFile: 'clips/a.mp4', lastFrame: 'clips/a-last.png' });
  projects.setVerdict(p, s1.id, t.id, 'approved');
  const s3 = projects.addSegment(p);
  assert.equal(s3.start.mode, 'continue', 'a previous approved take → continue');
  assert.equal(projects.previousApprovedTake(p, s3.index).take.id, t.id);
  assert.equal(projects.previousApprovedTake(p, 0), null);

  assert.throws(() => projects.removeSegment(p, s1.id), /Only the last segment/);
  projects.removeSegment(p, s3.id);
  assert.equal(p.segments.length, 2);
});

test('verdicts: approve marks later segments with takes stale; reject clears approval', () => {
  const p = projects.newProject({ title: 'A', modelId: 'h3' }, CFG);
  const s1 = projects.addSegment(p), s2 = projects.addSegment(p), s3 = projects.addSegment(p);
  const t1a = projects.addTake(p, s1.id, { prompt: 'a' });
  const t1b = projects.addTake(p, s1.id, { prompt: 'b' });
  projects.addTake(p, s2.id, { prompt: 'c' });

  let r = projects.setVerdict(p, s1.id, t1a.id, 'approved', 'nice');
  assert.equal(s1.status, 'approved'); assert.equal(s1.approvedTakeId, t1a.id); assert.equal(t1a.note, 'nice');
  assert.deepEqual(r.staled, [s2.id], 'segment with takes goes stale; empty draft does not');
  assert.equal(s2.status, 'stale'); assert.equal(s3.status, 'draft');

  r = projects.setVerdict(p, s1.id, t1a.id, 'approved');
  assert.deepEqual(r.staled, [], 're-approving the same take stales nothing');

  r = projects.setVerdict(p, s1.id, t1b.id, 'approved');
  assert.equal(t1a.verdict, null, 'previous approved take loses its verdict');
  assert.deepEqual(r.staled, [], 'already-stale segment not reported twice');

  projects.setVerdict(p, s1.id, t1b.id, 'rejected');
  assert.equal(s1.approvedTakeId, null); assert.equal(s1.status, 'draft');
  assert.throws(() => projects.setVerdict(p, s1.id, t1b.id, 'meh'), /verdict/);
});

test('script beats stay in timeline order and refs strip cleanly', () => {
  const p = projects.newProject({ title: 'A', modelId: 'h3' }, CFG);
  const s1 = projects.addSegment(p), s2 = projects.addSegment(p);
  projects.setBeat(p, s2.id, 'second');
  projects.setBeat(p, s1.id, 'first');
  projects.setBeat(p, s1.id, 'first!');
  assert.deepEqual(p.script.map(b => b.beat), ['first!', 'second']);

  const ref = projects.addRef(p, { kind: 'voice', name: 'Mira voice' });
  fs.mkdirSync(path.join(projects.projectDir(p.id), 'refs'), { recursive: true });
  fs.writeFileSync(projects.mediaPath(p.id, 'refs/v.wav'), 'wav');
  const img = projects.addRef(p, { kind: 'character', name: 'Mira' });
  fs.writeFileSync(projects.mediaPath(p.id, 'refs/m.png'), 'png');
  const m = projects.addRefMedia(p, img.id, { type: 'image', file: 'refs/m.png', source: { type: 'upload' } });
  projects.addRefMedia(p, ref.id, { type: 'audio', file: 'refs/v.wav' });
  projects.updateSegment(p, s1.id, { refIds: [ref.id, img.id], start: { mode: 'continue', startImage: { refId: img.id, mediaId: m.id } } });
  assert.equal(s1.start.startImage.mediaId, m.id);

  projects.removeRef(p, ref.id);
  assert.deepEqual(s1.refIds, [img.id]);
  assert.ok(!fs.existsSync(projects.mediaPath(p.id, 'refs/v.wav')), 'media file deleted with the entry');
  projects.removeRefMedia(p, img.id, m.id);
  assert.equal(s1.start.startImage, null, 'start image cleared when its media goes');
  assert.throws(() => projects.addRef(p, { kind: 'pet', name: 'x' }), /kind/);
  assert.throws(() => projects.updateRef(p, img.id, { kind: 'pet' }), /kind/);
  projects.updateRef(p, img.id, { name: 'Mira K', pinned: true, description: 'red scarf' });
  assert.equal(img.pinned, true);
});

test('updateProject: format can always be reframed; the model locks once a take is approved', () => {
  const p = projects.newProject({ title: 'A', modelId: 'h3' }, CFG);
  projects.updateProject(p, { format: { width: 1000, height: 700 }, gen: { steps: '', frames: 90 } }, CFG);
  assert.deepEqual(p.format, { width: 992, height: 704, fps: 24 }, 'snapped to /32');
  assert.equal(p.gen.steps, null); assert.equal(p.gen.frames, 90);
  const s = projects.addSegment(p);
  const t = projects.addTake(p, s.id, { prompt: 'x' });
  projects.updateProject(p, { format: { width: 1344, height: 768 } }, CFG);   // takes exist, none approved → still free
  assert.deepEqual(p.format, { width: 1344, height: 768, fps: 24 });
  projects.updateProject(p, { modelId: 'h3' }, CFG);
  projects.setVerdict(p, s.id, t.id, 'approved');
  assert.throws(() => projects.updateProject(p, { modelId: 'h3b' }, CFG), /cannot change once a take is approved/);
  projects.updateProject(p, { format: { width: 992 }, title: 'B' }, CFG);    // reframing stays possible; export re-encodes
  assert.equal(p.format.width, 992);
  assert.equal(p.title, 'B');
});

test('resetRunning returns running segments to draft', () => {
  const p = projects.newProject({ title: 'A', modelId: 'h3' }, CFG);
  const s = projects.addSegment(p);
  s.status = 'running';
  assert.equal(projects.resetRunning(p), true);
  assert.equal(s.status, 'draft');
  assert.equal(projects.resetRunning(p), false);
});

test('ltxvideo projects: arch format/frames defaults, and new segments always continue (no cut mode)', () => {
  const p = projects.newProject({ title: 'LTX', modelId: 'ltx' }, CFG);
  assert.deepEqual(p.format, { width: 1024, height: 576, fps: 24 });
  assert.equal(p.gen.frames, 121);
  const s1 = projects.addSegment(p, {}, CFG);
  assert.equal(s1.start.mode, 'continue');
  // H3 keeps its cut default for a first segment
  const h = projects.newProject({ title: 'H3', modelId: 'h3' }, CFG);
  assert.equal(projects.addSegment(h, {}, CFG).start.mode, 'cut');
  assert.equal(projects.addSegment(h).start.mode, 'cut', 'without cfg the arch is unknown → cut stays the default');
  // format snaps to the /64 grid for ltxvideo
  projects.updateProject(p, { format: { width: 1000, height: 700 } }, CFG);
  assert.deepEqual(p.format, { width: 1024, height: 704, fps: 24 });
});
