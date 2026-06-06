'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router = express.Router();

const ARCH_DOCS_DIR = process.env.ARCH_DOCS_DIR
  || path.join(__dirname, '..', '..', 'docs', 'arch');

router.get('/:arch', (req, res) => {
  const { arch } = req.params;
  // Only allow simple identifiers — rejects path traversal and encoded slashes
  if (!/^[a-z0-9-]+$/i.test(arch)) return res.status(404).send('Not found');

  const filePath = path.join(ARCH_DOCS_DIR, `${arch}.md`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('No guide available for this architecture.');
  }

  const content = fs.readFileSync(filePath, 'utf8');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(content);
});

module.exports = router;
