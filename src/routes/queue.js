'use strict';

const express = require('express');
const router  = express.Router();
const queue   = require('../services/queue');

// Keep connected SSE clients
const sseClients = new Set();

queue.on('changed', state => {
  const data = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
});

// GET /api/queue — snapshot
router.get('/', (req, res) => {
  res.json(queue.getState());
});

// GET /api/queue/events — SSE stream
router.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send current state immediately
  res.write(`event: state\ndata: ${JSON.stringify(queue.getState())}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// DELETE /api/queue/:id — cancel pending job
router.delete('/:id', (req, res) => {
  const ok = queue.cancel(req.params.id);
  // cancel() returns true for both pending (removed) and running (abort initiated)
  if (!ok) return res.status(404).json({ error: 'Job not found or already complete' });
  res.status(204).end();
});

// POST /api/queue/:id/stop — stop running job
router.post('/:id/stop', (req, res) => {
  const { running } = queue.getState();
  if (!running || running.id !== req.params.id) {
    return res.status(404).json({ error: 'Job not running or not found' });
  }
  queue.cancel(req.params.id);
  res.status(204).end();
});

module.exports = router;
