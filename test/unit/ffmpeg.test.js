'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createFfmpeg, resolveBinaries } = require('../../src/services/ffmpeg');

// A fake execFile that records argv and can be scripted per call.
function fakeExec(handler) {
  const calls = [];
  const execFile = (bin, args, opts, cb) => {
    calls.push({ bin, args });
    Promise.resolve().then(() => {
      try {
        const r = handler({ bin, args, opts }) ?? {};
        if (r.error) return cb(r.error, r.stdout ?? '', r.stderr ?? '');
        cb(null, r.stdout ?? '', r.stderr ?? '');
      } catch (e) { cb(e, '', ''); }
    });
  };
  return { execFile, calls };
}

const PROBE = (over = {}) => JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1344, height: 768, avg_frame_rate: '24/1', duration: '5.166667', nb_frames: '124' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000' },
  ].filter(s => !(over.silent && s.codec_type === 'audio')),
  format: { duration: '5.166667' },
});

test('detect parses the version line and reports a missing binary', async () => {
  const ok = fakeExec(({ bin }) => ({ stdout: `${path.basename(bin)} version 7.1.1 Copyright (c) 2000-2025` }));
  const f = createFfmpeg({ execFile: ok.execFile, ffmpegPath: '/usr/bin/ffmpeg', ffprobePath: '/usr/bin/ffprobe' });
  const d = await f.detect();
  assert.deepEqual(d, { available: true, path: '/usr/bin/ffmpeg', source: 'custom', version: '7.1.1', ffprobe: true, error: null });
  assert.equal(await f.detect(), d, 'cached');

  const missing = fakeExec(() => ({ error: Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }) }));
  const g = createFfmpeg({ execFile: missing.execFile, ffmpegPath: 'ffmpeg' });
  const m = await g.detect();
  assert.equal(m.available, false);
  assert.match(m.error, /ffmpeg not found/);
  assert.match(m.error, /npm install/);
  assert.match(m.error, /FFMPEG_PATH/);
});

test('probe normalises stream facts', async () => {
  const fx = fakeExec(() => ({ stdout: PROBE() }));
  const f  = createFfmpeg({ execFile: fx.execFile, ffprobePath: 'ffprobe' });
  const p  = await f.probe('/tmp/a.mp4');
  assert.deepEqual(p, { width: 1344, height: 768, fps: 24, durationSec: 5.166667, frames: 124, hasAudio: true, vcodec: 'h264', acodec: 'aac', sampleRate: 48000 });
  assert.deepEqual(fx.calls[0].args.slice(0, 2), ['-v', 'error']);
  assert.equal(fx.calls[0].args.at(-1), '/tmp/a.mp4');
  const silent = createFfmpeg({ execFile: fakeExec(() => ({ stdout: PROBE({ silent: true }) })).execFile });
  assert.equal((await silent.probe('x.mp4')).hasAudio, false);
});

test('extractLastFrame seeks from the end and falls back to selecting frame N-1', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-'));
  const out = path.join(dir, 'last.png');
  // First run writes nothing → fallback path
  let n = 0;
  const fx = fakeExec(({ bin, args }) => {
    if (bin === 'ffprobe') return { stdout: PROBE() };
    n++;
    if (n === 2) fs.writeFileSync(args.at(-1), 'png');
    return {};
  });
  const f = createFfmpeg({ execFile: fx.execFile, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  assert.equal(await f.extractLastFrame('/tmp/a.mp4', out), out);
  const first = fx.calls[0].args;
  assert.ok(first.includes('-sseof') && first.includes('-0.1'), 'seeks from end');
  assert.ok(first.includes('-frames:v'));
  const fallback = fx.calls.at(-1).args;
  assert.ok(fallback.some(a => a.includes('select=eq(n\\,123)')), `fallback selects frame 123: ${fallback}`);

  // Happy path: first run writes the file → only one ffmpeg call
  const happy = fakeExec(({ args }) => { fs.writeFileSync(args.at(-1), 'png'); return {}; });
  const g = createFfmpeg({ execFile: happy.execFile });
  await g.extractLastFrame('/tmp/a.mp4', path.join(dir, 'l2.png'));
  assert.equal(happy.calls.length, 1);
});

test('extractFrame / extractAudio / extractClip argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-'));
  const fx  = fakeExec(({ args }) => { fs.writeFileSync(args.at(-1), 'x'); return {}; });
  const f   = createFfmpeg({ execFile: fx.execFile });
  await f.extractFrame('in.mp4', 3.25, path.join(dir, 'f.png'));
  await f.extractAudio('in.mp4', 1.2, 4, path.join(dir, 'v.wav'));
  await f.extractClip('in.mp4', 0, 10, path.join(dir, 'c.mp4'));
  const [frame, audio, clip] = fx.calls.map(c => c.args);
  assert.deepEqual(frame.slice(frame.indexOf('-ss'), frame.indexOf('-ss') + 4), ['-ss', '3.25', '-i', 'in.mp4']);
  assert.ok(frame.includes('-frames:v'));
  assert.ok(audio.includes('-vn') && audio.includes('pcm_s16le'));
  assert.deepEqual(audio.slice(audio.indexOf('-ss'), audio.indexOf('-ss') + 4), ['-ss', '1.2', '-to', '4']);
  assert.ok(clip.includes('-c') && clip[clip.indexOf('-c') + 1] === 'copy');
});

test('concat stream-copies uniform clips and re-encodes mixed ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffm-'));
  const a = path.join(dir, 'a.mp4'), b = path.join(dir, 'b.mp4');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');

  const uni = fakeExec(({ bin, args }) => bin === 'ffprobe' ? { stdout: PROBE() } : (fs.writeFileSync(args.at(-1), 'out'), {}));
  const f = createFfmpeg({ execFile: uni.execFile, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  const r = await f.concat([a, b], path.join(dir, 'out.mp4'));
  assert.deepEqual(r, { file: path.join(dir, 'out.mp4'), clips: 2, reencoded: false });
  const cat = uni.calls.find(c => c.bin === 'ffmpeg').args;
  assert.ok(cat.includes('concat') && cat.includes('copy'), `copy concat: ${cat}`);
  assert.ok(!fs.existsSync(path.join(dir, '.concat-list.txt')), 'list file cleaned up');

  // b is silent → gets a silent track, and the join re-encodes
  let probeN = 0;
  const mixed = fakeExec(({ bin, args }) => {
    if (bin === 'ffprobe') return { stdout: PROBE({ silent: (probeN++ % 2) === 1 }) };
    fs.writeFileSync(args.at(-1), 'out'); return {};
  });
  const g = createFfmpeg({ execFile: mixed.execFile, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  const r2 = await g.concat([a, b], path.join(dir, 'out2.mp4'));
  assert.equal(r2.reencoded, true);
  const ffCalls = mixed.calls.filter(c => c.bin === 'ffmpeg').map(c => c.args);
  assert.ok(ffCalls.some(args => args.some(x => x.startsWith('anullsrc'))), 'silent track added');
  assert.ok(ffCalls.at(-1).includes('libx264'), 're-encoded join');
});

test('run surfaces the stderr tail on failure', async () => {
  const fx = fakeExec(() => ({ error: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'line1\nline2\nInvalid data found' }));
  const f  = createFfmpeg({ execFile: fx.execFile, ffmpegPath: 'ffmpeg' });
  await assert.rejects(f.run(['-i', 'x']), /ffmpeg failed \(1\): [\s\S]*Invalid data found/);
});

test('binary resolution: env var beats the bundled package, which beats PATH', () => {
  const saved = { m: process.env.FFMPEG_PATH, p: process.env.FFPROBE_PATH };
  try {
    process.env.FFMPEG_PATH = '/opt/x/ffmpeg'; process.env.FFPROBE_PATH = '/opt/x/ffprobe';
    let r = resolveBinaries();
    assert.deepEqual(r.ffmpeg,  { path: '/opt/x/ffmpeg',  source: 'env' });
    assert.deepEqual(r.ffprobe, { path: '/opt/x/ffprobe', source: 'env' });

    delete process.env.FFMPEG_PATH; delete process.env.FFPROBE_PATH;
    r = resolveBinaries();
    let bundled = null;
    try { bundled = require('ffmpeg-static'); } catch { /* optional dependency absent on this platform */ }
    if (bundled && fs.existsSync(bundled)) {
      assert.deepEqual(r.ffmpeg, { path: bundled, source: 'bundled' });
      assert.equal(r.ffprobe.source, 'bundled');
    } else {
      assert.deepEqual(r.ffmpeg, { path: 'ffmpeg', source: 'path' });
    }
    // detect() reports where the binary came from
    const fx = fakeExec(({ bin }) => ({ stdout: `${path.basename(bin)} version 6.0` }));
    const f = createFfmpeg({ execFile: fx.execFile });
    return f.detect().then(d => assert.ok(['bundled', 'path'].includes(d.source), d.source));
  } finally {
    if (saved.m !== undefined) process.env.FFMPEG_PATH = saved.m; else delete process.env.FFMPEG_PATH;
    if (saved.p !== undefined) process.env.FFPROBE_PATH = saved.p; else delete process.env.FFPROBE_PATH;
  }
});
