'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let appPort;
let appServer;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-arch-test-'));

  const tmpArchDir = path.join(tmpDir, 'arch-docs');
  fs.mkdirSync(tmpArchDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpArchDir, 'sd15.md'),
    '# SD 1.5\n\nTest content for sd15.',
  );

  process.env.DATA_DIR      = tmpDir;
  process.env.SESSIONS_DIR  = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR    = path.join(tmpDir, 'skills');
  process.env.ARCH_DOCS_DIR = tmpArchDir;

  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:  'http://127.0.0.1:11434/v1',
    comfyuiUrl:  'http://127.0.0.1:8188',
    llmModel:    'test-model',
    llmProvider: 'openai',
    models:      {},
    workflows:   {},
  }));

  const { server } = require('../../server');
  appServer = server;
  await new Promise(r => appServer.listen(0, r));
  appPort = appServer.address().port;
});

after(async () => {
  await new Promise(r => appServer.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.SESSIONS_DIR;
  delete process.env.SKILLS_DIR;
  delete process.env.ARCH_DOCS_DIR;
});

test('GET /api/arch-help/sd15 returns markdown content as text/plain', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/arch-help/sd15`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('# SD 1.5'), 'should return markdown content');
  assert.ok(res.headers.get('content-type').includes('text/plain'));
});

test('GET /api/arch-help/nonexistent returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/arch-help/nonexistent`);
  assert.equal(res.status, 404);
});

test('GET /api/arch-help/ with encoded path separator returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/arch-help/..%2Fconfig`);
  assert.equal(res.status, 404);
});
