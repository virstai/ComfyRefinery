import { reactive } from 'vue';
import { api } from '../api.js';

export const genState = reactive({
  status:     '',
  iterBadge:  '',
  sessionId:  null,
  loadedDesc: null,
  prompt:     '',
  references: [],
  running:         false,
  liveRunning:     false, // a broadcast job is actively in progress
  activeStepIndex: null,
  totalSteps:      0,
  activeStepLabel: '',
  activeStepPct:   0,
  steps:           [], // array of step objects, each with its own iterations[]
});

let _hasDirectStream = false;
let _livePaused      = false; // true while user views history; suppresses display updates

function blankIteration(n) {
  return {
    n,
    status:             '',
    streamingPrompt:    '',
    prompt:             null,
    progress:           0,
    imageUrl:           null,
    streamingReview:    '',
    fullReview:         null,
    diagnosis:          null,
    verdict:            null,
    humanPending:       false,
    aiVerdict:          null,
    aiDiagnosis:        null,
    humanFeedback:      null,
    acceptedPending:    false,
    gracePeriod:        null,
    graceMaxIterations: false,
    poseImageUrl:       null,
    loras:              null,
    warnings:           [],
  };
}

function blankStep(index) {
  return { index, type: '', label: '', iterations: [], outputImageUrl: null, videoUrl: null, progress: 0, status: '' };
}

function ensureStep(index) {
  while (genState.steps.length <= index) {
    genState.steps.push(blankStep(genState.steps.length));
  }
  return genState.steps[index];
}

function ensureIteration(stepIndex, n) {
  const step = ensureStep(stepIndex);
  while (step.iterations.length < n) {
    step.iterations.push(blankIteration(step.iterations.length + 1));
  }
  return step.iterations[n - 1];
}

export function handleEvent(event, data) {
  const si     = data.step ?? 0;
  const labels = { prompt_building: 'Building prompt…', generating: 'Generating…', reviewing: 'Reviewing…', posing: 'Generating pose guide…' };

  switch (event) {
    case 'session':
      genState.sessionId = data.id;
      genState.status    = data.resume ? 'Resuming session…' : 'Session started';
      if (!data.resume) genState.steps = [];
      break;

    case 'step': {
      const step  = ensureStep(data.index);
      step.type   = data.type;
      step.label  = data.label;
      genState.activeStepIndex = data.index;
      genState.totalSteps      = data.total ?? genState.steps.length;
      genState.activeStepLabel = data.label;
      genState.activeStepPct   = 0;
      // Clear any pending acceptance badges from previous steps
      for (let i = 0; i < data.index; i++) {
        const prev = genState.steps[i];
        if (prev) prev.iterations.forEach(it => { it.acceptedPending = false; });
      }
      break;
    }

    case 'history': {
      const it = ensureIteration(si, data.iteration);
      it.prompt    = data.prompt    ?? it.prompt;
      it.imageUrl  = data.imageUrl  ?? it.imageUrl;
      it.diagnosis = data.diagnosis ?? it.diagnosis;
      it.verdict   = data.verdict   ?? it.verdict;
      it.progress  = 100;
      it.status    = data.verdict ?? '';
      if (data.humanFeedback) it.humanFeedback = data.humanFeedback;
      it.poseImageUrl = data.poseImageUrl ?? it.poseImageUrl;
      it.loras        = data.loras        ?? it.loras;
      if (data.warnings) it.warnings = data.warnings;
      break;
    }

    case 'phase': {
      const it = ensureIteration(si, data.iteration);
      it.status           = labels[data.phase] || data.phase;
      genState.iterBadge  = `Step ${si + 1} · Iteration ${data.iteration}`;
      genState.status     = it.status;
      break;
    }

    case 'token': {
      const it = ensureIteration(si, data.iteration);
      if (data.phase === 'prompt') it.streamingPrompt += data.token;
      else                         it.streamingReview += data.token;
      break;
    }

    case 'prompt': {
      const it = ensureIteration(si, data.iteration);
      it.prompt          = data.prompt;
      it.streamingPrompt = '';
      break;
    }

    case 'progress': {
      const step = ensureStep(si);
      if (step.type === 'video') {
        step.progress = data.pct;
        step.status   = `Generating… ${data.pct}%`;
        if (si === genState.activeStepIndex) genState.activeStepPct = data.pct;
      } else {
        const it = ensureIteration(si, data.iteration);
        it.progress = data.pct;
        it.status   = `Generating… ${data.pct}%`;
        if (si === genState.activeStepIndex) genState.activeStepPct = data.pct;
      }
      break;
    }

    case 'preview': {
      const it = ensureIteration(si, data.iteration);
      if (!it.imageUrl || it.imageUrl.startsWith('data:')) it.imageUrl = data.url;
      break;
    }

    case 'image': {
      const it = ensureIteration(si, data.iteration);
      it.imageUrl = data.url; // replaces any preview data-URL with the real image URL
      break;
    }

    case 'pose': {
      const it = ensureIteration(si, data.iteration);
      it.poseImageUrl = data.url;
      break;
    }

    case 'warning': {
      const it = ensureIteration(si, data.iteration);
      it.warnings.push(data.message);
      break;
    }

    case 'video': {
      const step  = ensureStep(si);
      step.videoUrl = data.url;
      step.status   = 'Done';
      step.progress = 100;
      if (si === genState.activeStepIndex) genState.activeStepPct = 100;
      break;
    }

    case 'step_complete': {
      const step = ensureStep(si);
      if (data.imageUrl) step.outputImageUrl = data.imageUrl;
      if (data.videoUrl) step.videoUrl       = data.videoUrl;
      break;
    }

    case 'review': {
      const it = ensureIteration(si, data.iteration);
      it.fullReview      = it.streamingReview || null;
      it.diagnosis       = data.diagnosis;
      it.verdict         = data.verdict;
      it.streamingReview = '';
      it.status          = data.verdict;
      if (data.loras) it.loras = data.loras;
      break;
    }

    case 'human_review': {
      const it        = ensureIteration(si, data.iteration);
      it.humanPending = true;
      it.aiVerdict    = data.aiVerdict;
      it.aiDiagnosis  = data.aiDiagnosis;
      it.status       = 'Awaiting your review…';
      genState.status = `Step ${si + 1} · Iteration ${data.iteration}: human review required`;
      break;
    }

    case 'human_verdict': {
      const it         = ensureIteration(si, data.iteration);
      it.humanPending  = false;
      it.humanFeedback = data.feedback || null;
      it.status        = data.accepted
        ? 'Accepted by you'
        : data.feedback ? `Rejected — "${data.feedback}"` : 'Rejected — continuing…';
      break;
    }

    case 'accepted_pending': {
      const it = ensureIteration(si, data.iteration);
      it.acceptedPending    = true;
      it.gracePeriod        = data.gracePeriod;
      it.graceMaxIterations = !!data.maxIterations;
      it.humanReview        = !!data.humanReview;
      genState.status = data.maxIterations
        ? `Max iterations — ${data.gracePeriod}s to continue`
        : `Accepted — ${data.gracePeriod}s to refuse`;
      break;
    }

    case 'acceptance_refused': {
      const it = ensureIteration(si, data.iteration);
      it.verdict         = 'REFUSED';
      it.acceptedPending = false;
      it.status          = 'REFUSED';
      genState.status    = 'Acceptance refused — continuing…';
      break;
    }

    case 'done':
      genState.status    = data.accepted ? 'Accepted' : 'Done — max iterations reached';
      genState.iterBadge = '';
      genState.running   = false;
      genState.activeStepIndex = null;
      genState.totalSteps      = 0;
      genState.activeStepLabel = '';
      genState.activeStepPct   = 0;
      genState.steps.forEach(st => st.iterations.forEach(it => { it.acceptedPending = false; }));
      genState.loadedDesc = data.accepted ? null : (data.prompt || '');
      break;

    case 'stopped':
      genState.steps.splice(data.step ?? genState.steps.length - 1);
      genState.status    = 'Stopped';
      genState.iterBadge = '';
      genState.running   = false;
      genState.activeStepIndex = null;
      genState.totalSteps      = 0;
      genState.activeStepLabel = '';
      genState.activeStepPct   = 0;
      break;

    case 'error':
      genState.status    = `Error: ${data.message}`;
      genState.iterBadge = '';
      genState.running   = false;
      genState.activeStepIndex = null;
      genState.totalSteps      = 0;
      genState.activeStepLabel = '';
      genState.activeStepPct   = 0;
      break;
  }
}

export function readSSEStream(response, onDone) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  async function processBuffer() {
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop();
    for (const block of blocks) {
      const eMatch = block.match(/^event: (.+)$/m);
      const dMatch = block.match(/^data: (.+)$/m);
      if (!eMatch || !dMatch) continue;
      const event = eMatch[1].trim();
      try { handleEvent(event, JSON.parse(dMatch[1])); } catch { /* ignore */ }
      // Yield after preview events so Vue can flush + browser can paint before next event
      if (event === 'preview') await new Promise(r => requestAnimationFrame(r));
    }
  }

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        await processBuffer();
      }
    } finally {
      onDone?.();
    }
  })();
}

export async function startGeneration(prompt, references = []) {
  _hasDirectStream    = true;
  _livePaused         = false;
  genState.running    = true;
  genState.steps      = [];
  genState.loadedDesc = null;
  genState.status     = 'Starting…';
  genState.iterBadge  = '';

  const response = await fetch('/api/generate', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ prompt, references }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    genState.status  = `Error: ${err.error}`;
    genState.running = false;
    _hasDirectStream = false;
    return;
  }
  readSSEStream(response, () => { genState.running = false; _hasDirectStream = false; });
}

export async function continueSession(sessionId, references = []) {
  _hasDirectStream   = true;
  _livePaused        = false;
  genState.running   = true;
  genState.status    = 'Continuing session…';
  genState.iterBadge = '';

  const response = await fetch(`/api/generate/continue/${sessionId}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ references }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    genState.status  = `Error: ${err.error}`;
    genState.running = false;
    _hasDirectStream = false;
    return;
  }
  readSSEStream(response, () => { genState.running = false; _hasDirectStream = false; });
}

export async function loadSession(sessionId) {
  _livePaused        = true;  // pause live broadcast updates while viewing history
  genState.running   = false; // not displaying live content
  genState.status    = 'Loading session…';
  genState.iterBadge = '';
  genState.steps     = [];

  const session = await api('GET', `/api/generate/sessions/${sessionId}`);
  genState.sessionId  = session.id;
  genState.loadedDesc = session.prompt;
  genState.prompt     = session.prompt ?? '';
  genState.references = session.references?.length ? [...session.references] : [];

  for (let si = 0; si < (session.steps ?? []).length; si++) {
    const step = session.steps[si];
    handleEvent('step', { index: si, type: step.type, label: step.label, total: session.steps.length });
    if (step.type === 'video') {
      if (step.outputVideoUrl) handleEvent('video', { step: si, url: step.outputVideoUrl });
    } else {
      for (let i = 0; i < step.iterations.length; i++) {
        handleEvent('history', { step: si, ...step.iterations[i], iteration: i + 1 });
      }
    }
  }

  const totalIter = (session.steps ?? []).reduce((sum, st) => sum + st.iterations.length, 0);
  const accepted  = (session.steps ?? []).some(st => st.iterations.some(it => it.verdict === 'ACCEPT'));
  genState.status = `Loaded — ${totalIter} iteration${totalIter !== 1 ? 's' : ''} (${accepted ? 'accepted' : 'not accepted'})`;
  genState.activeStepIndex = null;
  genState.totalSteps      = 0;
  genState.activeStepLabel = '';
  genState.activeStepPct   = 0;
  return session;
}

export function returnToLive() {
  _livePaused      = false;
  genState.steps   = [];
  genState.status  = '';
  genState.running = true;
}

export async function submitHumanReview(sessionId, stepIndex, accept, feedback) {
  await api('POST', `/api/generate/human-review/${sessionId}`, { stepIndex, accept, feedback });
}

export async function refuseAccepted(sessionId, stepIndex, iterationN) {
  await api('POST', `/api/generate/sessions/${sessionId}/refuse-accepted`, { stepIndex, iterationN });
  const step = genState.steps[stepIndex];
  if (step) {
    const it = step.iterations.find(it => it.n === iterationN);
    if (it && it.verdict === 'ACCEPT') {
      it.verdict         = 'REFUSED';
      it.acceptedPending = false;
      it.status          = 'REFUSED';
    }
  }
}

export async function killGeneration() {
  if (!genState.sessionId) return;
  await api('POST', '/api/generate/kill', { sessionId: genState.sessionId });
}

export function clearSession() {
  _livePaused         = false;
  genState.sessionId  = null;
  genState.loadedDesc = null;
  genState.prompt     = '';
  genState.references = [];
  genState.steps      = [];
  genState.status     = '';
  genState.iterBadge  = '';
  genState.activeStepIndex = null;
  genState.totalSteps      = 0;
  genState.activeStepLabel = '';
  genState.activeStepPct   = 0;
}

export function connectToBroadcast() {
  async function connect() {
    try {
      const response = await fetch('/api/generate/events');
      if (!response.ok) return;

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop();
        for (const block of blocks) {
          if (_hasDirectStream) continue;
          const eMatch = block.match(/^event: (.+)$/m);
          const dMatch = block.match(/^data: (.+)$/m);
          if (!eMatch || !dMatch) continue;
          try {
            const event = eMatch[1].trim();
            const data  = JSON.parse(dMatch[1]);
            if (event === 'session' && !data.resume) {
              // New job always takes over — clears any paused history view
              genState.liveRunning = true;
              _livePaused          = false;
              genState.running     = true;
              genState.steps       = [];
              genState.iterBadge   = '';
              genState.loadedDesc  = null;
            } else if (event === 'done' || event === 'stopped' || event === 'error') {
              genState.liveRunning = false;
            }
            if (!_livePaused) handleEvent(event, data);
          } catch { /* ignore */ }
        }
      }
    } catch { /* connection lost */ } finally {
      // If a live job was in progress when the connection dropped, clear the stale state
      if (genState.liveRunning) {
        genState.liveRunning     = false;
        genState.running         = false;
        genState.steps           = [];
        genState.status          = 'Connection lost';
        genState.iterBadge       = '';
        genState.activeStepIndex = null;
        genState.totalSteps      = 0;
        genState.activeStepLabel = '';
        genState.activeStepPct   = 0;
      }
      setTimeout(connect, 3000);
    }
  }
  connect();
}
