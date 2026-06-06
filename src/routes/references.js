'use strict';

// NOTE: Accepts base64-encoded files as JSON rather than multipart/form-data.
// Express has no built-in multipart parser; this avoids adding an external dependency.
// May be revisited if Node.js/Express gains native multipart support.

const express = require('express');
const router  = express.Router();
const comfyui = require('../services/comfyui');

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
      const buffer = Buffer.from(base64, 'base64');
      return comfyui.uploadImage(buffer, name);
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
