'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const provider = require('../../src/services/providers/openai');

let server, port;
let lastBody = null;
// Each element: an SSE data payload (object) the fake will stream.
let scriptedChunks = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of scriptedChunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(0, r));
  port = server.address().port;
});

after(() => new Promise(r => server.close(r)));

const cfg = () => ({ llmBaseUrl: `http://127.0.0.1:${port}/v1`, llmModel: 'm' });

const delta = d => ({ choices: [{ index: 0, delta: d, finish_reason: null }] });

test('without tools: returns plain string (back-compat)', async () => {
  scriptedChunks = [delta({ content: 'hello ' }), delta({ content: 'world' })];
  const out = await provider.chatStream(cfg(), [{ role: 'user', content: 'hi' }], null, {});
  assert.equal(out, 'hello world');
  assert.equal(lastBody.tools, undefined, 'tools must not be sent when not provided');
});

test('with tools: returns { text, toolCalls }, accumulating split argument deltas', async () => {
  scriptedChunks = [
    delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add_lora', arguments: '{"name":"a.saf' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'etensors","weight":0.8}' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'request_pose', arguments: '{}' } }] }),
  ];
  const tools = [{ type: 'function', function: { name: 'add_lora', parameters: {} } }];
  const out = await provider.chatStream(cfg(), [{ role: 'user', content: 'hi' }], null, { tools });
  assert.deepEqual(lastBody.tools, tools, 'tools forwarded in request body');
  assert.equal(out.text, '');
  assert.equal(out.toolCalls.length, 2);
  assert.deepEqual(out.toolCalls[0], { id: 'call_1', name: 'add_lora', args: { name: 'a.safetensors', weight: 0.8 } });
  assert.deepEqual(out.toolCalls[1], { id: 'call_2', name: 'request_pose', args: {} });
});

test('with tools but no tool calls: toolCalls is empty, text intact', async () => {
  scriptedChunks = [delta({ content: 'just a prompt' })];
  const out = await provider.chatStream(cfg(), [{ role: 'user', content: 'hi' }], null, {
    tools: [{ type: 'function', function: { name: 'add_lora', parameters: {} } }],
  });
  assert.equal(out.text, 'just a prompt');
  assert.deepEqual(out.toolCalls, []);
});

test('malformed tool arguments are dropped, valid ones kept', async () => {
  scriptedChunks = [
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'add_lora', arguments: '{broken' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'request_pose', arguments: '{}' } }] }),
  ];
  const out = await provider.chatStream(cfg(), [{ role: 'user', content: 'hi' }], null, {
    tools: [{ type: 'function', function: { name: 'add_lora', parameters: {} } }],
  });
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].name, 'request_pose');
});

test('tool and assistant tool_calls messages pass through to the API body', async () => {
  scriptedChunks = [delta({ content: 'final prompt' })];
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_lora', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'applied' },
  ];
  await provider.chatStream(cfg(), messages, null, {});
  assert.equal(lastBody.messages[1].tool_calls[0].id, 'c1');
  assert.equal(lastBody.messages[2].role, 'tool');
  assert.equal(lastBody.messages[2].tool_call_id, 'c1');
});
