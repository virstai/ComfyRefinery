'use strict';

const express = require('express');
const path = require('path');
const { createServer } = require('http');

const config = require('./src/services/config');
const generateRoutes    = require('./src/routes/generate');
const sessionsRoutes    = require('./src/routes/sessions');
const referencesRoutes  = require('./src/routes/references');
const archHelpRoutes    = require('./src/routes/archHelp');
const sdapiRoutes       = require('./src/routes/sdapi');
const queueRoutes       = require('./src/routes/queue');

const app = express();
const server = createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/generate',    generateRoutes);
app.use('/api/sessions',    sessionsRoutes);
app.use('/api/references',  referencesRoutes);
app.use('/api/arch-help',   archHelpRoutes);
app.use('/api/queue',       queueRoutes);
app.use('/sdapi/v1',        sdapiRoutes);

// Proxy ComfyUI image output so the browser doesn't need direct access
app.get('/api/image', async (req, res) => {
  const { filename, subfolder = '', type = 'output' } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const { comfyuiUrl } = config.load();
  const url = `${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).send('ComfyUI error');
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(502).json({ error: 'Could not reach ComfyUI', detail: err.message });
  }
});

// Proxy ComfyUI video output so the browser doesn't need direct access
app.get('/api/video', async (req, res) => {
  const { filename, subfolder = '', type = 'output' } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const { comfyuiUrl } = config.load();
  const url = `${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).send('ComfyUI error');
    res.set('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(502).json({ error: 'Could not reach ComfyUI', detail: err.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    const cfg = config.load();
    console.log(`ComfyRefinery running at http://localhost:${PORT}`);
    console.log(`  Ollama:  ${cfg.ollamaUrl}`);
    console.log(`  ComfyUI: ${cfg.comfyuiUrl}`);
  });
}

module.exports = { app, server };
