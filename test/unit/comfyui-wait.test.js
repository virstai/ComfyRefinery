'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { WebSocketServer } = require('ws');

// Exercises waitForCompletion (via comfyui.generate) against a scripted fake
// ComfyUI: abort handling, and the post-reconnect "does the server still know
// this job?" check that turns a ComfyUI restart into an error instead of a hang.

const PROMPT_ID = 'wait-test-prompt';

async function withFakeComfy(opts, fn) {
  const state = { connections: 0, queueBody: { queue_running: [], queue_pending: [] }, historyBody: {} };
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/prompt') {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: PROMPT_ID }));
      });
      return;
    }
    if (req.url === '/queue') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.queueBody));
    }
    if (req.url.startsWith('/history/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.historyBody));
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', ws => { state.connections++; opts.onConnection(ws, state); });
  await new Promise(r => httpServer.listen(0, r));
  const port = httpServer.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-comfyui-wait-test-'));
  const origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ comfyuiUrl: `http://127.0.0.1:${port}` }));
  delete require.cache[require.resolve('../../src/services/config')];
  delete require.cache[require.resolve('../../src/services/comfyui')];
  const comfyui = require('../../src/services/comfyui');

  try {
    await fn(comfyui, state);
  } finally {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise(r => httpServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('aborting the signal rejects the wait with "Stopped" instead of hanging', async () => {
  await withFakeComfy({ onConnection: () => { /* server never reports completion */ } }, async (comfyui) => {
    const ac = new AbortController();
    const p  = comfyui.generate({}, null, null, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, /Stopped/);
  });
});

test('after a WS drop, a job the server no longer knows about fails fast (ComfyUI restart)', async () => {
  await withFakeComfy({
    // First connection drops immediately (server "restarted"); the second one
    // stays silent — a restarted ComfyUI never reports on the lost prompt.
    onConnection: (ws, state) => { if (state.connections === 1) ws.close(); },
  }, async (comfyui) => {
    await assert.rejects(comfyui.generate({}, null, null), /lost the job/);
  });
});

test('after a WS drop, a job still in the queue keeps waiting and completes normally', async () => {
  await withFakeComfy({
    onConnection: (ws, state) => {
      if (state.connections === 1) return ws.close();
      setTimeout(() => ws.send(JSON.stringify({ type: 'executing', data: { prompt_id: PROMPT_ID, node: null } })), 100);
    },
  }, async (comfyui, state) => {
    state.queueBody  = { queue_running: [[0, PROMPT_ID, {}, {}, []]], queue_pending: [] };
    state.historyBody = { [PROMPT_ID]: { outputs: { '9': { images: [{ filename: 'ok.png', subfolder: '', type: 'output' }] } } } };
    const { images } = await comfyui.generate({}, null, null);
    assert.equal(images[0].filename, 'ok.png');
    assert.equal(state.connections, 2);
  });
});

test('generateVideo keeps a video written before a later node failed, with a warning', async () => {
  await withFakeComfy({
    onConnection: ws => setTimeout(() => ws.send(JSON.stringify({
      type: 'execution_error',
      data: { prompt_id: PROMPT_ID, node_type: 'SaveVideo', exception_message: "[aac] Input contains (near) NaN/+-Inf" },
    })), 50),
  }, async (comfyui, state) => {
    state.historyBody = { [PROMPT_ID]: { status: { status_str: 'error' }, outputs: {
      '12': { images: [{ filename: 'iterator_video_noaudio_00001_.mp4', subfolder: '', type: 'output' }] },
    } } };
    const { videos, warning } = await comfyui.generateVideo({}, null);
    assert.equal(videos.length, 1);
    assert.match(videos[0].filename, /_noaudio/);
    assert.match(warning, /SaveVideo.*NaN/);
  });
});

test('generateVideo still fails when nothing was written before the error', async () => {
  await withFakeComfy({
    onConnection: ws => setTimeout(() => ws.send(JSON.stringify({
      type: 'execution_error', data: { prompt_id: PROMPT_ID, node_type: 'KSampler', exception_message: 'OOM' },
    })), 50),
  }, async (comfyui) => {
    await assert.rejects(comfyui.generateVideo({}, null), /KSampler.*OOM/);
  });
});
