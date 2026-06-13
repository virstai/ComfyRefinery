'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const http     = require('http');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

// We test getOutputVideos by pointing comfyui at a real local HTTP server.
// comfyui reads its baseUrl from config, so we write a tmp config.json.

async function withFakeHistory(historyBody, fn) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/history/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(historyBody));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-comfyui-video-test-'));
  const origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    comfyuiUrl: `http://127.0.0.1:${port}`,
  }));

  // Force config reload
  delete require.cache[require.resolve('../../src/services/config')];
  delete require.cache[require.resolve('../../src/services/comfyui')];
  const comfyui = require('../../src/services/comfyui');

  try {
    await fn(comfyui);
  } finally {
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise(r => srv.close(r));
    delete require.cache[require.resolve('../../src/services/config')];
    delete require.cache[require.resolve('../../src/services/comfyui')];
  }
}

test('getOutputVideos finds gifs key (VHS WebP/GIF output)', async () => {
  const history = {
    'pid-001': {
      outputs: {
        '9': { gifs: [{ filename: 'clip.webp', subfolder: '', type: 'output', format: 'image/webp' }] },
      },
    },
  };
  await withFakeHistory(history, async (comfyui) => {
    const { videos } = await comfyui.getOutputVideos('pid-001');
    assert.equal(videos.length, 1);
    assert.equal(videos[0].filename, 'clip.webp');
  });
});

test('getOutputVideos finds videos key (VHS MP4 output)', async () => {
  const history = {
    'pid-002': {
      outputs: {
        '9': { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output', format: 'video/h264-mp4' }] },
      },
    },
  };
  await withFakeHistory(history, async (comfyui) => {
    const { videos } = await comfyui.getOutputVideos('pid-002');
    assert.equal(videos.length, 1);
    assert.equal(videos[0].filename, 'clip.mp4');
  });
});

test('getOutputVideos collects from both gifs and videos keys', async () => {
  const history = {
    'pid-003': {
      outputs: {
        '8': { gifs:   [{ filename: 'a.webp', subfolder: '', type: 'output' }] },
        '9': { videos: [{ filename: 'b.mp4',  subfolder: '', type: 'output' }] },
      },
    },
  };
  await withFakeHistory(history, async (comfyui) => {
    const { videos } = await comfyui.getOutputVideos('pid-003');
    assert.equal(videos.length, 2);
  });
});

test('getOutputVideos returns empty array when no video output nodes', async () => {
  const history = {
    'pid-004': {
      outputs: {
        '7': { images: [{ filename: 'img.png', subfolder: '', type: 'output' }] },
      },
    },
  };
  await withFakeHistory(history, async (comfyui) => {
    const { videos } = await comfyui.getOutputVideos('pid-004');
    assert.equal(videos.length, 0);
  });
});
