'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { TINY_PNG, makeFakeOllama, makeVideoFakeComfyUI, collectSSE } = require('../support/fakeServers');

let appPort, ollamaServer, comfyServer, appServer, tmpDir, projectsDir;
const base = () => `http://127.0.0.1:${appPort}`;

async function api(method, url, body) {
  const res = await fetch(`${base()}${url}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

// Stub ffmpeg/ffprobe: `-version` prints a version line; any other ffmpeg call
// writes a small file to its last argument; ffprobe prints fixed stream facts.
function writeStubs(dir) {
  const ffmpeg = path.join(dir, 'ffmpeg');
  fs.writeFileSync(ffmpeg, `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffmpeg version 7.0-stub Copyright"; exit 0; fi
for last; do :; done
printf 'stub-media' > "$last"
`);
  const ffprobe = path.join(dir, 'ffprobe');
  fs.writeFileSync(ffprobe, `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffprobe version 7.0-stub"; exit 0; fi
echo '{"streams":[{"codec_type":"video","codec_name":"h264","width":1344,"height":768,"avg_frame_rate":"24/1","duration":"5.166667","nb_frames":"124"},{"codec_type":"audio","codec_name":"aac","sample_rate":"48000"}],"format":{"duration":"5.166667"}}'
`);
  fs.chmodSync(ffmpeg, 0o755); fs.chmodSync(ffprobe, 0o755);
  return { ffmpeg, ffprobe };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-film-test-'));
  projectsDir = path.join(tmpDir, 'projects');
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');
  process.env.PROJECTS_DIR = projectsDir;
  const stubs = writeStubs(tmpDir);
  process.env.FFMPEG_PATH  = stubs.ffmpeg;
  process.env.FFPROBE_PATH = stubs.ffprobe;

  ollamaServer = makeFakeOllama(() => 'ACCEPT');
  comfyServer  = makeVideoFakeComfyUI({ progressDelayMs: 60, withImages: true });
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'skills'),   { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:  `http://127.0.0.1:${ollamaServer.address().port}/v1`,
    comfyuiUrl:  `http://127.0.0.1:${comfyServer.address().port}`,
    llmModel:    'test-model',
    llmUnloadEnabled: true,
    llmUnloadUrl: `http://127.0.0.1:${ollamaServer.address().port}/unload`,
    llmUnloadMethod: 'GET',
    llmProvider: 'openai',
    activeWorkflow: null,
    models: {
      h3:  { id: 'h3', label: 'H3', architecture: 'minimaxh3',
             unetName: 'fl2va.safetensors', refUnetName: 'ref2va.safetensors', clipName: 'clip.safetensors',
             vaeName: 'vae.safetensors', audioVaeName: 'audio_vae.safetensors' },
      h3noaudio: { id: 'h3noaudio', label: 'H3 no audio', architecture: 'minimaxh3',
             unetName: 'fl2va.safetensors', refUnetName: 'ref2va.safetensors', clipName: 'clip.safetensors', vaeName: 'vae.safetensors' },
      wan: { id: 'wan', label: 'Wan', architecture: 'wanvideo', unetName: 'w', clipName: 'c', vaeName: 'v' },
      anima: { id: 'anima', label: 'Anima', architecture: 'anima', unetName: 'anima.safetensors', clipName: 'qwen.safetensors', vaeName: 'vae.safetensors' },
    },
    workflows: {},
  }));

  Object.keys(require.cache).forEach(k => { delete require.cache[k]; });
  const { server } = require('../../server');
  appServer = server;
  await new Promise(r => appServer.listen(0, r));
  appPort = appServer.address().port;
});

after(async () => {
  await Promise.all([
    new Promise(r => appServer.close(r)),
    new Promise(r => ollamaServer.close(r)),
    new Promise(r => comfyServer.close(r)),
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const nodesOf = (graph, type) => Object.values(graph).filter(n => n.class_type === type);
const b64png  = TINY_PNG.toString('base64');

test('film: cut → approve → continue → export, end to end', async () => {
  const caps = await api('GET', '/api/projects/capabilities');
  assert.equal(caps.json.ffmpeg.available, true);
  assert.equal(caps.json.ffmpeg.version, '7.0-stub');

  const created = await api('POST', '/api/projects', { title: 'Flood', modelId: 'h3', logline: 'A courier crosses a flooded city.' });
  assert.equal(created.status, 201);
  const pid = created.json.id;
  assert.deepEqual(created.json.format, { width: 1344, height: 768, fps: 24 });
  assert.equal((await api('GET', '/api/projects')).json.projects[0].id, pid);

  // Reference bank: a pinned character with one uploaded image
  const refRes = await api('POST', `/api/projects/${pid}/refs`, {
    kind: 'character', name: 'Mira', description: 'red scarf', pinned: true,
    media: [{ type: 'image', source: { type: 'upload' }, name: 'mira.png', data: `data:image/png;base64,${b64png}` }],
  });
  assert.equal(refRes.status, 201);
  const ref = refRes.json.ref;
  assert.equal(ref.media.length, 1);
  assert.ok(fs.existsSync(path.join(projectsDir, pid, ref.media[0].file)), 'ref image stored under the project');

  // Segment 1 defaults to a cut and picks up the pinned ref
  const segRes = await api('POST', `/api/projects/${pid}/segments`, {});
  assert.equal(segRes.status, 201);
  const s1 = segRes.json.segment;
  assert.equal(s1.start.mode, 'cut');
  assert.deepEqual(s1.refIds, [ref.id]);
  assert.equal(s1.frames, 124);

  // Prompt preview streams and does not upload or generate
  const uploadsBefore = comfyServer.uploads.length;
  const preview = await collectSSE(`${base()}/api/projects/${pid}/segments/${s1.id}/prompt`, { intent: 'Mira wades in' });
  assert.ok(preview.find(e => e.event === 'token'));
  assert.ok(preview.find(e => e.event === 'done')?.data.prompt.includes('landscape'));
  assert.equal(comfyServer.uploads.length, uploadsBefore, 'preview uploads nothing');
  assert.equal(comfyServer.prompts.length, 0, 'preview generates nothing');

  // The written prompt is stored on the segment; an edited draft is what run uses
  assert.equal((await api('GET', `/api/projects/${pid}`)).json.segments[0].promptDraft, 'a detailed landscape with mountains, high quality, sharp focus', 'preview stored the draft');
  await api('PUT', `/api/projects/${pid}/segments/${s1.id}`, { promptDraft: 'edited draft prompt' });
  const evD = await collectSSE(`${base()}/api/projects/${pid}/segments/${s1.id}/run`, {});
  assert.equal(evD.find(e => e.event === 'done').data.take.prompt, 'edited draft prompt', 'stored draft used verbatim');
  assert.ok(!evD.find(e => e.event === 'token'), 'no LLM rewrite while a draft exists');
  await api('PUT', `/api/projects/${pid}/segments/${s1.id}`, { promptDraft: '' });

  // Run take 1
  const unloadsBefore = ollamaServer.unloads;
  const ev1 = await collectSSE(`${base()}/api/projects/${pid}/segments/${s1.id}/run`, { intent: 'Mira wades into the water' });
  const names = ev1.map(e => e.event);
  for (const n of ['take_start', 'phase', 'token', 'prompt', 'progress', 'video', 'take_complete', 'done']) assert.ok(names.includes(n), `event ${n} in ${names}`);
  assert.deepEqual(ev1.filter(e => e.event === 'phase').map(e => e.data.phase), ['prompt_building', 'generating', 'saving']);
  const take1 = ev1.find(e => e.event === 'done').data.take;
  assert.equal(ollamaServer.unloads, unloadsBefore + 1, 'the LLM server was asked to release its GPU before the video job');
  assert.equal(take1.startMode, 'cut');
  assert.equal(take1.checkpoint, 'ref2va');
  assert.equal(typeof take1.seed, 'number');
  assert.equal(take1.durationSec, 5.166667);
  assert.equal(take1.silent, false);
  assert.match(take1.videoUrl, new RegExp(`^/api/projects/${pid}/media/clips/seg1-`));
  assert.ok(fs.existsSync(path.join(projectsDir, pid, take1.localFile)), 'clip downloaded');
  assert.ok(fs.existsSync(path.join(projectsDir, pid, take1.lastFrame)), 'last frame extracted');

  const g1 = comfyServer.prompts[1].prompt;
  const r2v = nodesOf(g1, 'MiniMaxH3ReferenceToVideo');
  assert.equal(r2v.length, 1, 'cut runs on the reference node');
  assert.ok(r2v[0].inputs.audio_vae, 'audio_vae wired');
  assert.ok(r2v[0].inputs['ref_images.ref_image_0']);
  assert.equal(r2v[0].inputs.width, 1344);
  assert.equal(r2v[0].inputs.length, 124);
  assert.equal(nodesOf(g1, 'UNETLoader')[0].inputs.unet_name, 'ref2va.safetensors');
  assert.ok(comfyServer.uploads.some(u => /-pic0\.png$/.test(u.filename)), 'reference image uploaded to ComfyUI');
  // the prompt writer saw the film context + picture tag guidance
  const promptReq = ollamaServer.requests.find(r => JSON.stringify(r).includes('FILM CONTEXT'));
  assert.ok(promptReq, 'film context in the LLM request');
  assert.ok(JSON.stringify(promptReq).includes('<Picture 1> Mira (character): red scarf'));

  // Approve → beat + next draft segment in continue mode
  const v = await api('POST', `/api/projects/${pid}/segments/${s1.id}/takes/${take1.id}/verdict`, { verdict: 'approved', note: 'keep' });
  assert.equal(v.status, 200);
  assert.equal(v.json.project.segments[0].status, 'approved');
  assert.equal(v.json.project.segments[0].approvedTakeId, take1.id);
  assert.ok(v.json.beat.length > 0);
  assert.equal(v.json.project.script[0].segmentId, s1.id);
  const s2 = v.json.nextSegment;
  assert.ok(s2, 'a fresh segment follows an approval');
  assert.equal(s2.start.mode, 'continue');

  // A second take on segment 1 after a rejection: the note and the rejected take's
  // last frame reach the prompt writer, and the segment's LoRAs reach the graph
  await api('POST', `/api/projects/${pid}/segments/${s1.id}/takes/${take1.id}/verdict`, { verdict: 'rejected', note: 'she never turned around' });
  await api('PUT', `/api/projects/${pid}/segments/${s1.id}`, { loras: [{ name: 'scene_rain.safetensors', weight: 0.6 }, { name: '  ', weight: 1 }] });
  const llmBefore = ollamaServer.requests.length;
  const evR = await collectSSE(`${base()}/api/projects/${pid}/segments/${s1.id}/run`, {});
  const takeR = evR.find(e => e.event === 'done').data.take;
  const reqR = ollamaServer.requests[llmBefore];
  const reqText = JSON.stringify(reqR);
  assert.ok(reqText.includes('PREVIOUS ATTEMPTS'), 'attempts context present');
  assert.ok(reqText.includes('REJECTED; the director said: \\"she never turned around\\"'), `rejection note in the request: ${reqText.slice(0, 200)}`);
  assert.ok(reqText.includes('last frame of the REJECTED take'), 'rejected take last frame shown to the writer');
  const graphR = comfyServer.prompts.at(-1).prompt;
  const loraNodes = Object.values(graphR).filter(n => n.class_type === 'LoraLoaderModelOnly');
  assert.deepEqual(loraNodes.map(n => [n.inputs.lora_name, n.inputs.strength_model]), [['scene_rain.safetensors', 0.6]]);
  assert.deepEqual(takeR.loras, [{ name: 'scene_rain.safetensors', weight: 0.6 }], 'take records its LoRAs');
  await api('PUT', `/api/projects/${pid}/segments/${s1.id}`, { loras: [] });
  await api('POST', `/api/projects/${pid}/segments/${s1.id}/takes/${take1.id}/verdict`, { verdict: 'approved', note: 'keep' });

  // Run segment 2 with a user-supplied prompt (no LLM call)
  const llmCalls = ollamaServer.requests.length;
  const ev2 = await collectSSE(`${base()}/api/projects/${pid}/segments/${s2.id}/run`, { prompt: 'she turns toward the bridge', seed: 99 });
  const take2 = ev2.find(e => e.event === 'done').data.take;
  assert.equal(take2.prompt, 'she turns toward the bridge');
  assert.equal(take2.seed, 99);
  assert.equal(take2.startMode, 'continue');
  assert.equal(take2.checkpoint, 'fl2va');
  assert.equal(take2.inputs.firstFrame, take1.lastFrame);
  assert.ok(!ev2.find(e => e.event === 'token'), 'no prompt building with a supplied prompt');
  const g2 = comfyServer.prompts.at(-1).prompt;
  const i2v = nodesOf(g2, 'MiniMaxH3ImageToVideo');
  assert.equal(i2v.length, 1);
  assert.ok(i2v[0].inputs.first_frame, 'continues from the last frame');
  assert.equal(i2v[0].inputs.last_frame, undefined);
  assert.equal(nodesOf(g2, 'UNETLoader')[0].inputs.unet_name, 'fl2va.safetensors');
  assert.ok(comfyServer.uploads.some(u => /-start\.png$/.test(u.filename)), 'last frame re-uploaded as the start frame');
  assert.ok(ollamaServer.requests.length >= llmCalls, 'beat summary may call the LLM, prompt did not');

  // Capture a frame and an audio range from take 2 into the bank
  const cap = await api('POST', `/api/projects/${pid}/takes/${take2.id}/capture`, { newRef: { kind: 'location', name: 'Bridge', description: 'iron bridge' }, frame: 2.5 });
  assert.equal(cap.status, 201);
  assert.equal(cap.json.media.type, 'image');
  assert.deepEqual(cap.json.media.source, { type: 'clip-frame', takeId: take2.id, t: 2.5 });
  const capA = await api('POST', `/api/projects/${pid}/takes/${take2.id}/capture`, { refId: ref.id, audio: [1, 3.5] });
  assert.equal(capA.status, 201);
  assert.equal(capA.json.media.type, 'audio');
  assert.match(capA.json.media.file, /\.wav$/);
  assert.equal(capA.json.project.refs.find(r => r.id === ref.id).media.length, 2);

  // Approve take 2 → export both
  await api('POST', `/api/projects/${pid}/segments/${s2.id}/takes/${take2.id}/verdict`, { verdict: 'approved' });
  const exp = await api('POST', `/api/projects/${pid}/export`);
  assert.equal(exp.status, 200, exp.text);
  assert.equal(exp.json.clips, 2);
  assert.equal(exp.json.url, `/api/projects/${pid}/media/export/export.mp4`);
  assert.ok(fs.existsSync(path.join(projectsDir, pid, 'export/export.mp4')));
  const media = await fetch(`${base()}${exp.json.url}`);
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-type'), /video\/mp4/);
  assert.equal(await media.text(), 'stub-media');
  assert.equal((await api('GET', `/api/projects/${pid}/media/../../${pid}.json`)).status, 404, 'traversal never reaches the JSON');
  assert.equal((await api('GET', `/api/projects/${pid}/media/clips/nope.mp4`)).status, 404);

  // Re-approving another take on segment 1 stales segment 2
  const ev3 = await collectSSE(`${base()}/api/projects/${pid}/segments/${s1.id}/run`, { prompt: 'alt take' });
  const take1b = ev3.find(e => e.event === 'done').data.take;
  const v2 = await api('POST', `/api/projects/${pid}/segments/${s1.id}/takes/${take1b.id}/verdict`, { verdict: 'approved' });
  assert.deepEqual(v2.json.staled, [s2.id]);
  assert.equal(v2.json.project.segments[1].status, 'stale');
  assert.equal(v2.json.nextSegment, null, 'no new segment when one already follows');
  const exp2 = await api('POST', `/api/projects/${pid}/export`);
  assert.equal(exp2.json.clips, 1, 'stale segments are left out of the export');

  // Model locked now that takes are approved; the format can still be reframed
  assert.equal((await api('PUT', `/api/projects/${pid}`, { modelId: 'h3noaudio' })).status, 409);
  assert.equal((await api('PUT', `/api/projects/${pid}`, { format: { width: 992 } })).status, 200);
  assert.equal((await api('PUT', `/api/projects/${pid}`, { format: { width: 1344 }, title: 'Flood 2', gen: { steps: 8 } })).status, 200);

  const loaded = await api('GET', `/api/projects/${pid}`);
  assert.equal(loaded.json.title, 'Flood 2');
  assert.equal(loaded.json.gen.steps, 8);
  assert.equal(loaded.json.running, null);
});

test('film: validation — model eligibility, nothing to continue from, bridge, missing audio VAE', async () => {
  assert.equal((await api('POST', '/api/projects', { title: 'x', modelId: 'wan' })).status, 400);
  assert.match((await api('POST', '/api/projects', { title: 'x', modelId: 'wan' })).json.error, /cannot drive a Film project/);

  const p = (await api('POST', '/api/projects', { title: 'Empty', modelId: 'h3' })).json;
  const s = (await api('POST', `/api/projects/${p.id}/segments`, {})).json.segment;
  const cont = await api('POST', `/api/projects/${p.id}/segments/${s.id}/run`, { start: { mode: 'continue' }, prompt: 'x' });
  assert.equal(cont.status, 400);
  assert.match(cont.json.error, /nothing to continue from/);
  const bridge = await api('POST', `/api/projects/${p.id}/segments/${s.id}/run`, { start: { mode: 'bridge' }, prompt: 'x' });
  assert.equal(bridge.status, 400);
  assert.match(bridge.json.error, /bridge mode is not available yet/);
  assert.equal((await api('PUT', `/api/projects/${p.id}/segments/${s.id}`, { start: { mode: 'sideways' } })).status, 400);
  assert.equal((await api('POST', `/api/projects/${p.id}/export`)).status, 400, 'nothing approved');

  // A cut with references needs the audio VAE on the model
  const q = (await api('POST', '/api/projects', { title: 'NoAudio', modelId: 'h3noaudio' })).json;
  const ref = (await api('POST', `/api/projects/${q.id}/refs`, { kind: 'character', name: 'A', media: [{ type: 'image', source: { type: 'upload' }, name: 'a.png', data: b64png }] })).json.ref;
  const qs = (await api('POST', `/api/projects/${q.id}/segments`, {})).json.segment;
  const run = await api('POST', `/api/projects/${q.id}/segments/${qs.id}/run`, { refIds: [ref.id], prompt: 'x' });
  assert.equal(run.status, 400);
  assert.match(run.json.error, /Audio VAE file/);
});

test('film: a running take blocks mutations and can be killed without leaving a take or files', async () => {
  const p = (await api('POST', '/api/projects', { title: 'Kill', modelId: 'h3' })).json;
  const s = (await api('POST', `/api/projects/${p.id}/segments`, {})).json.segment;
  const clipsDir = path.join(projectsDir, p.id, 'clips');

  const running = collectSSE(`${base()}/api/projects/${p.id}/segments/${s.id}/run`, { prompt: 'slow take' });
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await api('PUT', `/api/projects/${p.id}`, { title: 'nope' })).status, 409);
  assert.equal((await api('POST', `/api/projects/${p.id}/segments`, {})).status, 409);
  const mid = await api('GET', `/api/projects/${p.id}`);
  assert.equal(mid.json.running?.segmentId, s.id);
  assert.equal(mid.json.segments[0].status, 'running');

  const killed = await api('POST', `/api/projects/${p.id}/kill`);
  assert.equal(killed.status, 200);
  const events = await running;
  assert.ok(events.find(e => e.event === 'stopped'), `stopped event in ${events.map(e => e.event)}`);
  assert.ok(!events.find(e => e.event === 'done'));

  const after = (await api('GET', `/api/projects/${p.id}`)).json;
  assert.equal(after.segments[0].takes.length, 0, 'no take recorded');
  assert.equal(after.segments[0].status, 'draft');
  assert.equal(after.running, null);
  const orphans = fs.existsSync(clipsDir) ? fs.readdirSync(clipsDir) : [];
  assert.deepEqual(orphans, [], 'no orphan clip files');
  assert.equal((await api('POST', `/api/projects/${p.id}/kill`)).status, 404);
});

test('film: generate a still with an image model into the bank and as a segment start frame', async () => {
  const p = (await api('POST', '/api/projects', { title: 'Stills', modelId: 'h3' })).json;
  const s = (await api('POST', `/api/projects/${p.id}/segments`, {})).json.segment;
  assert.equal(s.start.mode, 'cut');

  assert.equal((await api('POST', `/api/projects/${p.id}/images/generate`, { modelId: 'h3', prompt: 'x' })).status, 200, 'SSE opens…');
  const bad = await collectSSE(`${base()}/api/projects/${p.id}/images/generate`, { modelId: 'h3', prompt: 'x' });
  assert.match(bad.find(e => e.event === 'error').data.message, /video model/);
  assert.equal((await api('POST', `/api/projects/${p.id}/images/generate`, { modelId: 'nope', prompt: 'x' })).status, 400);
  assert.equal((await api('POST', `/api/projects/${p.id}/images/generate`, { modelId: 'anima', prompt: '  ' })).status, 400);

  // Prompt writer: the description becomes an arch-specific prompt with the film context
  assert.equal((await api('POST', `/api/projects/${p.id}/images/prompt`, { modelId: 'anima', intent: '' })).status, 400);
  const llmBefore = ollamaServer.requests.length;
  const pw = await collectSSE(`${base()}/api/projects/${p.id}/images/prompt`, { modelId: 'anima', intent: 'goblin girl in a rainy diner', steering: 'low angle', segmentId: s.id });
  assert.ok(pw.find(e => e.event === 'token'));
  assert.equal(pw.find(e => e.event === 'done').data.prompt, 'a detailed landscape with mountains, high quality, sharp focus');
  const req = JSON.stringify(ollamaServer.requests[llmBefore]);
  assert.ok(req.includes('image generation prompts for ANIMA'), 'arch-specific image prompt guidance');
  assert.ok(req.includes('FILM CONTEXT'), 'film context attached');
  assert.ok(req.includes('first frame of segment 1'), 'purpose names the segment');
  assert.ok(req.includes('low angle'), 'director notes appended');

  const promptsBefore = comfyServer.prompts.length;
  const ev = await collectSSE(`${base()}/api/projects/${p.id}/images/generate`, {
    modelId: 'anima', prompt: '1girl, red scarf, rainy diner at night', intent: 'goblin girl in a rainy diner', seed: 5,
    newRef: { kind: 'scene', name: 'Diner night', description: 'neon diner in rain' }, segmentId: s.id,
  });
  const names = ev.map(e => e.event);
  for (const n of ['image_start', 'phase', 'progress', 'image', 'done']) assert.ok(names.includes(n), `${n} in ${names}`);
  const done = ev.find(e => e.event === 'done').data;
  assert.equal(done.ref.kind, 'scene');
  assert.equal(done.ref.name, 'Diner night');
  assert.equal(done.media.type, 'image');
  assert.equal(done.media.source.type, 'generate');
  assert.equal(done.media.source.modelId, 'anima');
  assert.equal(done.media.source.intent, 'goblin girl in a rainy diner');
  assert.equal(done.seed, 5);
  assert.ok(fs.existsSync(path.join(projectsDir, p.id, done.media.file)), 'still stored in the bank');

  const graph = comfyServer.prompts[promptsBefore].prompt;
  const types = Object.values(graph).map(n => n.class_type);
  assert.ok(!types.includes('MiniMaxH3ImageToVideo'), 'image graph, not a video graph');
  const enc = Object.values(graph).find(n => n.class_type === 'CLIPTextEncode' && n.inputs.text?.includes('red scarf'));
  assert.ok(enc, 'prompt reached the image graph');
  const latent = Object.values(graph).find(n => n.inputs?.width && n.inputs?.height && n.inputs?.batch_size);
  assert.ok(latent, 'empty latent present');
  assert.ok(latent.inputs.width > latent.inputs.height, `size follows the film's 1344×768 aspect: ${latent.inputs.width}×${latent.inputs.height}`);

  const seg = done.project.segments[0];
  assert.equal(seg.start.mode, 'continue', 'segment switched to continue');
  assert.deepEqual(seg.start.startImage, { refId: done.ref.id, mediaId: done.media.id });

  // The chosen still is the first frame of the take
  const run = await collectSSE(`${base()}/api/projects/${p.id}/segments/${s.id}/run`, { prompt: 'she looks up' });
  const take = run.find(e => e.event === 'done').data.take;
  assert.equal(take.startMode, 'continue');
  assert.equal(take.inputs.firstFrame, done.media.file);
});
