#!/usr/bin/env node
'use strict';

// Extract a subset of tensors from a .safetensors file into a new .safetensors
// file — dependency-free, streams the tensor bytes, never loads the whole file.
//
// Why: LTX-2.3 checkpoints carry the DiT, the video VAE and the audio VAE in one
// 29 GB file, so the VAEs can only live on the DiT's GPU. Split out, they load
// through ComfyUI's VAELoader and can be placed on another device (model
// `devices` → ComfyUI-MultiGPU), which is what keeps a 24 GB DiT fully resident
// on a 30 GB card while decoding happens elsewhere.
//
//   node scripts/extract-safetensors.js <in> <out> --prefix <keep>[=<rename>] [--prefix …] [--keep-meta <key> …]
//
//   # LTX-2.3 video VAE (keys vae.* → *; ComfyUI's VAELoader expects the bare layout)
//   node scripts/extract-safetensors.js ckpt.safetensors ltx-2.3-video-vae.safetensors --prefix vae.=
//   # LTX-2.3 audio VAE + vocoder (kept as-is; VAELoader recognises audio_vae.* / vocoder.*)
//   node scripts/extract-safetensors.js ckpt.safetensors ltx-2.3-audio-vae.safetensors --prefix audio_vae. --prefix vocoder.
//
// `--prefix a.=b.` renames a matching prefix; `--prefix a.=` strips it. Metadata is
// copied except `_quantization_metadata` and `encrypted_wandb_properties` (the
// VAE configs live under `config`, which is kept); `--keep-meta` adds keys back.

const fs   = require('fs');
const path = require('path');

const DROP_META = new Set(['_quantization_metadata', 'encrypted_wandb_properties']);
const CHUNK = 64 * 1024 * 1024;

function parseArgs(argv) {
  const out = { prefixes: [], keepMeta: new Set(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prefix')         { const v = argv[++i] ?? ''; const eq = v.indexOf('='); out.prefixes.push(eq === -1 ? { from: v, to: v } : { from: v.slice(0, eq), to: v.slice(eq + 1) }); }
    else if (a === '--keep-meta') { out.keepMeta.add(argv[++i]); }
    else if (a === '-h' || a === '--help') { out.help = true; }
    else out.positional.push(a);
  }
  return out;
}

function readHeader(fd) {
  const lenBuf = Buffer.alloc(8);
  fs.readSync(fd, lenBuf, 0, 8, 0);
  const n = Number(lenBuf.readBigUInt64LE(0));
  const hdr = Buffer.alloc(n);
  fs.readSync(fd, hdr, 0, n, 8);
  return { header: JSON.parse(hdr.toString('utf8')), dataStart: 8 + n };
}

// Pure planning step (also used by the tests): which tensors go out, under which
// names, with their new offsets, and the metadata that travels with them.
function plan(header, { prefixes, keepMeta = new Set() }) {
  if (!prefixes.length) throw new Error('at least one --prefix is required');
  const tensors = [];
  let offset = 0;
  for (const [key, info] of Object.entries(header)) {
    if (key === '__metadata__') continue;
    const rule = prefixes.find(p => key.startsWith(p.from));
    if (!rule) continue;
    const name = rule.to + key.slice(rule.from.length);
    const [a, b] = info.data_offsets;
    const size = b - a;
    tensors.push({ src: key, name, dtype: info.dtype, shape: info.shape, srcStart: a, size, dstStart: offset });
    offset += size;
  }
  if (!tensors.length) throw new Error(`no tensors match ${prefixes.map(p => JSON.stringify(p.from)).join(', ')}`);
  const meta = {};
  for (const [k, v] of Object.entries(header.__metadata__ ?? {})) {
    if (DROP_META.has(k) && !keepMeta.has(k)) continue;
    meta[k] = v;
  }
  const outHeader = { __metadata__: meta };
  for (const t of tensors) outHeader[t.name] = { dtype: t.dtype, shape: t.shape, data_offsets: [t.dstStart, t.dstStart + t.size] };
  return { tensors, outHeader, totalBytes: offset };
}

function serializeHeader(outHeader) {
  let json = JSON.stringify(outHeader);
  // Lengths are bytes, not characters — metadata (license text) is not ASCII.
  const bytes = Buffer.byteLength(json, 'utf8');
  const pad = (8 - (bytes % 8)) % 8;              // safetensors pads the header to 8 bytes with spaces
  json += ' '.repeat(pad);
  const buf = Buffer.alloc(8 + bytes + pad);
  buf.writeBigUInt64LE(BigInt(bytes + pad), 0);
  buf.write(json, 8, 'utf8');
  return buf;
}

function extract(inPath, outPath, opts, log = () => {}) {
  const fd = fs.openSync(inPath, 'r');
  try {
    const { header, dataStart } = readHeader(fd);
    const { tensors, outHeader, totalBytes } = plan(header, opts);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    const out = fs.openSync(outPath, 'w');
    try {
      fs.writeSync(out, serializeHeader(outHeader));
      const buf = Buffer.alloc(CHUNK);
      let done = 0;
      for (const t of tensors) {
        let pos = 0;
        while (pos < t.size) {
          const n = Math.min(CHUNK, t.size - pos);
          fs.readSync(fd, buf, 0, n, dataStart + t.srcStart + pos);
          fs.writeSync(out, buf, 0, n);
          pos += n; done += n;
        }
        log(`${t.name} (${(t.size / 1e6).toFixed(1)} MB) — ${((done / totalBytes) * 100).toFixed(0)}%`);
      }
    } finally { fs.closeSync(out); }
    return { tensors: tensors.length, bytes: totalBytes, metadataKeys: Object.keys(outHeader.__metadata__) };
  } finally { fs.closeSync(fd); }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positional.length !== 2 || !args.prefixes.length) {
    console.error('usage: extract-safetensors.js <in.safetensors> <out.safetensors> --prefix <keep>[=<rename>] [--prefix …] [--keep-meta <key>]');
    process.exit(args.help ? 0 : 1);
  }
  const [inPath, outPath] = args.positional;
  try {
    const r = extract(inPath, outPath, args, line => console.log('  ' + line));
    console.log(`wrote ${outPath}: ${r.tensors} tensors, ${(r.bytes / 1e9).toFixed(2)} GB, metadata: ${r.metadataKeys.join(', ') || '(none)'}`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, plan, serializeHeader, extract, readHeader };
