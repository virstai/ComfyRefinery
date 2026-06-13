'use strict';

// Minimal PNG pixel inspector — just enough to tell whether an image is
// effectively blank (used to detect empty DWPose skeletons). Supports the
// PNGs ComfyUI's SaveImage writes: 8-bit depth, grayscale/RGB (+alpha),
// non-interlaced. No external dependencies.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS  = { 0: 1, 2: 3, 4: 2, 6: 4 };       // colorType → channel count
const HAS_ALPHA = { 0: false, 2: false, 4: true, 6: true };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Highest value found in any non-alpha channel (0–255).
function maxChannelValue(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG image');
  }

  // Walk chunks: read IHDR, concatenate IDAT
  let pos = 8;
  let width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const len  = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      bitDepth  = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // length + type + data + crc
  }
  if (width === undefined) throw new Error('PNG missing IHDR');
  if (bitDepth !== 8)      throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  if (interlace !== 0)     throw new Error('Interlaced PNG not supported');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);

  const raw      = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const alpha    = HAS_ALPHA[colorType] ? channels - 1 : channels; // index of alpha within a pixel

  let max  = 0;
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const start  = y * (rowBytes + 1);
    const filter = raw[start];
    const row    = Buffer.alloc(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const x    = raw[start + 1 + i];
      const left = i >= channels ? row[i - channels] : 0;
      const up   = prev[i];
      const ul   = i >= channels ? prev[i - channels] : 0;
      let v;
      if      (filter === 0) v = x;
      else if (filter === 1) v = x + left;
      else if (filter === 2) v = x + up;
      else if (filter === 3) v = x + ((left + up) >> 1);
      else if (filter === 4) v = x + paeth(left, up, ul);
      else throw new Error(`Unknown PNG filter type: ${filter}`);
      v &= 0xff;
      row[i] = v;
      if (i % channels !== alpha && v > max) max = v;
    }
    prev = row;
  }
  return max;
}

// Effectively-empty check: nothing brighter than `threshold` in any color channel.
function isBlank(buffer, threshold = 16) {
  return maxChannelValue(buffer) <= threshold;
}

module.exports = { maxChannelValue, isBlank };
