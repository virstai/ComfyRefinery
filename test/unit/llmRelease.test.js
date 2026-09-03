'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const llm = require('../../src/services/llm');

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, ...opts }); return { ok: status < 400, status }; };
  return { fn, calls };
}

test('unloadRequest: opt-in, method and body template', () => {
  assert.equal(llm.unloadRequest({ llmUnloadUrl: 'http://x/unload' }), null, 'disabled by default');
  assert.equal(llm.unloadRequest({ llmUnloadEnabled: true, llmUnloadUrl: '  ' }), null, 'needs a URL');
  assert.deepEqual(llm.unloadRequest({ llmUnloadEnabled: true, llmUnloadUrl: 'http://x/unload' }),
    { url: 'http://x/unload', method: 'GET', body: null });
  assert.deepEqual(llm.unloadRequest({ llmUnloadEnabled: true, llmUnloadUrl: 'http://x/api/generate', llmUnloadMethod: 'post', llmUnloadBody: '{"model":"{model}","keep_alive":0}', llmModel: 'gemma4:26b' }),
    { url: 'http://x/api/generate', method: 'POST', body: '{"model":"gemma4:26b","keep_alive":0}' });
  assert.equal(llm.unloadRequest({ llmUnloadEnabled: true, llmUnloadUrl: 'http://x/u', llmUnloadMethod: 'GET', llmUnloadBody: '{}' }).body, null, 'GET sends no body');
});

test('release: performs the configured call and reports failures without throwing', async () => {
  const off = fakeFetch();
  assert.equal(await llm.release({ llmUnloadUrl: 'http://x/unload' }, { fetchImpl: off.fn }), false);
  assert.equal(off.calls.length, 0);

  const ok = fakeFetch();
  assert.equal(await llm.release({ llmUnloadEnabled: true, llmUnloadUrl: 'http://x/unload' }, { fetchImpl: ok.fn }), true);
  assert.equal(ok.calls[0].method, 'GET');
  assert.equal(ok.calls[0].body, undefined);

  const post = fakeFetch();
  await llm.release({ llmUnloadEnabled: true, llmUnloadUrl: 'http://x/g', llmUnloadMethod: 'POST', llmUnloadBody: '{"model":"{model}"}', llmModel: 'm' }, { fetchImpl: post.fn });
  assert.equal(post.calls[0].method, 'POST');
  assert.equal(post.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(post.calls[0].body, '{"model":"m"}');

  const bad = fakeFetch(500);
  assert.equal(await llm.release({ llmUnloadEnabled: true, llmUnloadUrl: 'http://x/unload' }, { fetchImpl: bad.fn }), false);
  assert.equal(await llm.release({ llmUnloadEnabled: true, llmUnloadUrl: 'http://x/unload' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
});
