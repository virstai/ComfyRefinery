'use strict';

// GET /api/system/info against a fake ComfyUI, and file → architecture tags.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let appPort, appServer, comfyServer, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-system-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.FFMPEG_PATH  = '/nonexistent/ffmpeg';
  process.env.FFPROBE_PATH = '/nonexistent/ffprobe';
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  comfyServer = http.createServer((req, res) => {
    const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/system_stats') return json({ system: { os: 'linux', comfyui_version: '0.34.0', pytorch_version: '2.13', python_version: '3.14.4 (main)', ram_total: 8, ram_free: 4, argv: ['main.py', '--listen'], comfy_package_versions: [] },
      devices: [{ name: 'cuda:0 Fake GPU : native', type: 'cuda', index: 0, vram_total: 100, vram_free: 50 }] });
    if (req.url === '/object_info') return json({ KSampler: { python_module: 'nodes' }, VAELoaderMultiGPU: { python_module: 'custom_nodes.ComfyUI-MultiGPU' }, Foo: { python_module: 'custom_nodes.some-pack' } });
    if (req.url === '/object_info/KSampler') return json({ KSampler: { input: { required: { sampler_name: [['euler', 'er_sde'], {}] } } } });
    if (req.url.startsWith('/object_info/')) { const n = req.url.split('/').pop(); return json(n === 'UNETLoaderMultiGPU' ? { UNETLoaderMultiGPU: { input: { required: {} } } } : {}); }
    if (req.url === '/api/models/refresh') return json({});
    res.writeHead(404); res.end();
  });
  await new Promise(r => comfyServer.listen(0, r));

  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl: 'http://127.0.0.1:1/v1', comfyuiUrl: `http://127.0.0.1:${comfyServer.address().port}`, llmModel: 'm', llmProvider: 'openai',
    models: {}, workflows: {},
  }));
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'skills'),   { recursive: true });
  Object.keys(require.cache).forEach(k => { delete require.cache[k]; });
  const { server } = require('../../server');
  appServer = server;
  await new Promise(r => appServer.listen(0, r));
  appPort = appServer.address().port;
});

after(async () => {
  await Promise.all([new Promise(r => appServer.close(r)), new Promise(r => comfyServer.close(r))]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR; delete process.env.SESSIONS_DIR; delete process.env.SKILLS_DIR;
});

const base = () => `http://127.0.0.1:${appPort}`;

test('system info reports ComfyUI, devices, packs, archs, files and an unreachable LLM', async () => {
  const res  = await fetch(`${base()}/api/system/info`);
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.comfyui.reachable, true);
  assert.equal(info.comfyui.version, '0.34.0');
  assert.equal(info.comfyui.python, '3.14.4');
  assert.deepEqual(info.comfyui.devices.map(d => d.id), ['cuda:0']);
  assert.equal(info.comfyui.multiGpu, true);
  assert.equal(info.llm.reachable, false);
  assert.ok(info.packs.find(p => p.id === 'res4lyf').installed, 'er_sde sampler present');
  assert.equal(info.packs.find(p => p.id === 'multigpu').installed, false, 'only one MultiGPU node in the fake index');
  assert.ok(info.archs.find(a => a.arch === 'sdxl').missingNodes.length > 0, 'fake ComfyUI lacks the sdxl nodes');
  assert.ok(info.installedPacks.find(p => p.name === 'some-pack'));
  assert.ok(Array.isArray(info.files.checkpoints));
  assert.ok(info.architectures.includes('anima'));
  assert.deepEqual(info.fileArchTags, {});
  assert.equal(info.tools.ffmpeg.available, false, 'FFMPEG_PATH points at nothing');
  assert.match(info.tools.ffmpeg.error, /ffmpeg not found/);
});

test('file tags persist, merge, clear, and validate', async () => {
  const put = body => fetch(`${base()}/api/system/file-tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let res = await put({ key: 'unets:anima.safetensors', archs: ['anima', 'anima'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { 'unets:anima.safetensors': ['anima'] });
  res = await put({ key: 'clips:t5.safetensors', archs: ['flux', 'sd3'] });
  const tags = await res.json();
  assert.deepEqual(tags['clips:t5.safetensors'], ['flux', 'sd3']);
  assert.deepEqual((await (await fetch(`${base()}/api/system/file-tags`)).json())['unets:anima.safetensors'], ['anima']);
  res = await put({ key: 'unets:anima.safetensors', archs: [] });
  assert.equal('unets:anima.safetensors' in await res.json(), false, 'empty list clears');
  assert.equal((await put({ key: 'nope', archs: ['anima'] })).status, 400);
  assert.equal((await put({ key: 'unets:x', archs: ['not-an-arch'] })).status, 400);
  const cfg = await (await fetch(`${base()}/api/sessions/config`)).json();
  assert.deepEqual(cfg.fileArchTags, { 'clips:t5.safetensors': ['flux', 'sd3'] }, 'tags ride along in the config the UI loads');
});
