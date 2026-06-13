'use strict';

// Shared fake HTTP servers and SSE helpers used by integration test suites.

const http = require('http');
const { WebSocketServer } = require('ws');

// 1×1 white PNG returned by fake /view so base64 encoding works. White (not
// transparent/black) so pose-skeleton blank-detection treats it as a valid pose.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);

// Extract the text portion of a message's content regardless of format
// (OpenAI content can be a string or an array of parts).
function messageText(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(c => c.type === 'text').map(c => c.text).join(' ');
  }
  return '';
}

// getVerdict is called per review request so callers can change it at any time.
function makeFakeOllama(getVerdict, opts = {}) {
  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      // Return empty model list for /v1/models
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404); return res.end();
    }

    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const parsed  = JSON.parse(body);
      const { messages, stream = true } = parsed;

      const isReview = messages.some(m =>
        messageText(m).toLowerCase().includes('reviewing'),
      );
      const isSkillRefresh = messages.some(m =>
        messageText(m).toLowerCase().includes('knowledge base'),
      );

      const verdict = getVerdict();
      let text;
      if (isSkillRefresh) {
        text = 'SKILL\nUse short descriptive tags for best results.\n\nENFORCE\nAlways adapt to the model style.';
      } else if (isReview) {
        text = `Image assessed.\nVERDICT: ${verdict}\nDIAGNOSIS: ${verdict === 'ACCEPT' ? 'looks good' : 'subject not visible'}`;
      } else {
        text = 'a detailed landscape with mountains, high quality, sharp focus';
      }

      // Tool-call emission: when the request offers tools and the test's
      // getToolCalls callback returns calls, stream them as split deltas
      // (exercising accumulation) and finish with no content.
      if (stream !== false && parsed.tools && opts.getToolCalls) {
        const calls = opts.getToolCalls(parsed) ?? [];
        if (calls.length) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          calls.forEach((c, i) => {
            const argStr = JSON.stringify(c.args ?? {});
            const mid    = Math.ceil(argStr.length / 2);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: c.name, arguments: argStr.slice(0, mid) } }] }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: argStr.slice(mid) } }] }, finish_reason: null }] })}\n\n`);
          });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      if (stream === false) {
        // Non-streaming OpenAI response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-fake',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        }));
      } else {
        // Streaming SSE — OpenAI format
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const word of text.split(' ')) {
          const chunk = JSON.stringify({
            id: 'chatcmpl-fake',
            choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }],
          });
          res.write(`data: ${chunk}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  });
}

function makeFakeComfyUI(opts = {}) {
  const promptId = 'test-prompt-001';
  const uploads  = [];
  const prompts  = []; // each submitted ComfyUI /prompt body (parsed JSON)

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/prompt') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        prompts.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: promptId }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/upload/image') {
      // Consume the body (multipart from comfyui.uploadImage via native FormData)
      req.on('data', () => {});
      req.on('end', () => {
        uploads.push({ filename: 'uploaded.png' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'uploaded.png', subfolder: '', type: 'input' }));
      });
      return;
    }
    if (req.url.startsWith('/history/')) {
      const pid = req.url.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        [pid]: { outputs: { '7': { images: [{ filename: 'fake_00001_.png', subfolder: '', type: 'output' }] } } },
      }));
      return;
    }
    if (req.url.startsWith('/view_metadata/loras')) {
      const u = new URL(req.url, 'http://x');
      const meta = opts.loraMetadata?.[u.searchParams.get('filename')];
      if (meta) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(meta));
      }
      res.writeHead(404); return res.end();
    }
    if (req.url.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(opts.viewImage ?? TINY_PNG);
      return;
    }
    if (req.url.startsWith('/object_info/')) {
      const nodeType = req.url.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (opts.objectInfo?.[nodeType]) {
        return res.end(JSON.stringify({ [nodeType]: opts.objectInfo[nodeType] }));
      }
      return res.end(JSON.stringify({}));
    }
    res.writeHead(404); res.end();
  });

  // Expose arrays on the server object for test assertions
  httpServer.uploads = uploads;
  httpServer.prompts = prompts;

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', ws => {
    setImmediate(() => {
      ws.send(JSON.stringify({ type: 'progress', data: { prompt_id: promptId, value: 5,  max: 10 } }));
      ws.send(JSON.stringify({ type: 'progress', data: { prompt_id: promptId, value: 10, max: 10 } }));
      ws.send(JSON.stringify({ type: 'executing', data: { prompt_id: promptId, node: null } }));
    });
  });

  return httpServer;
}

function makeVideoFakeComfyUI() {
  const promptId = 'test-video-prompt-001';
  const uploads  = [];
  const prompts  = [];

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/prompt') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        prompts.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: promptId }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/upload/image') {
      req.on('data', () => {});
      req.on('end', () => {
        uploads.push({ filename: 'uploaded.png' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'uploaded.png', subfolder: '', type: 'input' }));
      });
      return;
    }
    if (req.url.startsWith('/history/')) {
      const pid = req.url.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        [pid]: { outputs: { '9': { gifs: [{ filename: 'fake_video.mp4', subfolder: '', type: 'output', format: 'video/h264-mp4' }] } } },
      }));
      return;
    }
    if (req.url.startsWith('/view')) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from('fakemp4'));
      return;
    }
    if (req.url.startsWith('/object_info/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }
    res.writeHead(404); res.end();
  });

  httpServer.uploads = uploads;
  httpServer.prompts = prompts;

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', ws => {
    setImmediate(() => {
      ws.send(JSON.stringify({ type: 'progress', data: { prompt_id: promptId, value: 5,  max: 10 } }));
      ws.send(JSON.stringify({ type: 'progress', data: { prompt_id: promptId, value: 10, max: 10 } }));
      ws.send(JSON.stringify({ type: 'executing', data: { prompt_id: promptId, node: null } }));
    });
  });

  return httpServer;
}

// Sends a POST SSE request, collects all events until stream closes.
async function collectSSE(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const events  = [];
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      const eMatch = block.match(/^event: (.+)$/m);
      const dMatch = block.match(/^data: (.+)$/m);
      if (eMatch && dMatch) {
        try { events.push({ event: eMatch[1].trim(), data: JSON.parse(dMatch[1]) }); } catch {}
      }
    }
  }
  return events;
}

module.exports = { TINY_PNG, makeFakeOllama, makeFakeComfyUI, makeVideoFakeComfyUI, collectSSE };
