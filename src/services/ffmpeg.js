'use strict';

// ffmpeg / ffprobe wrapper for the Film feature: last-frame capture, reference
// captures (a frame at t, an audio range), trimming a clip, and stitching the
// approved takes into one file. ffmpeg is an external host dependency (like
// the ComfyUI custom node packs) — `detect()` feeds the System page and the
// Film routes refuse to run without it rather than producing takes that could
// never be continued from.
//
// Binary resolution, in order: FFMPEG_PATH / FFPROBE_PATH env vars → the
// bundled `ffmpeg-static` / `ffprobe-static` packages (optional dependencies,
// installed by `npm install` on supported platforms) → `ffmpeg` / `ffprobe` on
// PATH. So the normal install is just `npm install`; a system ffmpeg is the
// fallback and an env var the override.
//
// `createFfmpeg` takes an injectable `execFile` so unit tests can assert the
// exact argv without a binary; integration tests point FFMPEG_PATH /
// FFPROBE_PATH at stub scripts.

const fs   = require('fs');
const path = require('path');
const childProcess = require('child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function bundledPath(pkg) {
  try {
    const mod = require(pkg);
    const p = typeof mod === 'string' ? mod : mod?.path;
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

// → { path, source } with source one of 'env' | 'bundled' | 'path'
function resolveBinary(envVar, pkg, name) {
  if (process.env[envVar]) return { path: process.env[envVar], source: 'env' };
  const bundled = bundledPath(pkg);
  if (bundled) return { path: bundled, source: 'bundled' };
  return { path: name, source: 'path' };
}

function resolveBinaries() {
  return {
    ffmpeg:  resolveBinary('FFMPEG_PATH',  'ffmpeg-static',  'ffmpeg'),
    ffprobe: resolveBinary('FFPROBE_PATH', 'ffprobe-static', 'ffprobe'),
  };
}

function createFfmpeg({
  execFile    = childProcess.execFile,
  ffmpegPath  = null,
  ffprobePath = null,
  source      = null,
} = {}) {
  const resolved = resolveBinaries();
  if (!ffmpegPath)  { ffmpegPath  = resolved.ffmpeg.path;  source = source ?? resolved.ffmpeg.source; }
  if (!ffprobePath) { ffprobePath = resolved.ffprobe.path; }
  source = source ?? 'custom';
  let detected = null;

  function exec(bin, args, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { signal, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        if (err.code === 'ENOENT') {
          return reject(new Error(`${path.basename(bin)} not found — run "npm install" (bundles ffmpeg-static / ffprobe-static), install ffmpeg on the host, or set FFMPEG_PATH / FFPROBE_PATH`));
        }
        if (err.name === 'AbortError' || signal?.aborted) {
          const e = new Error('Stopped'); e.name = 'AbortError'; return reject(e);
        }
        const tail = String(stderr ?? '').trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${path.basename(bin)} failed (${err.code ?? err.signal ?? 'error'}): ${tail || err.message}`));
      });
    });
  }

  // { available, path, version, ffprobe, error } — cached; refresh: true re-probes.
  async function detect({ refresh = false } = {}) {
    if (detected && !refresh) return detected;
    let result;
    try {
      const { stdout } = await exec(ffmpegPath, ['-version'], { timeoutMs: 10_000 });
      const version = (stdout.match(/ffmpeg version (\S+)/) ?? [])[1] ?? null;
      let ffprobe = false;
      try { await exec(ffprobePath, ['-version'], { timeoutMs: 10_000 }); ffprobe = true; } catch { /* reported below */ }
      result = { available: true, path: ffmpegPath, source, version, ffprobe, error: ffprobe ? null : 'ffprobe not found — install it alongside ffmpeg or set FFPROBE_PATH' };
    } catch (e) {
      result = { available: false, path: ffmpegPath, source, version: null, ffprobe: false, error: e.message };
    }
    detected = result;
    return result;
  }

  function run(args, opts) {
    return exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], opts);
  }

  function parseFps(rate) {
    if (!rate) return null;
    const [n, d] = String(rate).split('/').map(Number);
    if (!n) return null;
    return d ? n / d : n;
  }

  // Stream facts the Film code needs: { width, height, fps, durationSec, frames, hasAudio, vcodec, acodec, sampleRate }
  async function probe(file) {
    const { stdout } = await exec(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 60_000 });
    let data;
    try { data = JSON.parse(stdout); } catch { throw new Error(`ffprobe returned unreadable output for ${path.basename(file)}`); }
    const streams = data.streams ?? [];
    const v = streams.find(s => s.codec_type === 'video');
    const a = streams.find(s => s.codec_type === 'audio');
    if (!v) throw new Error(`no video stream in ${path.basename(file)}`);
    const fps = parseFps(v.avg_frame_rate) ?? parseFps(v.r_frame_rate);
    const durationSec = Number(v.duration ?? data.format?.duration) || null;
    const frames = Number(v.nb_frames) || (durationSec && fps ? Math.round(durationSec * fps) : null);
    return {
      width: Number(v.width), height: Number(v.height), fps, durationSec, frames,
      hasAudio: !!a, vcodec: v.codec_name ?? null, acodec: a?.codec_name ?? null,
      sampleRate: a ? Number(a.sample_rate) || null : null,
    };
  }

  function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  function nonEmpty(file) { try { return fs.statSync(file).size > 0; } catch { return false; } }

  // The last frame of a clip, as PNG. `-sseof` seeks from the end; on the rare
  // container where that yields nothing, fall back to selecting frame N-1.
  async function extractLastFrame(video, outPng, opts = {}) {
    ensureDir(outPng);
    await run(['-y', '-sseof', '-0.1', '-i', video, '-update', '1', '-frames:v', '1', outPng], opts);
    if (nonEmpty(outPng)) return outPng;
    const { frames } = await probe(video);
    if (!frames) throw new Error(`could not read the last frame of ${path.basename(video)}`);
    await run(['-y', '-i', video, '-vf', `select=eq(n\\,${frames - 1})`, '-vsync', 'vfr', '-frames:v', '1', outPng], opts);
    if (!nonEmpty(outPng)) throw new Error(`could not read the last frame of ${path.basename(video)}`);
    return outPng;
  }

  async function extractFrame(video, tSec, outPng, opts = {}) {
    ensureDir(outPng);
    await run(['-y', '-ss', String(tSec), '-i', video, '-frames:v', '1', '-update', '1', outPng], opts);
    if (!nonEmpty(outPng)) throw new Error(`no frame at ${tSec}s in ${path.basename(video)}`);
    return outPng;
  }

  // Audio range → 16-bit PCM WAV (what LoadAudio and voice references want).
  async function extractAudio(video, fromSec, toSec, outWav, opts = {}) {
    ensureDir(outWav);
    await run(['-y', '-ss', String(fromSec), '-to', String(toSec), '-i', video, '-vn', '-c:a', 'pcm_s16le', outWav], opts);
    if (!nonEmpty(outWav)) throw new Error(`no audio between ${fromSec}s and ${toSec}s in ${path.basename(video)}`);
    return outWav;
  }

  // Trim a clip without re-encoding (used to cut a previous take's tail down to
  // the reference-clip length the model accepts).
  async function extractClip(video, fromSec, toSec, outMp4, opts = {}) {
    ensureDir(outMp4);
    await run(['-y', '-ss', String(fromSec), '-to', String(toSec), '-i', video, '-c', 'copy', outMp4], opts);
    return outMp4;
  }

  // Give a silent clip an empty stereo track so it can be stream-copied next
  // to clips that have audio.
  async function addSilentAudio(video, outMp4, { sampleRate = 48000, signal } = {}) {
    ensureDir(outMp4);
    await run(['-y', '-i', video, '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`,
               '-shortest', '-c:v', 'copy', '-c:a', 'aac', outMp4], { signal });
    return outMp4;
  }

  // Concatenate clips in order. Uniform clips (same size, fps, codec, all with
  // audio) are stream-copied; anything else is normalised and re-encoded.
  async function concat(files, outMp4, { signal, workDir } = {}) {
    if (!files.length) throw new Error('nothing to concatenate');
    ensureDir(outMp4);
    const dir = workDir ?? path.dirname(outMp4);
    const infos = [];
    for (const f of files) infos.push(await probe(f));
    const first = infos[0];
    const uniform = infos.every(i =>
      i.width === first.width && i.height === first.height && i.vcodec === first.vcodec &&
      Math.abs((i.fps ?? 0) - (first.fps ?? 0)) < 0.01 && i.hasAudio === first.hasAudio && i.acodec === first.acodec);

    let inputs = files;
    const temps = [];
    if (!uniform || !first.hasAudio) {
      // Normalise: every clip gets an audio track so the concat demuxer sees one layout.
      inputs = [];
      for (let i = 0; i < files.length; i++) {
        if (infos[i].hasAudio) { inputs.push(files[i]); continue; }
        const tmp = path.join(dir, `.concat-${i}-silent.mp4`);
        await addSilentAudio(files[i], tmp, { signal });
        temps.push(tmp); inputs.push(tmp);
      }
    }

    const listPath = path.join(dir, '.concat-list.txt');
    fs.writeFileSync(listPath, inputs.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    try {
      const codec = uniform ? ['-c', 'copy'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
      await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, ...codec, '-movflags', '+faststart', outMp4], { signal });
    } finally {
      for (const t of [listPath, ...temps]) { try { fs.unlinkSync(t); } catch { /* ignore */ } }
    }
    return { file: outMp4, clips: files.length, reencoded: !uniform };
  }

  return { detect, run, probe, extractLastFrame, extractFrame, extractAudio, extractClip, addSilentAudio, concat };
}

const defaultInstance = createFfmpeg();

module.exports = { createFfmpeg, resolveBinaries, ...defaultInstance };
