'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const zlib     = require('zlib');
const { maxChannelValue, isBlank } = require('../../src/lib/png');

// ── Hand-built PNG encoder for test fixtures ─────────────────────────────────
// Builds a valid 8-bit PNG with a chosen scanline filter so the decoder's
// unfiltering paths are each exercised against known pixel data.

const COLOR_CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// rows: array of arrays of raw bytes (width * channels per row)
function makePng(rows, { colorType = 2, filter = 0 } = {}) {
  const channels = COLOR_CHANNELS[colorType];
  const width    = rows[0].length / channels;
  const height   = rows.length;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const bpp = channels;
  const filtered = [];
  let prev = new Array(rows[0].length).fill(0);
  for (const row of rows) {
    const out = [filter];
    for (let i = 0; i < row.length; i++) {
      const raw  = row[i];
      const left = i >= bpp ? row[i - bpp] : 0;
      const up   = prev[i];
      const ul   = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if      (filter === 0) v = raw;
      else if (filter === 1) v = raw - left;
      else if (filter === 2) v = raw - up;
      else if (filter === 3) v = raw - ((left + up) >> 1);
      else                   v = raw - paeth(left, up, ul);
      out.push(v & 0xff);
    }
    filtered.push(Buffer.from(out));
    prev = row;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(filtered))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('black RGB image is blank, max channel 0', () => {
  const png = makePng([[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]); // 2x2 black
  assert.equal(maxChannelValue(png), 0);
  assert.equal(isBlank(png), true);
});

test('one bright pixel makes it non-blank (every filter type)', () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    const png = makePng([
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 12, 200, 35], // one colored pixel
    ], { filter });
    assert.equal(maxChannelValue(png), 200, `filter ${filter}`);
    assert.equal(isBlank(png), false, `filter ${filter}`);
  }
});

test('near-black noise below threshold counts as blank', () => {
  const png = makePng([[3, 1, 2, 0, 5, 4]]);
  assert.equal(isBlank(png), true);
  assert.equal(isBlank(png, 4), false, 'custom threshold');
});

test('RGBA: alpha channel is ignored, color channels counted', () => {
  const opaqueBlack = makePng([[0, 0, 0, 255]], { colorType: 6 });
  assert.equal(isBlank(opaqueBlack), true, 'opaque black is blank');
  const white = makePng([[255, 255, 255, 255]], { colorType: 6 });
  assert.equal(isBlank(white), false);
});

test('grayscale and gray+alpha supported', () => {
  assert.equal(isBlank(makePng([[0, 0]], { colorType: 0 })), true);
  assert.equal(isBlank(makePng([[180, 0]], { colorType: 0 })), false);
  assert.equal(isBlank(makePng([[0, 255]], { colorType: 4 })), true, 'gray+alpha: alpha ignored');
});

test('real-world fixture: ComfyUI 1x1 white PNG is not blank', () => {
  const white = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
    'base64');
  assert.equal(isBlank(white), false);
});

test('non-PNG and malformed input throws', () => {
  assert.throws(() => maxChannelValue(Buffer.from('not a png')), /PNG/);
});
