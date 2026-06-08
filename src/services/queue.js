'use strict';

const { EventEmitter } = require('events');
const { v4: uuidv4 }  = require('uuid');

const MAX_DONE = 100;

function jobSnapshot(job) {
  return {
    id:             job.id,
    status:         job.status,
    prompt:         job.prompt,
    workflowId:     job.workflowId,
    refCount:       job.refCount,
    queuedAt:       job.queuedAt,
    startedAt:      job.startedAt,
    finishedAt:     job.finishedAt,
    outputImageUrl: job.outputImageUrl,
    error:          job.error,
  };
}

class Queue extends EventEmitter {
  constructor() {
    super();
    this.pending = [];
    this.running = null;
    this.done    = [];
  }

  getState() {
    return {
      pending: this.pending.map(jobSnapshot),
      running: this.running ? jobSnapshot(this.running) : null,
      done:    this.done.map(jobSnapshot),
    };
  }

  enqueue({ prompt, workflowId, refCount = 0, runFn, signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(new Error('Cancelled: client disconnected'));
    }

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

    const job = {
      id:             uuidv4(),
      status:         'pending',
      prompt,
      workflowId,
      refCount,
      queuedAt:       new Date().toISOString(),
      startedAt:      null,
      finishedAt:     null,
      outputImageUrl: null,
      error:          null,
      runFn,
      resolve,
      reject,
      ac:             null,
      clientSignal:   signal ?? null,
    };

    if (signal) {
      signal.addEventListener('abort', () => {
        const idx = this.pending.indexOf(job);
        if (idx !== -1) {
          this.pending.splice(idx, 1);
          job.status     = 'cancelled';
          job.finishedAt = new Date().toISOString();
          this.done.push(job);
          this.emit('changed', this.getState());
          job.reject(new Error('Cancelled: client disconnected'));
        }
      }, { once: true });
    }

    this.pending.push(job);
    this.emit('changed', this.getState());
    this._processNext();
    return promise;
  }

  cancel(id) {
    const idx = this.pending.findIndex(j => j.id === id);
    if (idx !== -1) {
      const [job] = this.pending.splice(idx, 1);
      job.status     = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.done.push(job);
      this.emit('changed', this.getState());
      job.reject(new Error('Cancelled'));
      return true;
    }
    if (this.running?.id === id) {
      this.running.ac?.abort();
      return true;
    }
    return false;
  }

  async _processNext() {
    if (this.running || !this.pending.length) return;

    const job     = this.pending.shift();
    job.status    = 'running';
    job.startedAt = new Date().toISOString();
    job.ac        = new AbortController();

    if (job.clientSignal) {
      job.clientSignal.addEventListener('abort', () => {
        job.ac?.abort();
      }, { once: true });
    }

    this.running = job;
    this.emit('changed', this.getState());

    try {
      const result       = await job.runFn(job.ac.signal);
      job.status         = 'done';
      job.outputImageUrl = result?.outputImageUrl ?? null;
      job.finishedAt     = new Date().toISOString();
      job.resolve(result);
    } catch (err) {
      job.status     = job.ac.signal.aborted ? 'cancelled' : 'error';
      job.error      = err.message;
      job.finishedAt = new Date().toISOString();
      job.reject(err);
    } finally {
      this.done.push(job);
      if (this.done.length > MAX_DONE) this.done.splice(0, this.done.length - MAX_DONE);
      this.running = null;
      this.emit('changed', this.getState());
      this._processNext();
    }
  }
}

module.exports = new Queue();
