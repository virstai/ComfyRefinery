'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build, defaults } = require('../../../src/workflows/minimaxh3');

const BASE = {
  unetName: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  clipName: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  vaeName:  'minimax_h3_video_vae_fp16.safetensors',
  positivePrompt: 'a river flowing through a canyon',
};

const R2V_BASE = {
  ...BASE,
  refUnetName:  'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  audioVaeName: 'minimax_h3_audio_vae_fp32.safetensors',
  isR2V: true,
  referenceRefs: [
    { filename: 'ref1.png', subfolder: '', type: 'input' },
    { filename: 'ref2.png', subfolder: 'sub', type: 'input' },
  ],
};

function nodeTypes(wf) {
  return Object.values(wf).map(n => n.class_type);
}
function findNode(wf, type) {
  return Object.values(wf).find(n => n.class_type === type);
}
function findNodes(wf, type) {
  return Object.values(wf).filter(n => n.class_type === type);
}

test('T2V graph has the expected node set', () => {
  const wf    = build(BASE);
  const types = nodeTypes(wf);
  for (const t of ['UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageToVideo',
                   'RandomNoise', 'KSamplerSelect', 'BasicScheduler', 'BasicGuider',
                   'SamplerCustomAdvanced', 'VAEDecode', 'CreateVideo', 'SaveVideo']) {
    assert.ok(types.includes(t), `missing ${t}`);
  }
});

test('T2V has no image-input or reference nodes', () => {
  const types = nodeTypes(build(BASE));
  assert.ok(!types.includes('LoadImage'));
  assert.ok(!types.includes('ImageScaleToTotalPixels'));
  assert.ok(!types.includes('MiniMaxH3ReferenceToVideo'));
});

test('CLIP loads with type minimax; UNet loads the FL2VA file', () => {
  const wf = build(BASE);
  assert.equal(findNode(wf, 'CLIPLoader').inputs.type, 'minimax');
  assert.equal(findNode(wf, 'CLIPLoader').inputs.clip_name, BASE.clipName);
  assert.equal(findNode(wf, 'UNETLoader').inputs.unet_name, BASE.unetName);
});

test('prompt is encoded by the MiniMax node, guidance-free sampling', () => {
  const wf = build(BASE);
  const h3 = findNode(wf, 'MiniMaxH3ImageToVideo');
  assert.equal(h3.inputs.prompt, BASE.positivePrompt);
  // No CLIPTextEncode / negative conditioning anywhere
  assert.ok(!nodeTypes(wf).includes('CLIPTextEncode'));
  const guider = findNode(wf, 'BasicGuider');
  assert.ok(guider.inputs.conditioning, 'guider takes the H3 positive conditioning');
  assert.equal(guider.inputs.negative, undefined);
});

test('defaults applied when params omitted', () => {
  const wf = build(BASE);
  const h3 = findNode(wf, 'MiniMaxH3ImageToVideo');
  assert.equal(h3.inputs.width,  defaults.width);
  assert.equal(h3.inputs.height, defaults.height);
  assert.equal(h3.inputs.length, defaults.frames); // 73 is already 17k+5
  assert.equal(findNode(wf, 'BasicScheduler').inputs.steps, defaults.steps);
  assert.equal(findNode(wf, 'KSamplerSelect').inputs.sampler_name, defaults.sampler);
  assert.equal(findNode(wf, 'CreateVideo').inputs.fps, defaults.fps);
});

test('frame count snaps up to the 17k+5 grid', () => {
  assert.equal(findNode(build({ ...BASE, frames: 73 }), 'MiniMaxH3ImageToVideo').inputs.length, 73);
  assert.equal(findNode(build({ ...BASE, frames: 74 }), 'MiniMaxH3ImageToVideo').inputs.length, 90);
  assert.equal(findNode(build({ ...BASE, frames: 1 }),  'MiniMaxH3ImageToVideo').inputs.length, 5);
  assert.equal(findNode(build({ ...BASE, frames: 124 }), 'MiniMaxH3ImageToVideo').inputs.length, 124);
});

test('I2V adds LoadImage → ImageScaleToTotalPixels wired to first_frame', () => {
  const wf = build({ ...BASE, isI2V: true, inputRef: { filename: 'start.png', subfolder: '', type: 'input' } });
  const load  = findNode(wf, 'LoadImage');
  const scale = findNode(wf, 'ImageScaleToTotalPixels');
  assert.equal(load.inputs.image, 'start.png');
  assert.equal(scale.inputs.megapixels, 0.9);
  const h3 = findNode(wf, 'MiniMaxH3ImageToVideo');
  assert.ok(h3.inputs.first_frame, 'first_frame connected');
});

test('T2V/I2V leaves first_frame unset without an input image', () => {
  const h3 = findNode(build(BASE), 'MiniMaxH3ImageToVideo');
  assert.equal(h3.inputs.first_frame, undefined);
});

test('audio nodes present only when audioVaeName is set', () => {
  const noAudio = build(BASE);
  assert.equal(findNodes(noAudio, 'VAELoader').length, 1);
  assert.ok(!nodeTypes(noAudio).includes('VAEDecodeAudio'));
  assert.equal(findNode(noAudio, 'CreateVideo').inputs.audio, undefined);

  const withAudio = build({ ...BASE, audioVaeName: 'minimax_h3_audio_vae_fp32.safetensors' });
  assert.equal(findNodes(withAudio, 'VAELoader').length, 2);
  assert.ok(nodeTypes(withAudio).includes('VAEDecodeAudio'));
  assert.ok(findNode(withAudio, 'CreateVideo').inputs.audio, 'audio wired into CreateVideo');
});

test('audio and video decode from the same sampled latent', () => {
  const wf = build({ ...BASE, audioVaeName: 'audio.safetensors' });
  const sampleId = Object.entries(wf).find(([, n]) => n.class_type === 'SamplerCustomAdvanced')[0];
  assert.deepEqual(findNode(wf, 'VAEDecode').inputs.samples,      [sampleId, 0]);
  assert.deepEqual(findNode(wf, 'VAEDecodeAudio').inputs.samples, [sampleId, 0]);
});

test('turbo LoRA loads via LoraLoaderModelOnly when set', () => {
  assert.ok(!nodeTypes(build(BASE)).includes('LoraLoaderModelOnly'));
  const wf   = build({ ...BASE, distilledLoraName: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' });
  const lora = findNode(wf, 'LoraLoaderModelOnly');
  assert.equal(lora.inputs.strength_model, 1.0);
  // Scheduler and guider both use the LoRA-patched model
  const loraId = Object.entries(wf).find(([, n]) => n.class_type === 'LoraLoaderModelOnly')[0];
  assert.deepEqual(findNode(wf, 'BasicScheduler').inputs.model, [loraId, 0]);
  assert.deepEqual(findNode(wf, 'BasicGuider').inputs.model,    [loraId, 0]);
});

test('extra LoRAs chain after the turbo LoRA via LoraLoaderModelOnly', () => {
  const wf = build({
    ...BASE, distilledLoraName: 'turbo.safetensors',
    loras: [{ name: 'scene_rain.safetensors', weight: 0.7 }, { name: '', weight: 1 }, { name: 'style.safetensors' }],
  });
  const chain = findNodes(wf, 'LoraLoaderModelOnly');
  assert.deepEqual(chain.map(n => n.inputs.lora_name), ['turbo.safetensors', 'scene_rain.safetensors', 'style.safetensors'], 'blank entries skipped');
  assert.equal(chain[1].inputs.strength_model, 0.7);
  assert.equal(chain[2].inputs.strength_model, 1.0, 'weight defaults to 1');
  const ids = Object.entries(wf).filter(([, n]) => n.class_type === 'LoraLoaderModelOnly').map(([k]) => k);
  assert.deepEqual(chain[1].inputs.model, [ids[0], 0], 'chained off the turbo LoRA');
  assert.deepEqual(findNode(wf, 'BasicGuider').inputs.model, [ids[2], 0], 'sampler uses the end of the chain');
  assert.equal(findNode(wf, 'BasicScheduler').inputs.steps, 8, 'turbo step default still applies');
  assert.equal(findNodes(build({ ...BASE, loras: [{ name: 'x.safetensors' }] }), 'LoraLoaderModelOnly').length, 1, 'works without a turbo LoRA');
});

test('R2V uses the Ref2VA UNet and MiniMaxH3ReferenceToVideo with one LoadImage per ref', () => {
  const wf = build(R2V_BASE);
  assert.equal(findNode(wf, 'UNETLoader').inputs.unet_name, R2V_BASE.refUnetName);
  assert.ok(!nodeTypes(wf).includes('MiniMaxH3ImageToVideo'));

  const h3 = findNode(wf, 'MiniMaxH3ReferenceToVideo');
  assert.equal(h3.inputs.prompt, BASE.positivePrompt);
  assert.equal(h3.inputs.ref_image_size, 'match');
  assert.ok(h3.inputs['ref_images.ref_image_0']);
  assert.ok(h3.inputs['ref_images.ref_image_1']);

  const loads = findNodes(wf, 'LoadImage');
  assert.equal(loads.length, 2);
  assert.deepEqual(loads.map(n => n.inputs.image).sort(), ['ref1.png', 'sub/ref2.png']);
});

test('R2V picks the Ref2VA turbo LoRA, not the FL2VA one', () => {
  const wf = build({
    ...R2V_BASE,
    distilledLoraName:    'fl2v_turbo.safetensors',
    refDistilledLoraName: 'ref2v_turbo.safetensors',
  });
  assert.equal(findNode(wf, 'LoraLoaderModelOnly').inputs.lora_name, 'ref2v_turbo.safetensors');
});

test('R2V always wires audio_vae (a required input of the reference node)', () => {
  const wf = build(R2V_BASE);
  const h3 = findNode(wf, 'MiniMaxH3ReferenceToVideo');
  assert.ok(Array.isArray(h3.inputs.audio_vae), 'audio_vae connected');
  assert.equal(wf[h3.inputs.audio_vae[0]].inputs.vae_name, R2V_BASE.audioVaeName);
});

test('R2V without audioVaeName throws a clear error', () => {
  assert.throws(() => build({ ...R2V_BASE, audioVaeName: undefined }), /Audio VAE/);
});

test('I2V wires last_frame through the same scaling chain as first_frame', () => {
  const wf = build({
    ...BASE, isI2V: true,
    inputRef:     { filename: 'start.png', subfolder: '', type: 'input' },
    lastFrameRef: { filename: 'end.png',   subfolder: '', type: 'input' },
  });
  const h3 = findNode(wf, 'MiniMaxH3ImageToVideo');
  assert.ok(h3.inputs.first_frame, 'first_frame connected');
  assert.ok(h3.inputs.last_frame,  'last_frame connected');
  assert.equal(findNodes(wf, 'ImageScaleToTotalPixels').length, 2);
  const lastScale = wf[h3.inputs.last_frame[0]];
  assert.equal(lastScale.class_type, 'ImageScaleToTotalPixels');
  assert.equal(wf[lastScale.inputs.image[0]].inputs.image, 'end.png');
  // last_frame alone (no first frame) is allowed too
  const only = findNode(build({ ...BASE, lastFrameRef: { filename: 'end.png', subfolder: '', type: 'input' } }), 'MiniMaxH3ImageToVideo');
  assert.equal(only.inputs.first_frame, undefined);
  assert.ok(only.inputs.last_frame);
});

test('R2V reference videos load via LoadVideo → GetVideoComponents with their soundtrack', () => {
  const wf = build({
    ...R2V_BASE,
    referenceVideos: [
      { filename: 'tail.mp4',   subfolder: '', type: 'input' },
      { filename: 'silent.mp4', subfolder: '', type: 'input', audio: false },
    ],
  });
  const h3   = findNode(wf, 'MiniMaxH3ReferenceToVideo');
  const gvcs = findNodes(wf, 'GetVideoComponents');
  assert.equal(findNodes(wf, 'LoadVideo').length, 2);
  assert.equal(gvcs.length, 2);
  assert.deepEqual(findNodes(wf, 'LoadVideo').map(n => n.inputs.file), ['tail.mp4', 'silent.mp4']);
  const gvc0 = h3.inputs['ref_videos.ref_video_0'][0];
  assert.equal(wf[gvc0].class_type, 'GetVideoComponents');
  assert.deepEqual(h3.inputs['ref_video_audios.ref_video_audio_0'], [gvc0, 1], 'soundtrack is output 1 of the same node');
  assert.ok(h3.inputs['ref_videos.ref_video_1']);
  assert.equal(h3.inputs['ref_video_audios.ref_video_audio_1'], undefined, 'silent clip has no soundtrack input');
});

test('R2V reference audio loads via LoadAudio into ref_audios', () => {
  const wf = build({ ...R2V_BASE, referenceRefs: [], referenceAudios: [{ filename: 'voice.wav', subfolder: 'film', type: 'input' }] });
  const h3 = findNode(wf, 'MiniMaxH3ReferenceToVideo');
  assert.ok(h3, 'R2V activates on audio-only references');
  assert.equal(findNode(wf, 'UNETLoader').inputs.unet_name, R2V_BASE.refUnetName);
  const la = wf[h3.inputs['ref_audios.ref_audio_0'][0]];
  assert.equal(la.class_type, 'LoadAudio');
  assert.equal(la.inputs.audio, 'film/voice.wav');
  assert.equal(h3.inputs['ref_images.ref_image_0'], undefined);
});

test('R2V reference limits are enforced', () => {
  const ref = i => ({ filename: `r${i}.png`, subfolder: '', type: 'input' });
  assert.throws(() => build({ ...R2V_BASE, referenceRefs: Array.from({ length: 10 }, (_, i) => ref(i)) }), /at most 9 reference images/);
  assert.throws(() => build({ ...R2V_BASE, referenceVideos: Array.from({ length: 4 }, (_, i) => ref(i)) }), /at most 3 reference videos/);
  assert.throws(() => build({ ...R2V_BASE, referenceAudios: Array.from({ length: 4 }, (_, i) => ref(i)) }), /at most 3 reference audio/);
});

test('R2V without refUnetName throws a clear error', () => {
  assert.throws(
    () => build({ ...R2V_BASE, refUnetName: undefined }),
    /Ref2VA/,
  );
});

test('isR2V with no references falls back to T2V on the FL2VA model', () => {
  const wf = build({ ...BASE, isR2V: true, referenceRefs: [] });
  assert.ok(nodeTypes(wf).includes('MiniMaxH3ImageToVideo'));
  assert.equal(findNode(wf, 'UNETLoader').inputs.unet_name, BASE.unetName);
});

test('turbo LoRA lowers the default step count to its trained count', () => {
  const turbo = build({ ...BASE, distilledLoraName: 'fl2v_turbo.safetensors' });
  assert.equal(findNode(turbo, 'BasicScheduler').inputs.steps, 8, 'FL2VA turbo defaults to 8 steps');

  const r2vTurbo = build({ ...R2V_BASE, refDistilledLoraName: 'ref2v_turbo.safetensors' });
  assert.equal(findNode(r2vTurbo, 'BasicScheduler').inputs.steps, 4, 'Ref2VA turbo defaults to 4 steps');

  const explicit = build({ ...BASE, distilledLoraName: 'fl2v_turbo.safetensors', steps: 12 });
  assert.equal(findNode(explicit, 'BasicScheduler').inputs.steps, 12, 'explicit steps win');

  const noLora = build(BASE);
  assert.equal(findNode(noLora, 'BasicScheduler').inputs.steps, defaults.steps, 'no LoRA keeps the full default');
});

test('seed flows into RandomNoise', () => {
  const wf = build({ ...BASE, seed: 42 });
  assert.equal(findNode(wf, 'RandomNoise').inputs.noise_seed, 42);
});

test('SaveVideo uses the iterator_video prefix', () => {
  const save = findNode(build(BASE), 'SaveVideo');
  assert.equal(save.inputs.filename_prefix, 'iterator_video');
  assert.equal(save.inputs.format, 'auto');
});

test('with audio, a silent fallback video is saved from the frame decoder alone', () => {
  const wf = build({ ...BASE, audioVaeName: 'audio.safetensors' });
  const saves   = findNodes(wf, 'SaveVideo');
  const creates = findNodes(wf, 'CreateVideo');
  assert.equal(saves.length, 2);
  assert.equal(creates.length, 2);
  const silentSave = saves.find(n => /_noaudio/.test(n.inputs.filename_prefix));
  assert.ok(silentSave, 'fallback SaveVideo carries the _noaudio prefix');
  const silentCreate = wf[silentSave.inputs.video[0]];
  assert.equal(silentCreate.class_type, 'CreateVideo');
  assert.equal(silentCreate.inputs.audio, undefined, 'fallback has no audio input');
  const decodeId = Object.entries(wf).find(([, n]) => n.class_type === 'VAEDecode')[0];
  assert.deepEqual(silentCreate.inputs.images, [decodeId, 0]);
  // The primary (muxed) save is still the first SaveVideo in the graph
  assert.equal(saves[0].inputs.filename_prefix, 'iterator_video');
  assert.ok(wf[saves[0].inputs.video[0]].inputs.audio, 'primary is the muxed one');

  assert.equal(findNodes(build(BASE), 'SaveVideo').length, 1, 'no fallback without audio');
});
