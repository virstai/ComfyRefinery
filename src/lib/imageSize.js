'use strict';

// Minimal, dependency-free image dimension readers — enough for ComfyUI
// outputs (PNG) and common uploaded references (JPEG, WebP).

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0–SOF15 carry dimensions, except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = buf.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (fmt === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (fmt === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

// → { width, height } or null when the format is unrecognized
function imageSize(buf) {
  return pngSize(buf) ?? jpegSize(buf) ?? webpSize(buf);
}

function roundToMultiple(v, multiple) {
  return Math.max(multiple, Math.round(v / multiple) * multiple);
}

// Fit srcW×srcH's aspect ratio into the pixel budget of budgetW×budgetH,
// rounding both output dimensions to `multiple`.
function fitToBudget(srcW, srcH, budgetW, budgetH, multiple = 16) {
  if (!srcW || !srcH || !budgetW || !budgetH) return null;
  const ar = srcW / srcH;
  const h  = Math.sqrt((budgetW * budgetH) / ar);
  return { width: roundToMultiple(h * ar, multiple), height: roundToMultiple(h, multiple) };
}

module.exports = { imageSize, fitToBudget, roundToMultiple };
