'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module each describe block via inline require after clearing cache
function freshQueue() {
  const key = require.resolve('../../src/services/queue');
  delete require.cache[key];
  return require('../../src/services/queue');
}

describe('Queue', () => {
  test('enqueue runs a job and resolves with result', async () => {
    const q = freshQueue();
    const result = await q.enqueue({
      prompt: 'test', workflowId: 'wf', refCount: 0,
      runFn: async () => ({ outputImageUrl: '/api/image?filename=out.png' }),
    });
    assert.equal(result.outputImageUrl, '/api/image?filename=out.png');
    const state = q.getState();
    assert.equal(state.pending.length, 0);
    assert.equal(state.running, null);
    assert.equal(state.done.length, 1);
    assert.equal(state.done[0].status, 'done');
    assert.equal(state.done[0].outputImageUrl, '/api/image?filename=out.png');
  });

  test('jobs run sequentially, not concurrently', async () => {
    const q = freshQueue();
    const order = [];
    const p1 = q.enqueue({
      prompt: 'a', workflowId: 'wf', refCount: 0,
      runFn: async () => { order.push('a'); return {}; },
    });
    const p2 = q.enqueue({
      prompt: 'b', workflowId: 'wf', refCount: 0,
      runFn: async () => { order.push('b'); return {}; },
    });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ['a', 'b']);
  });

  test('second job is pending while first is running', async () => {
    const q = freshQueue();
    let unblock;
    const blocker = new Promise(r => { unblock = r; });
    q.enqueue({ prompt: 'a', workflowId: 'wf', refCount: 0, runFn: () => blocker });
    q.enqueue({ prompt: 'b', workflowId: 'wf', refCount: 0, runFn: async () => ({}) });

    await new Promise(r => setImmediate(r));
    const state = q.getState();
    assert.equal(state.running?.prompt, 'a');
    assert.equal(state.pending.length, 1);
    assert.equal(state.pending[0].prompt, 'b');
    unblock({});
  });

  test('cancel removes a pending job and rejects its promise', async () => {
    const q = freshQueue();
    let unblock;
    // Job 1 blocks the worker indefinitely
    q.enqueue({ prompt: 'a', workflowId: 'wf', refCount: 0, runFn: () => new Promise(r => { unblock = r; }) });
    // Job 2 will be pending while job 1 runs
    let rejected = false;
    const p2 = q.enqueue({
      prompt: 'b', workflowId: 'wf', refCount: 0,
      runFn: async () => ({}),
    }).catch(() => { rejected = true; });

    await new Promise(r => setImmediate(r));
    assert.equal(q.getState().pending.length, 1);

    const pendingId = q.getState().pending[0].id;
    const cancelled = q.cancel(pendingId);
    assert.ok(cancelled);

    await p2;
    assert.ok(rejected);
    assert.equal(q.getState().done[0].status, 'cancelled');
    unblock({});
  });

  test('cancel aborts a running job', async () => {
    const q = freshQueue();
    let pipelineAborted = false;
    const p = q.enqueue({
      prompt: 'a', workflowId: 'wf', refCount: 0,
      runFn: (signal) => new Promise((_, rej) => {
        signal.addEventListener('abort', () => { pipelineAborted = true; rej(new Error('aborted')); });
      }),
    }).catch(() => {});

    await new Promise(r => setImmediate(r));
    const { running } = q.getState();
    assert.ok(running);
    q.cancel(running.id);
    await p;
    assert.ok(pipelineAborted);
    assert.equal(q.getState().done[0].status, 'cancelled');
  });

  test('clientSignal abort cancels pending job', async () => {
    const q = freshQueue();
    let unblock;
    q.enqueue({ prompt: 'a', workflowId: 'wf', refCount: 0, runFn: () => new Promise(r => { unblock = r; }) });

    const ac = new AbortController();
    let rejectCalled = false;
    const p = q.enqueue({
      prompt: 'b', workflowId: 'wf', refCount: 0,
      signal: ac.signal,
      runFn: async () => ({}),
    }).catch(() => { rejectCalled = true; });

    await new Promise(r => setImmediate(r));
    ac.abort();
    await p;
    assert.ok(rejectCalled);
    assert.equal(q.getState().done[0].status, 'cancelled');
    unblock({});
  });

  test('clientSignal abort cancels running job', async () => {
    const q = freshQueue();
    let pipelineAborted = false;
    const ac = new AbortController();
    const p = q.enqueue({
      prompt: 'a', workflowId: 'wf', refCount: 0,
      signal: ac.signal,
      runFn: (signal) => new Promise((_, rej) => {
        signal.addEventListener('abort', () => { pipelineAborted = true; rej(new Error('aborted')); });
      }),
    }).catch(() => {});

    await new Promise(r => setImmediate(r));
    ac.abort();
    await p;
    assert.ok(pipelineAborted);
  });

  test('getState strips internal fields', async () => {
    const q = freshQueue();
    await q.enqueue({ prompt: 'a', workflowId: 'wf', refCount: 0, runFn: async () => ({}) });
    const { done } = q.getState();
    assert.ok(!('runFn'        in done[0]));
    assert.ok(!('resolve'      in done[0]));
    assert.ok(!('reject'       in done[0]));
    assert.ok(!('ac'           in done[0]));
    assert.ok(!('clientSignal' in done[0]));
  });

  test('runFn error sets status to error and rejects promise', async () => {
    const q = freshQueue();
    let caught;
    await q.enqueue({
      prompt: 'a', workflowId: 'wf', refCount: 0,
      runFn: async () => { throw new Error('pipeline failed'); },
    }).catch(err => { caught = err; });
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, 'pipeline failed');
    const { done } = q.getState();
    assert.equal(done[0].status, 'error');
    assert.equal(done[0].error, 'pipeline failed');
  });

  test('emits changed events on state transitions', async () => {
    const q = freshQueue();
    const statuses = [];
    q.on('changed', state => {
      if (state.done.length) statuses.push(state.done[0].status);
    });
    await q.enqueue({ prompt: 'a', workflowId: 'wf', refCount: 0, runFn: async () => ({}) });
    assert.ok(statuses.includes('done'));
  });
});
