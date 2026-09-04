'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { plan, extract, readHeader, parseArgs, serializeHeader } = require('../../scripts/extract-safetensors');

// Builds a small safetensors file from { name: { dtype, shape, bytes } }.
function writeSafetensors(file, tensors, metadata) {
  const header = { __metadata__: metadata };
  const chunks = [];
  let off = 0;
  for (const [name, t] of Object.entries(tensors)) {
    header[name] = { dtype: t.dtype, shape: t.shape, data_offsets: [off, off + t.bytes.length] };
    chunks.push(t.bytes);
    off += t.bytes.length;
  }
  fs.writeFileSync(file, Buffer.concat([serializeHeader(header), ...chunks]));
}

// the license text is not ASCII (en dashes) — header lengths must be bytes
const META = { config: '{"vae":{"x":1}}', model_version: '2.3.0', license: 'LTX-2 – including – but not limited to – “this”', _quantization_metadata: '{"layers":{}}', encrypted_wandb_properties: 'zzz' };
const T = {
  'model.diffusion_model.w': { dtype: 'BF16', shape: [4], bytes: Buffer.from([1, 1, 1, 1, 1, 1, 1, 1]) },
  'vae.decoder.a':           { dtype: 'F32',  shape: [2], bytes: Buffer.from([2, 2, 2, 2, 2, 2, 2, 2]) },
  'vae.encoder.b':           { dtype: 'F32',  shape: [1], bytes: Buffer.from([3, 3, 3, 3]) },
  'audio_vae.decoder.c':     { dtype: 'BF16', shape: [1], bytes: Buffer.from([4, 4]) },
  'vocoder.vocoder.d':       { dtype: 'BF16', shape: [3], bytes: Buffer.from([5, 5, 5, 5, 5, 5]) },
};

test('parseArgs: repeated --prefix with rename / strip, --keep-meta', () => {
  const a = parseArgs(['in', 'out', '--prefix', 'vae.=', '--prefix', 'audio_vae.', '--prefix', 'a.=b.', '--keep-meta', 'license']);
  assert.deepEqual(a.positional, ['in', 'out']);
  assert.deepEqual(a.prefixes, [{ from: 'vae.', to: '' }, { from: 'audio_vae.', to: 'audio_vae.' }, { from: 'a.', to: 'b.' }]);
  assert.ok(a.keepMeta.has('license'));
});

test('plan: selects by prefix, renames, packs offsets contiguously, filters metadata', () => {
  const header = { __metadata__: META };
  let off = 0;
  for (const [k, t] of Object.entries(T)) { header[k] = { dtype: t.dtype, shape: t.shape, data_offsets: [off, off + t.bytes.length] }; off += t.bytes.length; }
  const p = plan(header, { prefixes: [{ from: 'vae.', to: '' }] });
  assert.deepEqual(p.tensors.map(t => t.name), ['decoder.a', 'encoder.b']);
  assert.deepEqual(p.outHeader['decoder.a'].data_offsets, [0, 8]);
  assert.deepEqual(p.outHeader['encoder.b'].data_offsets, [8, 12]);
  assert.equal(p.totalBytes, 12);
  assert.deepEqual(Object.keys(p.outHeader.__metadata__).sort(), ['config', 'license', 'model_version'], 'quantization + wandb metadata dropped, config kept');
  const kept = plan(header, { prefixes: [{ from: 'vae.', to: '' }], keepMeta: new Set(['_quantization_metadata']) });
  assert.ok('_quantization_metadata' in kept.outHeader.__metadata__);
  assert.throws(() => plan(header, { prefixes: [{ from: 'nope.', to: '' }] }), /no tensors match/);
  assert.throws(() => plan(header, { prefixes: [] }), /--prefix/);
});

test('extract: writes a valid safetensors file with the selected tensors and their exact bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  try {
    const src = path.join(dir, 'ckpt.safetensors');
    writeSafetensors(src, T, META);
    const outVideo = path.join(dir, 'video.safetensors');
    const r = extract(src, outVideo, { prefixes: [{ from: 'vae.', to: '' }], keepMeta: new Set() });
    assert.deepEqual({ tensors: r.tensors, bytes: r.bytes }, { tensors: 2, bytes: 12 });
    const fd = fs.openSync(outVideo, 'r');
    const { header, dataStart } = readHeader(fd);
    const data = fs.readFileSync(outVideo).subarray(dataStart);
    fs.closeSync(fd);
    assert.equal(dataStart % 8, 0, 'header padded to 8 bytes');
    assert.deepEqual(Object.keys(header).filter(k => k !== '__metadata__'), ['decoder.a', 'encoder.b']);
    assert.deepEqual([...data.subarray(...header['decoder.a'].data_offsets)], [2, 2, 2, 2, 2, 2, 2, 2]);
    assert.deepEqual([...data.subarray(...header['encoder.b'].data_offsets)], [3, 3, 3, 3]);
    assert.equal(header.__metadata__.config, META.config);
    assert.equal(header.__metadata__.license, META.license, 'non-ASCII metadata survives');
    // audio: two prefixes kept verbatim
    const outAudio = path.join(dir, 'audio.safetensors');
    extract(src, outAudio, { prefixes: [{ from: 'audio_vae.', to: 'audio_vae.' }, { from: 'vocoder.', to: 'vocoder.' }] });
    const fd2 = fs.openSync(outAudio, 'r');
    const h2 = readHeader(fd2).header; fs.closeSync(fd2);
    assert.deepEqual(Object.keys(h2).filter(k => k !== '__metadata__'), ['audio_vae.decoder.c', 'vocoder.vocoder.d']);
    assert.deepEqual(h2['vocoder.vocoder.d'].data_offsets, [2, 8]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
