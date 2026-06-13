'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI, collectSSE } = require('../support/fakeServers');

// 64×64 all-black PNG — what DWPose outputs when it detects no person.
const BLACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAA8G4wQAABiwCo9wAAAABJRU5ErkJggg==',
  'base64',
);

let appPort, ollamaServer, comfyServer, appServer, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-pose-empty-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => 'ACCEPT');
  // DWPreprocessor installed, but every fetched image is black — the
  // skeleton fetch sees an empty pose guide.
  comfyServer = makeFakeComfyUI({
    objectInfo: { DWPreprocessor: { input: { required: {} } } },
    viewImage:  BLACK_PNG,
  });
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:  `http://127.0.0.1:${ollamaServer.address().port}/v1`,
    comfyuiUrl:  `http://127.0.0.1:${comfyServer.address().port}`,
    llmModel:    'test-model',
    activeWorkflow: 'wf-pose-always',
    maxIterations: 1, humanReview: false, acceptanceGracePeriod: 0,
    loras: {},
    models: {
      'anima-base': { id: 'anima-base', label: 'Anima', architecture: 'anima', unetName: 'anima.safetensors', clipL: 'qwen.safetensors', vaeName: 'vae.safetensors', controlNetModel: 'anima_lllite_pose.safetensors' },
    },
    workflows: {
      'wf-pose-always': {
        id: 'wf-pose-always', label: 'Pose Always',
        steps: [{
          type: 'generate', modelId: 'anima-base', params: {},
          controlNet: { poseMode: 'always', strength: 0.8 },
          review: { maxIterations: 1 },
        }],
      },
    },
  }));

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
  for (const k of ['DATA_DIR', 'SESSIONS_DIR', 'SKILLS_DIR']) delete process.env[k];
});

const base = () => `http://127.0.0.1:${appPort}`;

test('empty (black) pose skeleton fails the step instead of silently continuing', async () => {
  comfyServer.prompts.length = 0;

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'an extreme close-up', workflowId: 'wf-pose-always' });

  const error = events.find(e => e.event === 'error');
  assert.ok(error, 'error event emitted');
  assert.match(error.data.message, /no person detected/i);

  assert.equal(comfyServer.prompts.length, 1, 'only the pose draft ran — main generation never started');
  assert.ok(!events.some(e => e.event === 'pose'), 'no pose event for a failed extraction');
  assert.ok(!events.some(e => e.event === 'done'), 'pipeline did not complete');
});
