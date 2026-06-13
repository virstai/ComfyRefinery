'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');
const agent  = require('../../src/services/agent');

let server, port;
let requestBodies = [];   // parsed body of every request, in order
let scripted      = [];   // per-request script: { content } or { toolCalls: [{ name, args }] }

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      requestBodies.push(JSON.parse(body));
      const step = scripted.shift() ?? { content: '' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (step.toolCalls) {
        step.toolCalls.forEach((c, i) => {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${requestBodies.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }] }, finish_reason: null }] })}\n\n`);
        });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: step.content }, finish_reason: null }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise(r => server.listen(0, r));
  port = server.address().port;
});

after(() => new Promise(r => server.close(r)));

beforeEach(() => { requestBodies = []; scripted = []; });

const cfg = () => ({ llmBaseUrl: `http://127.0.0.1:${port}/v1`, llmModel: 'm' });

const SYSTEM = { role: 'system', content: 'You write prompts.' };
const USER   = { role: 'user', content: 'a knight' };

function poseTool(state) {
  return {
    name:        'request_pose',
    description: 'Request a pose guide.',
    parameters:  { type: 'object', properties: { reason: { type: 'string' } }, required: [] },
    guidance:    'Call request_pose when a specific pose is implied.',
    execute(args) { state.wantsPose = true; state.reason = args?.reason; return 'Pose guide will be generated.'; },
  };
}

test('no tools: plain passthrough, no tools key sent, no guidance injected', async () => {
  scripted = [{ content: 'just a prompt' }];
  const out = await agent.run(cfg(), [SYSTEM, USER], [], {});
  assert.equal(out.text, 'just a prompt');
  assert.deepEqual(out.calls, []);
  assert.equal(requestBodies[0].tools, undefined);
  assert.equal(requestBodies[0].messages[0].content, 'You write prompts.');
});

test('guidance from active tools is appended to the system message', async () => {
  scripted = [{ content: 'prompt text' }];
  const state = {};
  await agent.run(cfg(), [SYSTEM, USER], [poseTool(state)], {});
  const sys = requestBodies[0].messages[0];
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /Call request_pose when a specific pose is implied\./);
  assert.match(sys.content, /^You write prompts\./, 'original content preserved');
  // Original message object not mutated
  assert.equal(SYSTEM.content, 'You write prompts.');
});

test('tool round: execute runs with parsed args, result threads back, final text returned', async () => {
  scripted = [
    { toolCalls: [{ name: 'request_pose', args: { reason: 'dynamic pose' } }] },
    { content: 'final prompt' },
  ];
  const state = {};
  const out = await agent.run(cfg(), [SYSTEM, USER], [poseTool(state)], {});

  assert.equal(state.wantsPose, true);
  assert.equal(state.reason, 'dynamic pose');
  assert.equal(out.text, 'final prompt');
  assert.deepEqual(out.calls, [{ name: 'request_pose', args: { reason: 'dynamic pose' } }]);

  // Second request must carry the assistant tool_calls message and the tool result
  const msgs = requestBodies[1].messages;
  const assistant = msgs.find(m => m.tool_calls);
  assert.ok(assistant, 'assistant tool_calls message present');
  assert.equal(assistant.tool_calls[0].function.name, 'request_pose');
  const toolMsg = msgs.find(m => m.role === 'tool');
  assert.equal(toolMsg.content, 'Pose guide will be generated.');
  assert.equal(toolMsg.tool_call_id, assistant.tool_calls[0].id);
});

test('unknown tool call: warning recorded, corrective result sent, loop continues', async () => {
  scripted = [
    { toolCalls: [{ name: 'mystery_tool', args: {} }] },
    { content: 'recovered prompt' },
  ];
  const out = await agent.run(cfg(), [SYSTEM, USER], [poseTool({})], {});
  assert.equal(out.text, 'recovered prompt');
  assert.deepEqual(out.calls, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /mystery_tool/);
  const toolMsg = requestBodies[1].messages.find(m => m.role === 'tool');
  assert.match(toolMsg.content, /Unknown tool/);
});

test('round cap: model keeps calling tools, fallback no-tools call produces the text', async () => {
  scripted = [
    { toolCalls: [{ name: 'request_pose', args: {} }] },
    { toolCalls: [{ name: 'request_pose', args: {} }] },
    { toolCalls: [{ name: 'request_pose', args: {} }] },
    { content: 'fallback prompt' },
  ];
  const out = await agent.run(cfg(), [SYSTEM, USER], [poseTool({})], { maxRounds: 3 });
  assert.equal(out.text, 'fallback prompt');
  assert.equal(requestBodies.length, 4);
  assert.equal(requestBodies[3].tools, undefined, 'fallback call carries no tools');
});

test('repeat calls each invoke execute (dedup is the tool handler\'s job)', async () => {
  scripted = [
    { toolCalls: [{ name: 'request_pose', args: {} }, { name: 'request_pose', args: {} }] },
    { content: 'done' },
  ];
  let count = 0;
  const tool = { ...poseTool({}), execute: () => { count++; return `ack ${count}`; } };
  const out = await agent.run(cfg(), [SYSTEM, USER], [tool], {});
  assert.equal(count, 2);
  assert.equal(out.calls.length, 2);
  assert.equal(out.text, 'done');
});
