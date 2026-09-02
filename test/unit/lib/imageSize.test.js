'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { imageSize, fitToBudget, roundToMultiple } = require('../../../src/lib/imageSize');

function pngBuffer(width, height) {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0); // PNG magic
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);          // IHDR length
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegBuffer(width, height) {
  // SOI, APP0 (minimal), SOF0 with dimensions
  return Buffer.from([
    0xff, 0xd8,                                     // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,             // APP0 len=4
    0xff, 0xc0, 0x00, 0x0b, 0x08,                   // SOF0 len=11, precision 8
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x01, 0x01, 0x11, 0x00,                         // 1 component
  ]);
}

test('imageSize reads PNG dimensions', () => {
  assert.deepEqual(imageSize(pngBuffer(832, 1216)), { width: 832, height: 1216 });
  assert.deepEqual(imageSize(pngBuffer(1, 1)), { width: 1, height: 1 });
});

test('imageSize reads JPEG SOF0 dimensions', () => {
  assert.deepEqual(imageSize(jpegBuffer(1024, 768)), { width: 1024, height: 768 });
});

test('imageSize returns null for unknown data', () => {
  assert.equal(imageSize(Buffer.from('fakemp4')), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
});

test('fitToBudget preserves orientation within the pixel budget', () => {
  // Portrait 832×1216 into H3's 1344×768 budget, /32 grid
  const p = fitToBudget(832, 1216, 1344, 768, 32);
  assert.ok(p.height > p.width, 'stays portrait');
  assert.equal(p.width % 32, 0);
  assert.equal(p.height % 32, 0);
  const budget = 1344 * 768;
  assert.ok(Math.abs(p.width * p.height - budget) / budget < 0.15, 'area near budget');

  // Landscape source stays landscape
  const l = fitToBudget(1920, 1080, 832, 480, 16);
  assert.ok(l.width > l.height);
  assert.equal(l.width % 16, 0);
  assert.equal(l.height % 16, 0);
});

test('fitToBudget of a square source is square', () => {
  const s = fitToBudget(1024, 1024, 1344, 768, 32);
  assert.equal(s.width, s.height);
});

test('fitToBudget handles invalid input', () => {
  assert.equal(fitToBudget(0, 100, 832, 480), null);
  assert.equal(fitToBudget(100, 0, 832, 480), null);
});

test('roundToMultiple clamps to at least one multiple', () => {
  assert.equal(roundToMultiple(1, 32), 32);
  assert.equal(roundToMultiple(47, 32), 32);
  assert.equal(roundToMultiple(49, 32), 64);
});

test('fitToBudget caps either edge at the budget long edge for extreme ratios', () => {
  // 6:1 panorama into H3's 1344×768 budget: area-conserving fit would be ~2496×416
  const p = fitToBudget(3840, 640, 1344, 768, 32);
  assert.ok(p.width <= 1344, `width capped, got ${p.width}`);
  assert.equal(p.width % 32, 0);
  assert.equal(p.height % 32, 0);
  assert.ok(p.width > p.height, 'stays landscape');

  // Explicit maxDim wins over the default long-edge cap
  const q = fitToBudget(3840, 640, 1344, 768, 32, 1024);
  assert.ok(q.width <= 1024, `width capped at maxDim, got ${q.width}`);
});
