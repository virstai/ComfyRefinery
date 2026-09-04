'use strict';

const express = require('express');
const path = require('path');
const { createServer } = require('http');

const config = require('./src/services/config');
const db     = require('./src/services/db');
const generateRoutes    = require('./src/routes/generate');
const sessionsRoutes    = require('./src/routes/sessions');
const referencesRoutes  = require('./src/routes/references');
const archHelpRoutes    = require('./src/routes/archHelp');
const sdapiRoutes       = require('./src/routes/sdapi');
const queueRoutes       = require('./src/routes/queue');
const systemRoutes      = require('./src/routes/system');
const projectsRoutes    = require('./src/routes/projects');

const app = express();
const server = createServer(app);
// Disable the 5-minute default so long-running sdapi generation requests aren't killed mid-flight
server.requestTimeout = 0;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/generate',    generateRoutes);
app.use('/api/sessions',    sessionsRoutes);
app.use('/api/references',  referencesRoutes);
app.use('/api/arch-help',   archHelpRoutes);
app.use('/api/system',      systemRoutes);
app.use('/api/queue',       queueRoutes);
app.use('/api/projects',    projectsRoutes);
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

// Proxy ComfyUI video/audio output so the browser doesn't need direct access
function makeComfyProxy(defaultContentType) {
  return async (req, res) => {
    const { filename, subfolder = '', type = 'output' } = req.query;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const { comfyuiUrl } = config.load();
    const url = `${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;

    try {
      const upstream = await fetch(url);
      if (!upstream.ok) return res.status(upstream.status).send('ComfyUI error');
      res.set('Content-Type', upstream.headers.get('content-type') || defaultContentType);
      const buf = await upstream.arrayBuffer();
      res.send(Buffer.from(buf));
    } catch (err) {
      res.status(502).json({ error: 'Could not reach ComfyUI', detail: err.message });
    }
  };
}

app.get('/api/video', makeComfyProxy('video/mp4'));
app.get('/api/audio', makeComfyProxy('audio/flac'));

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  // Sessions still marked "running" from before this process started belong
  // to a pipeline that died with the previous server — nothing can finish or
  // stop them now, so mark them so the UI doesn't wait on them forever.
  for (const s of db.listSessions(Infinity)) {
    if (s.status !== 'running') continue;
    s.status = 'error';
    db.saveSession(s, { touch: false });
    console.warn(`[startup] session ${s.id.slice(0, 8)} was running at shutdown — marked as error`);
  }
  projectsRoutes.recoverProjects();

  server.listen(PORT, () => {
    const cfg = config.load();
    console.log(`ComfyRefinery running at http://localhost:${PORT}`);
    console.log(`  LLM:     ${cfg.llmBaseUrl}`);
    console.log(`  ComfyUI: ${cfg.comfyuiUrl}`);
  });
}

module.exports = { app, server };
