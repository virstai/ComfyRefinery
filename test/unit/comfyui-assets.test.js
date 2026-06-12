'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');

let server, port;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/object_info/LoraLoader') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        LoraLoader: { input: { required: { lora_name: [['a.safetensors', 'sub/b.safetensors'], {}] } } },
      }));
    }
    if (req.url === '/object_info/DWPreprocessor') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ DWPreprocessor: { input: { required: {} } } }));
    }
    if (req.url === '/object_info/NopeNode') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({}));
    }
    if (req.url.startsWith('/view_metadata/loras')) {
      const u = new URL(req.url, 'http://x');
      if (u.searchParams.get('filename') === 'a.safetensors') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ss_base_model_version: 'sdxl_base_v1-0' }));
      }
      res.writeHead(404); return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, r));
  port = server.address().port;
  process.env.COMFYUI_URL = `http://127.0.0.1:${port}`;
});

after(() => {
  delete process.env.COMFYUI_URL;
  return new Promise(r => server.close(r));
});

const comfyui = require('../../src/services/comfyui');

test('listLoras returns LoraLoader lora_name options', async () => {
  assert.deepEqual(await comfyui.listLoras(), ['a.safetensors', 'sub/b.safetensors']);
});

test('getLoraMetadata returns parsed metadata, null on 404', async () => {
  assert.deepEqual(await comfyui.getLoraMetadata('a.safetensors'), { ss_base_model_version: 'sdxl_base_v1-0' });
  assert.equal(await comfyui.getLoraMetadata('missing.safetensors'), null);
});

test('hasNode true for known node, false for unknown', async () => {
  assert.equal(await comfyui.hasNode('DWPreprocessor'), true);
  assert.equal(await comfyui.hasNode('NopeNode'), false);
});
