'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

// getDevices / the MultiGPU probe / the queue-time guard, against a scripted fake.

async function withFake(opts, fn) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/system_stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ devices: opts.devices ?? [] }));
    }
    if (req.url === '/object_info/UNETLoaderMultiGPU') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(opts.multiGpu ? { UNETLoaderMultiGPU: { input: { required: {} } } } : {}));
    }
    if (req.url === '/prompt') {
      // Reject the queue call: reaching it proves the MultiGPU guard let the graph through.
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('queue rejected by fake');
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, r));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-comfyui-devices-'));
  const orig = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ comfyuiUrl: `http://127.0.0.1:${srv.address().port}` }));
  delete require.cache[require.resolve('../../src/services/config')];
  delete require.cache[require.resolve('../../src/services/comfyui')];
  const comfyui = require('../../src/services/comfyui');
  try { await fn(comfyui); }
  finally {
    if (orig === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = orig;
    await new Promise(r => srv.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const DEVS = [
  { name: 'cuda:0 AMD Radeon AI PRO R9700 : native', type: 'cuda', index: 0, vram_total: 32061259776, vram_free: 1 },
  { name: 'cuda:1 AMD Radeon AI PRO R9700 : native', type: 'cuda', index: 1, vram_total: 32061259776, vram_free: 2 },
];

test('getDevices maps ComfyUI system_stats devices to ids, clean names and VRAM', async () => {
  await withFake({ devices: DEVS }, async (comfyui) => {
    const devs = await comfyui.getDevices();
    assert.deepEqual(devs.map(d => d.id), ['cuda:0', 'cuda:1']);
    assert.equal(devs[0].name, 'AMD Radeon AI PRO R9700');
    assert.equal(devs[1].vramTotal, 32061259776);
  });
});

test('queuing a graph with MultiGPU nodes fails with a clear message when the pack is missing', async () => {
  await withFake({ multiGpu: false }, async (comfyui) => {
    const wf = { 1: { class_type: 'VAELoaderMultiGPU', inputs: { vae_name: 'v', device: 'cpu' } } };
    await assert.rejects(comfyui.generate(wf, null, null), /ComfyUI-MultiGPU is not installed/);
  });
});

test('queuing a native-only graph never probes for the pack', async () => {
  await withFake({ multiGpu: false }, async (comfyui) => {
    const wf = { 1: { class_type: 'VAELoader', inputs: { vae_name: 'v' } } };
    await assert.rejects(comfyui.generate(wf, null, null), /queue error 503/);
  });
});

test('a placed graph reaches the queue when the pack is present', async () => {
  await withFake({ multiGpu: true }, async (comfyui) => {
    const wf = { 1: { class_type: 'VAELoaderMultiGPU', inputs: { vae_name: 'v', device: 'cuda:1' } } };
    await assert.rejects(comfyui.generate(wf, null, null), /queue error 503/);
  });
});
