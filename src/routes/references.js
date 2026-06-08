'use strict';

// NOTE: Accepts base64-encoded files as JSON rather than multipart/form-data.
// Express has no built-in multipart parser; this avoids adding an external dependency.
// May be revisited if Node.js/Express gains native multipart support.

const express = require('express');
const router  = express.Router();
const sharp   = require('sharp');
const comfyui = require('../services/comfyui');

// Pad an image buffer to a square by extending the shorter dimension with a black background.
async function padToSquare(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  if (width === height) return buffer;
  const size  = Math.max(width, height);
  const left  = Math.floor((size - width)  / 2);
  const top   = Math.floor((size - height) / 2);
  return sharp(buffer)
    .extend({
      top,
      bottom: size - height - top,
      left,
      right:  size - width - left,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .toBuffer();
}

// POST /api/references/upload
// Body: { files: [{ name: string, data: string (base64 or data URL) }] }
// Returns: [{ filename, subfolder, type }]
router.post('/upload', async (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'files array is required' });
  }

  try {
    const results = await Promise.all(files.map(async ({ name, data }) => {
      if (!name || !data) throw new Error('Each file requires name and data fields');
      const base64 = data.includes(',') ? data.split(',')[1] : data;
      const buffer = await padToSquare(Buffer.from(base64, 'base64'));
      return comfyui.uploadImage(buffer, name);
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
