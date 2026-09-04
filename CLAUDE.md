# ComfyRefinery — Developer Notes

## What this is

ComfyRefinery is a workflow orchestration layer on top of ComfyUI. A prompt (and 0–N
reference images) flows through a saved, reusable **Workflow** — a linear chain of
model-agnostic steps (generate → upscale → …) — each step AI-reviewed and optionally
human-reviewed. It uses an OpenAI-compatible LLM interface so any provider (Ollama,
OpenAI, LM Studio, etc.) can be pointed at via `llmBaseUrl` in settings.

## Running

```bash
npm start              # production (serve public/)
npm run dev            # API --watch + Vite hot-reload UI
npm test               # all 395 tests
npm run ui:build       # compile Vue → public/
```

API on :3000, Vite dev on :5173. **Always stop the dev server on port 3000 after test runs.**

---

## Architecture

### Two entities

**Model** (`cfg.models[id]`) — thin asset grouping, loader fields only.
```jsonc
{
  "id": "sdxl-base", "label": "SDXL Base", "architecture": "sdxl",
  "checkpoint": "sdXL_v10.safetensors", "vae": "sdxl_vae.safetensors"
  // split-load archs (flux, flux2): unetName, clipL, t5xxl, clipName, vaeName
  // sdxl: useRefiner, refinerCheckpoint
  // sd15/sdxl with adapter: adapterModel, clipVisionModel, adapterWeight
  // sd15/sdxl tile CN: tileControlNetModel (weights from models/controlnet/)
  // sd15/sdxl structural CN: structuralControlNetModel (weights from models/controlnet/)
  //   → use Illustrious-native CNs: illustriousXLv0.1_depth_midas_fp16.safetensors,
  //     illustriousXLv0.1_Softedge_fp16.safetensors (MIC-Lab, Apache 2.0, HuggingFace)
  //   → must match checkpoint prediction type: Illustrious v0.1 = eps, v3+ = v-pred
  // anima with pose controlnet: controlNetModel (LLLite weights from models/controlnet/)
  // flux with adapter: adapterModel (redux model), clipVisionModel
  // flux2: no adapter fields (native ReferenceLatent, no external model needed)
  // optional per-component placement (needs ComfyUI-MultiGPU in ComfyUI): 'cpu' | 'cuda:N'; absent = auto
  "devices": { "clip": "cuda:1", "vae": "cuda:1", "audioVae": "cuda:1" }
}
```

**Device placement (multi-GPU).** `src/workflows/lib/devicePlacement.js` runs as a post-pass in
`buildWorkflow`: for each role in `model.devices` (`unet`, `clip`, `vae`, `audioVae`, `clipVision`,
`controlNet`) it swaps the native loader (`UNETLoader`, `CheckpointLoaderSimple`, `CLIPLoader`/`Dual`/`Triple`/`Quadruple`,
`VAELoader`, `CLIPVisionLoader`, `ControlNetLoader`) for its `…MultiGPU` twin with a `device` input, so
arch builders never know about it. The audio VAE is told apart from the video VAE by `audioVaeName`.
`comfyui.getDevices()` reads `/system_stats` (only GPUs visible to ComfyUI's process appear — set
`HIP_VISIBLE_DEVICES` / `CUDA_VISIBLE_DEVICES` or `--cuda-device` accordingly) and `getAssets()` returns
`devices` + `multiGpu` (probe: `UNETLoaderMultiGPU`). ModelEditor shows a device dropdown beside each loader
field only when the pack is present; `config.saveModel` drops `auto` entries. Queuing a graph with MultiGPU
nodes when the pack is missing fails with a clear error. Intended use: keep the UNet on the compute GPU and
push text encoder / VAEs to a second card or CPU so the UNet and its activations get the whole card.

**Workflow** (`cfg.workflows[id]`) — the driver. Owns skill + notes, gen params,
reference strategy, ordered steps, per-step review. **Active-selected entity.**
```jsonc
{
  "id": "portrait-4x", "label": "Portrait → 4x",
  "steps": [
    {
      "type": "generate", "modelId": "sdxl-base",
      "params": { "width": 1024, "height": 1024, "steps": 30, "cfgScale": 7,
                  "sampler": "dpmpp_2m", "scheduler": "karras", "negativePrompt": "...",
                  "refinerSwitchAt": 0.8 },
      "referenceStrategy": {
        "visionNotes": true,
        "diffusion": { "mode": "init-image", "denoise": 0.6 }
      },
      "loras":    [{ "name": "anima_turbo.safetensors", "weight": 1.0 }],
      "llmLoras": true,
      "controlNet": { "poseMode": "auto", "strength": 1.0 },
      "review": { "maxIterations": 4, "humanReview": false, "gracePeriod": 10 }
    },
    {
      "type": "upscale", "upscaleType": "model",
      "upscaleModel": "4x-UltraSharp.pth", "factor": 4,
      "review": { "maxIterations": 1, "humanReview": true, "gracePeriod": 0 }
    }
  ]
}
```

Cross-model style transfer example (Flux 2 Klein composition → Illustrious SDXL style):
```jsonc
{
  "id": "klein-to-sdxl", "label": "Klein → Illustrious",
  "steps": [
    {
      "type": "generate", "modelId": "flux-2-klein",
      "params": { "width": 1024, "height": 1024, "steps": 28 },
      "referenceStrategy": { "visionNotes": false, "diffusion": { "mode": "txt2img" } },
      "review": { "maxIterations": 3, "humanReview": false }
    },
    {
      "type": "generate", "modelId": "illustrious-sdxl",
      // chainStrategy: how to consume the previous step's output
      "chainStrategy": { "mode": "structural", "preprocessor": "depth", "strength": 0.9 },
      // referenceStrategy still applies to user-uploaded refs independently
      "referenceStrategy": { "visionNotes": false, "diffusion": { "mode": "txt2img" } },
      "params": { "width": 1024, "height": 1024, "steps": 30, "cfgScale": 7 },
      "review": { "maxIterations": 3, "humanReview": true }
    }
  ]
}
```

Generate step LoRA / ControlNet fields:
- `loras` — always-on LoRA list applied to every iteration: `[{ name, weight }]`.
- `llmLoras` — `true` enables LLM tool calling; LLM may call `add_lora` / `request_pose` via the agent loop (`src/services/agent.js`, bounded 3 rounds). Each tool carries its own system-prompt guidance, so the prompt adapts to whichever tools the step's settings enable — local models won't call tools from schemas alone. Selected LoRAs are recorded on the iteration.
- `controlNet` — `{ poseMode, strength }`. The ControlNet weights file lives on the generation model's settings (`models[id].controlNetModel`; legacy step-level `controlNetModel` still read as fallback) — the workflow step only enables and tunes the pose. `poseMode`: `"off"` (disabled), `"auto"` (LLM-triggered via `request_pose`), `"always"` (unconditional). When active, a pose pre-pass runs (`src/services/pose.js`): a draft is rendered with the step's own generation model **from a detection-friendly prompt** — the `request_pose` tool supplies a plain physical pose description (fallback: the raw user prompt) which is wrapped in a template adding plain background and photographic rendering with an anti-crop/anti-flat-style negative. Framing follows the description (upper-body and multi-subject poses are supported); the agent's guidance prefers head-to-toe stances since they extract most reliably. The styled image prompt is never used for the draft (style terms defeat the detector). Strength below ~1.0 lets the prompt's own composition override the pose — default is 1.0. DWPreprocessor extracts the skeleton in the same ComfyUI graph; it's re-uploaded as input for the main generation. The pre-pass is architecture-agnostic (any model can draft; the skeleton suits any pose ControlNet). **Failure is fatal**: when a pose is wanted but cannot be produced (missing nodes/config, or an all-black skeleton, checked via `src/lib/png.js`), the step errors out rather than silently generating without pose control. ControlNet apply is anima-only for now (other archs ignore this field).
- Per-arch support for LoRA / adapter / ControlNet is declared in `ARCH_META[arch].capabilities`
  (`src/workflows/index.js`) — the workflow editor hides unsupported sections, `generate.js` gates
  adapter routing + the `add_lora` tool on it, and pose mode on a non-controlNet arch fails the
  step with an error. Anima's `adapter` is `false` until the IP-Adapter weights are released.

  | Capability | sd15 | sdxl | flux | flux2 | anima | zimage | krea2 | wanvideo |
  |---|---|---|---|---|---|---|---|---|
  | `lora` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
  (minimaxh3 and ltxvideo also declare `lora: true` — DiT-only `LoraLoaderModelOnly` chains after the turbo / distilled LoRA; video steps pass `stepDef.loras`, Film segments `segment.loras`.)
  | `adapter` | ✓ | ✓ | ✓ | ✓ | — (disabled) | — | — | — |
  | `controlNet` (pose, LLLite) | — | — | — | — | ✓ | — | — | — |
  | `tileControlNet` | ✓ | ✓ | — | — | — | — | — | — |
  | `structuralControlNet` | ✓ | ✓ | — | — | — | — | — | — |

`chainStrategy` — how to consume the previous step's output (only active on non-first steps):
- `{ mode: "txt2img" }` — drop the chained image; generate from noise only
- `{ mode: "init-image", denoise }` — chained image as VAEEncode init at `denoise` (default 0.5)
- `{ mode: "adapter" }` — chained image via IPAdapter/Redux/ReferenceLatent (same routing as refs)
- `{ mode: "tile", tileStrength, denoise }` — tile ControlNet on chained image; **also sets initImage** so the sampler starts from real content not random noise (without init, tile CN vs empty latent produces black images). Requires `tileControlNetModel` on the model config. Supported: sd15, sdxl.
- `{ mode: "structural", preprocessor, strength }` — **cross-model composition transfer**: runs an inline preprocessor (depth map, soft edges, etc.) on the chained image, then applies the result as ControlNet guidance while the step generates as pure txt2img (no init image). This lets the second model (e.g. Illustrious SDXL) express its own full aesthetic while respecting only the composition from the first (e.g. Flux 2 Klein). `preprocessor`: `"depth"` (MiDaS), `"softedge"` (HED), `"lineart_realistic"`, `"lineart_anime"`, `"canny"`. Requires `structuralControlNetModel` on the model config. Supported: sd15, sdxl. Falls through to txt2img if the model is not set.

`referenceStrategy.diffusion` — `{ mode, denoise? }` — how to use user-uploaded refs:
- `mode: "txt2img"` — ignore refs for diffusion (still used for vision notes)
- `mode: "init-image"` — refs[0] as init image at `denoise`
- `mode: "adapter"` — IPAdapter (sd15/sdxl), Redux (flux), or native ReferenceLatent (flux2)

The WorkflowEditor exposes both as a single **Image inputs** mode dropdown — the same modes apply to chain and refs since they're consumed identically.

Back-compat: old `{ none, one, many }` format is read transparently.

Skill + notes live in `data/skills/<workflowId>.json`, keyed by workflow ID.

### Session data model
```jsonc
{
  "id": "...", "prompt": "...",
  "workflowId": "portrait-4x", "workflowLabel": "Portrait → 4x",
  "references": [{ "filename": "ref.png", "subfolder": "", "type": "input" }],
  "steps": [
    { "type": "generate", "label": "SDXL Base", "modelId": "sdxl-base",
      "iterations": [ { "prompt": "...", "imageUrl": "...", "verdict": "ACCEPT", "diagnosis": "...",
                        "seed": 1234567890,  // sampling seed, recorded for reproducibility
                        "loras": [{ "name": "anima_turbo.safetensors", "weight": 1.0, "source": "step" }],  // source: "step" | "llm"
                        "poseUsed": true, "poseImageUrl": "/api/image?...",
                        "warnings": ["DWPreprocessor not found — skipping pose"] } ],  // optional, only when non-empty
      "selectedIteration": null,  // 1-based user pick of which variant feeds the next step; null = latest
      "outputImageUrl": "/api/image?..." },
    { "type": "upscale", "label": "4x-UltraSharp.pth ×4",
      "iterations": [ { "imageUrl": "...", "verdict": "ACCEPT", "diagnosis": "..." } ],
      "outputImageUrl": "/api/image?..." },
    // session video steps may carry `steering`: director's notes for the *next take* (framing, camera, pacing,
    // sound), set from the run view (PUT /sessions/:id/steps/:index/steering) — a reaction to what earlier
    // steps produced, so it lives on the session, never the workflow. video.js appends it to the prompt request.
    { "type": "video", "label": "LTX 2.3 ×97f @ 24fps", "modelId": "ltx-2-3", "steering": "slow push-in; sound: rain only",
      // each run of a video step appends a "take" (variant) — no review loop
      "iterations": [ { "prompt": "...", "videoUrl": "/api/video?...", "verdict": "ACCEPT", "diagnosis": "video step (no review)" } ],
      "outputVideoUrl": "/api/video?..." }
  ],
  // Ad-hoc steps appended in the UI (e.g. "Make video" on any image variant). They run after the
  // workflow's steps; `inputFrom` names the step whose output they build on.
  "extraSteps": [ { "type": "video", "modelId": "ltx-2-3", "params": {}, "inputFrom": 0 } ],
  "status": "complete" | "stopped" | "error", "createdAt": "..."
}
```

### Step replay & variants
Iterations double as **variants**: `POST /api/generate/rerun/:id` `{ fromStep, toStep? }` re-runs
only steps `fromStep..toStep` (SSE stream like `/continue`, full history replayed first). Earlier
steps keep their outputs — the run chains from `stepOutput(steps[fromStep-1])`, which honors
`selectedIteration`. `fromStep === toStep` redoes one step, appending a new iteration/take.
`POST /api/generate/sessions/:id/select` `{ stepIndex, iteration }` picks which variant feeds
downstream steps (recomputes `outputImageUrl`/`outputVideoUrl`); a fresh run of a step clears its
selection. `PUT /api/generate/sessions/:id/steps/:index/steering` `{ steering }` sets a video step's
director's notes for its next take (RunSection textarea; allowed while running). `POST /api/generate/sessions/:id/steps` `{ type: 'video', modelId, params?, inputFrom, iteration?, steering? }`
appends an ad-hoc video step (`session.extraSteps`) that animates `inputFrom`'s image and returns its
`stepIndex` — the UI then calls `/rerun { fromStep: stepIndex }`. A session's pipeline on re-run is
`sessionPipeline()`: the current workflow steps followed by `extraSteps`, so workflow edits still apply
while the extra steps persist. Only video steps can be added this way for now. `/continue` is now `rerun` with `fromStep: 0`. A kill only discards iterations added by
the current run. UI: per-step **↻ Redo** / **▶ From here** buttons (RunSection), `Output` badge on
the effective variant (IterationCard), prev/next variant navigation + **Use as step output** +
**🎬 Make video** (video-model picker, any accepted image variant) in DetailPane.

### Film (long video from chained takes)
A separate mode from Generate: **no workflows, no steps, no sessions, no review loop.** A **Project**
(`data/projects/<id>.json` + `data/projects/<id>/{clips,refs,export}/`, `PROJECTS_DIR` override) pins a raw
model entry (`cfg.models[modelId]`, must have `ARCH_META[arch].film` — minimaxh3, and ltxvideo in `continue` mode only: no
reference-to-video, so the Cut mode is disabled in the UI and `addSegment(p, fields, cfg)` defaults new segments to `continue`;
`ARCH_META[arch].filmFrames` seeds `gen.frames`, 124 for H3 and 121 for LTX) and carries its own
generation settings (`format { width, height, fps }`, reframable at any time — clips keep their size and export
re-encodes mixed sizes; FilmSetup offers width×height as **presets** from `filmFormats(arch)` in `src/workflows/index.js`
— `ARCH_META[arch].filmFormats` when declared (minimaxh3: landscape/portrait/square, short edge ≤ 768, /32), else standard
aspects fitted to the arch's default budget and grid; served on `GET /api/sessions/architectures` for Film archs; `modelId` locks once a take is approved; `gen { frames, steps, sampler, refImageSize }`). The film grows one **segment** at a time; each segment runs one ComfyUI job per **take**
and the user approves one take before moving on. Takes are downloaded into the project folder and their last
frame extracted, so a film never depends on ComfyUI's `output/`.

- **Start mode per segment** (`segment.start.mode`) — forced by the H3 nodes, which cannot be combined in one graph:
  `continue` (FL2VA, `first_frame` = previous approved take's last frame, or a bank image for segment 1;
  bank images only inform the LLM), `cut` (Ref2VA: bank images as `<Picture i>`, voice clips as `<Audio j>`,
  optionally the previous take's tail as `<Video 1>` with its soundtrack via `start.includePrevTail`),
  `bridge` (builder wires `last_frame`; the route still 400s — next iteration).
- **Reference bank** (`project.refs[]`): `{ kind: character|location|prop|style|voice|scene, name, description, pinned, media[] }`.
  Media come from uploads, a Generate session image (`source.type: 'session'`), **stills generated in place**
  (`POST /api/projects/:id/images/generate` SSE `{ modelId, prompt, negativePrompt?, width?, height?, steps?, cfgScale?,
  seed?, refId? | newRef?, segmentId? }` — any non-video model via `buildWorkflow` + arch defaults, size fitted to the
  film's aspect; `filmRunner.generateImage`; `POST /:id/images/prompt` SSE `{ modelId, intent, steering?, segmentId? }`
  writes the arch-specific prompt from a plain description with the Generate step's prompt writer
  (`steps/generate.buildInitialMessages` + the model's skill/notes) plus `buildImageContext` (logline, beats, purpose,
  the segment's selected refs as vision); with `segmentId` the still becomes that segment's `start.startImage` and
  the segment switches to `continue`; `source.type: 'generate'`), or **captures from a take**
  (`POST /api/projects/:id/takes/:tid/capture { frame: t }` / `{ audio: [a, b] }` via ffmpeg). Pinned entries are
  pre-selected on new segments. Descriptions are quoted verbatim to the prompt writer. An explicit `start.startImage`
  wins over the previous take's last frame in `continue` mode (the user chose it).
- **Prompt writer**: `filmRunner.writeFilmPrompt` = `steps/video.buildVideoMessages` + the arch's default skill
  (`skills.getSummary(modelId, arch)`) + `buildFilmContext` (logline, script beats, `<Picture/Video/Audio>` roles,
  mode hint) + `buildAttemptsContext` (the segment's earlier takes with verdicts and notes — a rejection note is
  the priority for the next prompt; the last rejected take's last frame is attached as vision) + vision images
  from local files; `refineVideoPrompt` streams tokens. The written or edited prompt is persisted as
  `segment.promptDraft` (the `/prompt` route stores it, the UI saves edits debounced) and `/run` uses it verbatim
  until cleared. Segments carry `loras: [{ name, weight }]` (per-segment scene/style/motion LoRAs, recorded on the take). Approving a take appends a
  one-line **beat** to `project.script` (`llm.chat`), marks later segments that already have takes `stale`,
  and appends a fresh draft segment when none follows.
- **Runtime**: `src/services/filmRunner.js` (`resolveInputs` → `writeFilmPrompt` → `videoTake.generateTake` →
  `comfyui.downloadOutput` → `ffmpeg.probe`/`extractLastFrame` → `projects.addTake`), `src/services/projects.js`
  (persistence + entity ops), `src/services/ffmpeg.js` (host `ffmpeg`/`ffprobe`; `FFMPEG_PATH`/`FFPROBE_PATH`;
  `detect()` feeds the System page as `tools.ffmpeg` and gates the Film routes), `src/services/videoTake.js`
  (the ComfyUI-job half of a video take, shared with `runVideoStep`). Routes: `src/routes/projects.js`
  (`/api/projects`, one run per project, 409 on mutations while running, `POST /:id/kill`, local media served at
  `GET /:id/media/<rel>`). Run SSE: `take_start`, `phase` (`prompt_building` | `generating` | `saving`), `token`,
  `prompt`, `progress`, `warning`, `video`, `take_complete { take }`, `done { take }`, `stopped`, `error`.
  Export = `ffmpeg.concat` of approved, non-stale takes → `export/export.mp4`. On boot, segments left `running`
  are reset to `draft`.
- **UI**: `ui/src/stores/film.js` (incl. `filmState.preview` — what the stage shows: a take's video or an image,
  set by segment selection, take thumbnails, reference media, generated stills, export; `filmState.playlist` —
  "▶ Play timeline" plays the approved takes back to back in the preview, client-side, no export needed) and `ui/src/components/film/*`
  laid out like a video editor: preview stage on top, contextual inspector on the right, fixed timeline strip at the
  bottom, Setup and References as slide-over drawers; route `#/film[/<projectId>]`.

### SSE events
All events carry `step` (0-indexed). Full event list:

| Event | Payload | Notes |
|---|---|---|
| `session` | `{ id, prompt, resume? }` | First event; client sets sessionId |
| `step` | `{ index, type, label, total, steering? }` | Start of each pipeline step; `steering` = the session step's current notes (video steps, also on replay) |
| `phase` | `{ step, phase, iteration }` | `prompt_building`, `posing`, `generating`, `reviewing` |
| `token` | `{ step, iteration, phase, token }` | LLM streaming token |
| `prompt` | `{ step, iteration, prompt }` | Final built prompt |
| `progress` | `{ step, iteration, pct }` | ComfyUI sampling progress 0–100 |
| `preview` | `{ step, iteration, url }` | Base64 data URL from ComfyUI WS binary frame |
| `image` | `{ step, iteration, url }` | Final image URL after generation |
| `review` | `{ step, iteration, verdict, diagnosis, loras?, poseUsed? }` | AI review result; `loras`/`poseUsed` present when LLM chose them |
| `human_review` | `{ step, iteration, aiVerdict, aiDiagnosis }` | Awaiting human decision |
| `human_verdict` | `{ step, iteration, accepted, feedback }` | Human decision received |
| `accepted_pending` | `{ step, iteration, gracePeriod, humanReview, maxIterations? }` | Grace period started |
| `acceptance_refused` | `{ step, iteration }` | User refused during grace period |
| `pose` | `{ step, iteration, url }` | Extracted pose skeleton image URL (DWPreprocessor output) |
| `warning` | `{ step, iteration, message }` | Non-fatal warning (e.g. pose pre-pass failed) |
| `video` | `{ step, iteration, url }` | Final video URL for a video-step take |
| `step_complete` | `{ step, imageUrl?, videoUrl?, accepted, selectedIteration }` | Step finished; pipeline stops if `!accepted`. `selectedIteration` is `null` after a fresh run (the client mirrors it) |
| `done` | `{ accepted, imageUrl?, videoUrl?, sessionId, prompt, iterations }` | Pipeline complete |
| `stopped` | `{ step, keptIterations, selectedIteration }` | User clicked Stop; the client truncates the step to `keptIterations` (everything the stopped run added is discarded server-side, verdicted or not) |
| `error` | `{ message }` | Unexpected pipeline error |
| `history` | `{ step, ...iteration, selected? }` | Replayed on `/continue` and `/rerun`; carries `videoUrl`/`seed` when present, `selected: true` on the chosen variant |

`pendingReviews` / `pendingAcceptances` keyed by `"${sessionId}:${stepIndex}"`.

### LLM abstraction
All LLM calls through `src/services/llm.js`:
- `llm.chatStream(cfg, messages, onToken, options?)` — streaming; `options.signal` aborts the fetch; `options.tools` passes an OpenAI-format tool array. When `tools` are present the call returns `{ text, toolCalls }` (where `toolCalls` is an array of `{ id, name, args }` objects with `args` JSON-parsed) rather than a plain string.
- `llm.chat(cfg, messages)` — non-streaming (skill refresh)
- `llm.listModels(cfg)` → `string[]` — enumerate model IDs

Single provider `'openai'` in `src/services/providers/openai.js` — speaks the
OpenAI `/v1/chat/completions` API. Works with Ollama, real OpenAI, LM Studio, vLLM, etc.

Messages with `images: [base64, ...]` are converted to OpenAI content-array format.
Back-compat: existing configs with `ollamaUrl` are migrated automatically.

### Step registry
`src/steps/index.js` — `get(type)` → step module.
`src/steps/generate.js` — generate step: LLM prompt build, vision notes, adapter/img2img routing, review.
`src/steps/upscale.js` — upscale step: model upscaler (ESRGAN) or hires fix (re-diffusion).
`src/steps/video.js` — video step: T2V / I2V / R2V routing, uploads init image, delegates to wanvideo (or other video arch). **I2V aspect-ratio follow**: on archs with `ARCH_META[arch].followInputAspect: true` (all video archs except cogvideox, whose weights are fixed 720×480), when the step doesn't pin both width and height the video dimensions are derived from the input image's aspect ratio — fitted to the arch's default pixel budget, rounded to `ARCH_META[arch].dimMultiple` (16 wan/hunyuan, 32 minimaxh3, 64 ltx — twice its /32 latent grid because the two-stage recipe samples at half size), and with neither edge exceeding the default long edge (`fitToBudget`'s `maxDim`) via `src/lib/imageSize.js` (dependency-free PNG/JPEG/WebP dimension reader + `fitToBudget`). A single explicitly set dimension is kept and the other follows the image ratio (capped the same way). R2V (reference-to-video) activates when the arch declares `referenceToVideo: true` in ARCH_META **and** the model config has `refUnetName` set **and** the session has uploaded references with no chained input image — all references are passed as `referenceRefs` (capped at `ARCH_META[arch].maxReferences`, extras dropped with a `warning` event recorded on the take) and the prompt refiner cites them as `<Picture N>` with explicit roles. Only minimaxh3 supports it today. Video steps get `skillId` like generate steps; since they never record outcomes, `skills.getSummary(id, architecture)` falls back to the arch's default skill when no skill file exists.

Step interface:
```js
label(stepDef, cfg)
prepare(stepDef, ctx, previousIterations, onToken)     // → { prompt?, params?, ... }
buildComfyWorkflow(stepDef, prepareResult, ctx)        // → ComfyUI node graph
reviewMessages(stepDef, prepareResult, ctx, imageBase64, previousIterations)
prePass?(stepDef, prepResult, ctx, hooks)              // optional; throws on failure
skipReview?(stepDef)                                   // optional; true → no LLM review, auto-ACCEPT
```

`prePass` is an optional export. When present it is called before `buildComfyWorkflow`. `hooks` provides `{ onStart(), onProgress(pct) }`. Returns `null` (not wanted) or `{ poseImageUrl: string }` (skeleton uploaded to ComfyUI; passed into the main graph as ControlNet conditioning). When a pose is wanted but cannot be produced it **throws**, failing the step — a workflow that asked for pose control must not silently continue without it.

`skipReview` is an optional export: when it returns `true` for a step def, the LLM review is skipped and the iteration auto-ACCEPTs (used by deterministic model-type upscales, where re-running after a rejection could never change the result). Human review, if configured, still applies.

`ctx` shape: `{ userPrompt, modelConfig, skillId, inputImage, chainedInputRef, references, cfg, signal }`.
- `skillId` = `session.workflowId`
- `inputImage` = previous step's output URL (step chaining)
- `chainedInputRef` = re-uploaded ComfyUI input ref of `inputImage`; used as init-image at denoise 0.5 (`stepDef.params.chainDenoise` to override)
- `references` = `[{ filename, subfolder, type }]` (user-uploaded refs)
- `signal` = `AbortSignal` from pipeline's `AbortController`; passed to all `chatStream` calls

### Reference adapter routing (`buildComfyWorkflow`)
When `refs.length > 0 && mode === 'adapter'`:

| Architecture | Approach | Params passed to builder |
|---|---|---|
| `sd15` / `sdxl` | IPAdapter | `ipAdapterImages: refs` (+ `adapterModel`, `clipVisionModel` from modelConfig) |
| `flux` | Redux (StyleModelApply) | `reduxImages: refs` (+ `adapterModel` from modelConfig) |
| `flux2` | Native ReferenceLatent | `referenceImages: refs` (no adapter model needed) |
| Others | Falls through to txt2img | — |

### Upscale step shapes
```jsonc
// Model upscaler (ESRGAN / RealESRGAN)
{ "type": "upscale", "upscaleType": "model",
  "upscaleModel": "4x-UltraSharp.pth", "factor": 4,
  "review": { "maxIterations": 1, "humanReview": true } }

// Hires fix (re-diffusion via any configured model)
{ "type": "upscale", "upscaleType": "hires",
  "modelId": "sdxl-base", "scale": 2, "denoise": 0.35,
  "steps": 20, "cfgScale": 7, "sampler": "dpmpp_2m",
  "review": { "maxIterations": 1, "humanReview": true } }
```
`model` type: `UpscaleModelLoader → ImageUpscaleWithModel → (ImageScaleBy if factor < native) → SaveImage`.
Model upscales are deterministic, so they run once with **no LLM review** (auto-ACCEPT; `skipReview`). Hires upscales re-diffuse with a fresh seed and keep their review loop.
`hires` type: calls arch workflow builder with `initImage`, injects `LatentUpscaleBy` between VAEEncode and KSampler.

### Flux 2 architecture (`flux2.js`)
Always split-load: `UNETLoader` + `CLIPLoader(type:"flux2")` + `VAELoader`.
- `clipName` field for text encoder (Mistral 3 for Dev, Qwen 3 for Klein)
- Sampler: `KSampler`; empty latent: `EmptyFlux2LatentImage`; negative: `ConditioningZeroOut`
- `archMeta.loadingMode: 'split'` (forced, no checkpoint toggle)
- Reference chain: `LoadImage → ImageScaleToTotalPixels(1MP, 64step) → VAEEncode → ReferenceLatent`
- `ReferenceLatent` inputs: `{ conditioning, latent }` — no `vae` or `image` inputs

### ComfyUI asset discovery
`comfyui.fetchInputList(nodeType, inputName)` — handles both old and new `object_info` formats.
`comfyui.getAssets()` → `{ checkpoints, vaes, clips, unets, upscaleModels, ipAdapterModels, clipVisionModels, reduxModels, loras, controlNets, devices, multiGpu, errors }`.
`comfyui.getNodeIndex()` → `{ nodeClass: python_module }` from the full `/object_info` (core = `nodes` / `comfy_extras.*`, custom packs = `custom_nodes.<pack>`); `getSystemStats()` → raw `/system_stats`.

### System page
`GET /api/system/info` (`src/routes/system.js`) feeds the **System** view: ComfyUI version / torch / RAM / launch args / package versions, GPUs (+ MultiGPU availability), LLM reachability, and `src/services/nodeRequirements.js`'s report — `PACKS` (custom node packs an optional feature or wrapper-based arch needs, checked by node presence or sampler name) and per-arch availability, which is derived by building each arch's base graph with a dummy config and checking every emitted node class against ComfyUI. `installedPacks` lists every `custom_nodes.*` module ComfyUI loaded (pack versions are not exposed by ComfyUI's API). The page also tags model files with architectures: `cfg.fileArchTags = { "<kind>:<filename>": [arch, …] }` via `PUT /api/system/file-tags { key, archs }` (`config.setFileArchTags`); ModelEditor then lists only the tagged files of a kind for that architecture (plus the current value, with a "show all" escape) once any file of that kind is tagged.

### Kill / stop mechanism
`runPipeline` creates an `AbortController` and puts `signal` on `ctx`. The kill function in `activeKills`:
1. Sets `killed = true`
2. Calls `abortController.abort()` — immediately cancels any in-flight LLM `fetch()`
3. Calls `comfyui.interrupt()` — cancels current ComfyUI generation
4. Resolves any pending reviews/acceptances

`isKilled()` is checked at: iteration start, after `prepare()` returns, after `comfyui.generate()` returns, and after the review `chatStream` returns. `ctx.signal` is also passed to `comfyui.generate` / `generateVideo` (and the pose pre-pass), so a kill rejects the ComfyUI wait with `Stopped` immediately instead of waiting for an `execution_interrupted` frame that an idle or restarted ComfyUI never sends. On kill, the pipeline emits `stopped { step }` (not `error`), clears the in-progress step's iterations from the session, and sets `session.status = 'stopped'`.

`comfyui.waitForCompletion` handles `execution_interrupted` — the `prompt_id` check is lenient (accepts messages without `prompt_id` for older ComfyUI compatibility). After a WebSocket drop it reconnects with backoff; once back online it checks `/queue` and `/history` for the prompt and fails with "ComfyUI lost the job" if neither knows it (a ComfyUI crash/restart mid-job used to hang the pipeline forever). On boot, `server.js` marks any session still `running` as `error` — its pipeline died with the previous process.

### Skill / notes system
`data/skills/<workflowId>.json` — per-workflow knowledge base.

Notes have `auto: bool` and `enabled: bool`:
- **User notes** (`auto: false`) — created manually; never touched by AI.
- **AI notes** (`auto: true, enabled: false`) — AI suggestions; disabled by default; user must enable.
- **Locked notes** (`auto: true, enabled: true`) — user-approved; AI cannot remove or overwrite.

`skillRefresher.js` runs after each session and on manual refresh:
- Updates the SKILL text freely.
- Adds/replaces disabled auto notes from ENFORCE / BLACKLIST sections.
- Locked (enabled) notes are always preserved verbatim.
- New suggestions always start `enabled: false`.

### Orchestration
`runPipeline(session, pipelineDef, cfg, res, imageContext, opts)` — iterates steps, threads `ctx.inputImage`.
- `opts = { startStep, endStep, initialInputImage }` enables partial re-runs (`/rerun` route).
- Creates `AbortController`; kill fn aborts it + interrupts ComfyUI.
- Emits `step_complete` after each step.
- Stops early (skips remaining steps) if a step finishes without acceptance.
- On kill: emits `stopped`; discards only iterations added by the current run. A manual variant selection among the surviving iterations is kept.
- `/rerun` refuses a session whose workflow changed shape (step count **or** per-index step type) and refreshes step labels otherwise.
- On unexpected error: emits `error`.

`_runIterativeLoop(stepType, stepDef, stepIndex, session, ctx, cfg, res, isKilled)` — per-step loop
(wrapped by `runGenerateStep` / `runUpscaleStep`; video steps use `runVideoStep`, no review loop):
- Per-step review settings (`stepDef.review`) override global `cfg.*`.
- For generate steps with a previous step output: pre-uploads `ctx.inputImage` as `chainedInputRef`.
- Forwards ComfyUI binary WebSocket preview frames as `preview` SSE events.
- `isKilled()` checked at multiple points; all LLM calls receive `ctx.signal`.
- Picks the sampling seed before building the graph and records it on the iteration (generate steps and hires upscales via `prepResult.params`; `runVideoStep` does the same for video takes; model upscales are deterministic and record none).

### Config shape
```jsonc
{
  "llmBaseUrl":            "http://127.0.0.1:11434/v1",
  "llmApiKey":             "",
  "comfyuiUrl":            "http://127.0.0.1:8188",
  "llmProvider":           "openai",
  "llmModel":              "gemma4:31b",
  "llmUnloadEnabled":      false, // opt-in: llm.release(cfg) makes the call below before video jobs (videoTake.generateTake) so a shared GPU is free for the decode
  "llmUnloadUrl":          "",    // server-specific (the OpenAI API has no unload): llama-swap GET /unload, Ollama POST /api/generate {"model":"{model}","keep_alive":0}
  "llmUnloadMethod":       "GET", // GET | POST
  "llmUnloadBody":         "",    // optional JSON for POST; {model} → llmModel
  "activeWorkflow":        "portrait-4x",
  "maxIterations":         3,
  "humanReview":           false,
  "acceptanceGracePeriod": 10,
  "models": {
    "sdxl-base": { "id": "sdxl-base", "label": "SDXL Base", "architecture": "sdxl",
                   "checkpoint": "sdXL_v10.safetensors", "vae": "sdxl_vae.safetensors" },
    "flux-dev":  { "id": "flux-dev", "label": "Flux Dev", "architecture": "flux",
                   "unetName": "flux1-dev.safetensors", "clipL": "clip_l.safetensors",
                   "t5xxl": "t5xxl_fp8.safetensors", "vaeName": "ae.safetensors",
                   "adapterModel": "ip-adapter_flux1_dev.safetensors",
                   "clipVisionModel": "sigclip_vision_patch14_384.safetensors" }
  },
  "workflows": {
    "portrait-4x": { "id": "portrait-4x", "label": "Portrait → 4x", "steps": [ ... ] }
  },
  "loras": {
    "anima_turbo": { "filename": "anima_turbo.safetensors", "label": "Anima Turbo",
                     "architecture": "anima", "triggerWords": ["anima turbo"],
                     "description": "Speed-up LoRA for Anima", "defaultWeight": 1.0,
                     "autoDetected": true }
  }
}
```

---

## Architecture guides

`docs/arch/` — **per-architecture setup guides** (one `.md` per arch key). These are a core part of the repo: each file covers the files needed in ComfyUI, download links, required custom nodes, and a setup section for each capability the arch supports (adapter, pose ControlNet, tile ControlNet, structural ControlNet, etc.). **When adding or changing an arch capability, update the corresponding `docs/arch/<arch>.md` alongside `src/workflows/index.js` and the workflow builder.**

| File | Architecture |
|---|---|
| `sd15.md` | SD 1.5 / SD 2.x |
| `sdxl.md` | SDXL (incl. Illustrious XL) |
| `flux.md` | Flux.1 |
| `flux2.md` | Flux 2 (Dev / Klein) |
| `anima.md` | Anima |
| `sd3.md` | SD 3 / SD 3.5 |
| `chroma.md` | ChromaHD |
| `zimage.md` | Z-Image |
| `krea2.md` | Krea 2 |
| `wanvideo.md` | WanVideo |
| `minimaxh3.md` | MiniMax H3 (Hailuo 3) |
| `hunyuanvideo.md` | HunyuanVideo |
| `ltxvideo.md` | LTX-Video |
| `cogvideox.md` | CogVideoX |

---

## Key file map

```
src/
  routes/
    generate.js       — runPipeline + _runIterativeLoop, SSE, session CRUD, rerun/select/kill routes
    references.js     — POST /api/references/upload (base64 JSON → ComfyUI)
    sessions.js       — config/models/workflows/skills/assets API
    sdapi.js          — A1111 compat shim (calls /api/generate/run internally)
    system.js         — GET /api/system/info (versions, devices, packs, arch availability, files, tools.ffmpeg) + file → arch tags
    projects.js       — Film projects API (/api/projects): CRUD, reference bank, segments, prompt/run SSE, verdict, capture, export, kill, local media
  services/
    config.js         — load/save, model + workflow CRUD, activeWorkflow()
    db.js             — session persistence (JSON files in data/sessions/)
    skills.js         — skill/notes read/write (data/skills/<workflowId>.json)
    skillRefresher.js — LLM-driven skill synthesis; locked notes preserved
    llm.js            — provider router
    nodeRequirements.js — PACKS registry + inspect(): per-arch node availability (built from each arch's base graph) and custom-pack status for the System page
    agent.js          — generic tool-calling agent loop (guidance injection, execute handlers, bounded rounds)
    comfyui.js        — ComfyUI HTTP + WebSocket client; preview frame handling; uploadInputFile (any input file) + downloadOutput (stream /view to disk)
    videoTake.js      — one ComfyUI video job (progress/warning/video events, _noaudio handling) shared by runVideoStep and film takes
    ffmpeg.js         — ffmpeg/ffprobe wrapper (detect, probe, last frame, frame at t, audio range, trim, concat); injectable execFile
    projects.js       — Film project persistence + entity ops (segments, takes, verdicts/stale, script beats, reference bank)
    filmRunner.js     — Film take execution: resolveInputs (continue/cut), buildFilmContext, writeFilmPrompt, runTake, approveTake, exportProject, captureFromTake
    loraRegistry.js   — cfg.loras CRUD; scan via /api/sessions/loras/scan (reads ComfyUI LoRA list + auto-detects arch via loraMeta.js)
    pose.js           — pose pre-pass: draft gen + DWPreprocessor extraction in one ComfyUI graph; returns skeleton image ref
    providers/
      openai.js       — OpenAI-compat LLM driver; supports AbortSignal via options.signal; tool_calls response handling
  steps/
    index.js          — step-type registry (generate, upscale, video)
    generate.js       — generate step: vision notes, adapter/img2img routing, chain input, review
    upscale.js        — upscale step: model (ESRGAN) + hires (re-diffusion) types
    video.js          — video step: T2V / I2V / R2V, uploads init image, routes to video arch builder
  workflows/
    index.js          — buildWorkflow(modelConfig, params) + getDefaults(arch) + archMeta (incl. per-arch capabilities)
    lib/loraChain.js    — shared LoraLoader chain helper used by all image arch builders; applyModelOnlyLoraChain (LoraLoaderModelOnly) for DiT-only-trained LoRAs (krea2)
    lib/preprocessors.js — buildPreprocessorNode(type, imageRef, resolution) → ComfyUI node; maps depth/softedge/lineart_realistic/lineart_anime/canny to comfyui_controlnet_aux node classes
    lib/devicePlacement.js — applyDevicePlacement(workflow, modelConfig): swaps loaders for ComfyUI-MultiGPU twins per model.devices; normalizeDevices, usesMultiGpuNodes
    sd15.js           — SD1.5; supports initImage, ipAdapterImages, tileControlNet, structuralControlNet
    sdxl.js           — SDXL + refiner; supports initImage, ipAdapterImages, tileControlNet, structuralControlNet
    flux.js           — Flux 1 (SamplerCustomAdvanced); supports initImage, reduxImages
    flux2.js          — Flux 2 (KSampler, split-load only); supports referenceImages
    zimage.js         — Z-Image (KSampler + ModelSamplingAuraFlow, split-load only); supports initImage, LoRA
    krea2.js          — Krea 2 (plain KSampler, no ModelSampling node, split-load only); LoraLoaderModelOnly LoRAs, CFG-gated negative (ConditioningZeroOut at cfg<=1), supports initImage
    wanvideo.js       — WanVideo I2V/T2V; native ComfyUI nodes only; MoE cascade for 14B
    ltxvideo.js       — LTX-2.3 (and Sulphur 2, same checkpoint layout) T2V/I2V; the official two-stage recipe: half-size SamplerCustomAdvanced + CFGGuider + LTXVScheduler → LTXVLatentUpsampler ×2 → LCM refine with the distilled LoRA at 0.5 (`upscaleModel`); `samplingMode` distilled (LoRA at 0.7, cfg 1, 8 steps) | full (CFG + negative prompt, 30 steps); I2V via LTXVPreprocess + LTXVImgToVideoInplace (0.7 → 1.0); VAEDecodeTiled; optional audio latent; LoraLoaderModelOnly chain
    minimaxh3.js      — MiniMax H3 T2V/I2V/R2V; guidance-free (BasicGuider, no negative/CFG); native audio via VAEDecodeAudio when audioVaeName set (plus a silent `_noaudio` SaveVideo fallback written before the audio path — insurance against a mux failure; `comfyui.generateVideo` returns any video written before an execution error with a `warning`, and `video.pickPrimaryVideo` prefers the muxed file. The NaN-audio failures that motivated it were a ComfyUI 0.31 / ROCm kernel bug fixed by updating ComfyUI to ≥ 0.34, not a duration limit — see docs/arch/minimaxh3.md); frames snap to 17k+5; Ref2VA checkpoint + MiniMaxH3ReferenceToVideo for reference images
    sd3.js / chroma.js / anima.js
  lib/
    parsers.js        — parsePromptResponse, parseReview
    loraMeta.js       — auto-detect LoRA architecture from ComfyUI /view_metadata response
    png.js            — dependency-free PNG pixel inspector (blank-skeleton detection)
    imageSize.js      — dependency-free PNG/JPEG/WebP dimension reader + fitToBudget (video I2V aspect-ratio follow)
    loraTools.js      — lora catalog helpers + agent tool factories (add_lora, request_pose) with per-tool guidance
ui/src/
  stores/
    config.js         — configState, loadConfig, saveConfig, model/workflow CRUD
    generate.js       — genState, handleEvent (incl. stopped), SSE stream helpers (readSSEStream takes an onEvent), killGeneration, rerunFrom, selectIteration, addVideoStep
    film.js           — filmState, project/segment/ref CRUD, writePrompt/runSegment SSE, killRun, setVerdict, exportProject, captureFromTake
  App.vue               — view switch + hash routing (#/<view>, #/generate/<sessionId>) so a refresh restores the page and loaded session
  components/
    Sidebar.vue         — nav, live status block, Stop button
    WorkflowSelect.vue  — custom dropdown for active workflow
    GenerateSection.vue — prompt input + reference drop zone; restores refs on session load; Continue button
    RefGrid.vue         — presentational reference image grid + drop zone shell
    RefImage.vue        — single reference image tile (thumbnail + remove button)
    RunSection.vue      — step group renderer; type-badged headers; per-step Redo / From-here buttons
    IterationCard.vue   — iteration/take thumbnail (image or video); Output badge on the effective variant
    DetailPane.vue      — iteration detail + human review + refuse + variant nav/selection
    ModelsPanel.vue     — model building-blocks list
    ModelEditor.vue     — loader fields, data-driven from archMeta.fields
    WorkflowsPanel.vue  — workflow list + active selector
    WorkflowEditor.vue  — step builder: generate (with adapter picker, LoRA list, ControlNet) + upscale (model/hires)
    SettingsPanel.vue   — global settings (llmBaseUrl, llmApiKey, comfyuiUrl, llmModel)
    HistoryPanel.vue    — past sessions list
    SystemPanel.vue     — System page: ComfyUI/LLM/GPU status, arch availability, node packs, model-file arch tags
    LorasPanel.vue      — LoRA registry: scan, list, edit label/description/defaultWeight/triggerWords
    film/               — Film view, video-editor layout: FilmPanel (project list/rail + create + ffmpeg gate), FilmProject (header, PreviewPane stage + inspector, SegmentTimeline strip, Setup/References as FilmDrawer slide-overs), PreviewPane (selected take video or image, take thumbnails, approve/reject), TakeInspector (prompt/LoRAs/warnings, capture frame/audio), SegmentEditor (start mode, refs, intent/notes, frames/seed, LoRAs, prompt, run), SegmentTimeline, FilmSetup, RefBank + RefEntryForm + SessionImagePicker, ImageGenPanel (describe → LLM prompt → still with any image model), FilmDrawer
    Lightbox.vue        — app-wide click-to-enlarge overlay (stores/lightbox.js: openLightbox(url, caption)); mounted in FilmPanel
scripts/
  extract-safetensors.js — dependency-free safetensors subset extractor (`--prefix keep[=rename]`), streams tensor bytes; used to split the LTX-2.3 video/audio VAEs out of a checkpoint so `devices.vae` / `devices.audioVae` can place them on another GPU (docs/arch/ltxvideo.md)
data/
  config.json         — models, workflows, activeWorkflow, global settings
  sessions/*.json     — one file per session
  skills/*.json       — one file per workflow id
  projects/<id>.json  — one Film project; projects/<id>/{clips,refs,export}/ holds its local media
```

---

## Testing

```bash
npm test               # all 395 tests
npm run test:unit      # unit tests only
npm run test:int       # integration tests only
```

Fake servers in `test/support/fakeServers.js`:
- `makeFakeOllama(getVerdict)` — speaks OpenAI `/v1/chat/completions` SSE format.
  `getVerdict` called per review so tests can change it mid-run.
- `makeFakeComfyUI()` — returns an http.Server with `.uploads[]` and `.prompts[]` arrays
  populated each time `POST /upload/image` or `POST /prompt` is called.

Integration tests write to a tmpDir; set `DATA_DIR` / `SESSIONS_DIR` / `SKILLS_DIR`.

---

## Known limitations

- **Preview images**: ComfyUI's `latent2rgb` preview method does not emit binary WS frames for Flux/Flux 2 (16-channel latent space). Use `--preview-method taesd` with a Flux-compatible TAESD model for previews on those architectures. SD1.5/SDXL previews work with `latent2rgb`.
- **Pose pre-pass**: requires the `comfyui_controlnet_aux` custom node pack
  (`DWPreprocessor`). Install on the ComfyUI host:
  `cd ComfyUI/custom_nodes && git clone https://github.com/Fannovel16/comfyui_controlnet_aux && ComfyUI/venv/bin/pip install -r comfyui_controlnet_aux/requirements.txt`
  (~43 packages; verified no conflicts with the existing torch stack via pip dry-run).
  The DWPose detector models (`yolox_l.onnx`, `dw-ll_ucoco_384.onnx`) auto-download
  from huggingface on first use.
- **Pose detection limits**: DWPose's person detector is trained on photographs, so
  the pose draft is prompted toward photographic rendering on a plain background
  (see the `controlNet` docs above). Head-to-toe stances extract most reliably;
  partial-body framings work but DWPose may add low-confidence keypoints for
  out-of-frame limbs. If detection finds no person, the skeleton comes back all
  black and the step fails with "no person detected in the draft" — by design,
  never silently.
  ControlNet strength below ~1.0 may be overridden by the prompt.
- **LLLite pose adherence**: `anima-lllite-pose-1.safetensors` (v1, "minimal
  reference implementation" weights) reliably influences global composition —
  stance, framing, body orientation — but cannot enforce precise gestures (e.g.
  an arm extended toward the camera) at any strength/schedule, on base or
  finetuned anima models (verified by fixed-seed A/B sweeps). Watch the
  kohya-ss/Anima-LLLite HF repo for stronger pose weight releases.
- **Anima-LLLite**: ControlNet on anima needs `kohya-ss/ComfyUI-Anima-LLLite`
  (`cd ComfyUI/custom_nodes && git clone https://github.com/kohya-ss/ComfyUI-Anima-LLLite`,
  no pip deps). The node is `AnimaLLLiteApply` (verified against the pack:
  `model, lllite_name, image, strength, start_percent, end_percent, preserve_wrapper`);
  LLLite `.safetensors` weights go in `ComfyUI/models/controlnet/` and are picked
  up by the editor's ControlNet-model dropdown. Restart ComfyUI after installing.
- **ControlNet scope**: Pose ControlNet is anima-only for now; other architecture builders ignore the `controlNet.poseMode` step field. Tile and structural ControlNet are available on sd15 and sdxl.
- **Tile ControlNet requires init image**: tile CN is trained to enhance existing content, not guide random noise. Without an `initImage`, the sampler's empty latent and the tile conditioning are opposed, producing black or heavily degraded output. `generate.js` sets `initImage = chainedInputRef` automatically when `chainStrategy.mode === 'tile'`, so the sampler starts from the chained content.
- **Structural ControlNet — cross-model style transfer** (`chainStrategy.mode: 'structural'`): extracts a composition-only signal (depth map, soft edges, etc.) from the chained image via an inline preprocessor node, then applies it as ControlNet guidance while the target model runs pure txt2img (no `initImage`). This is the recommended approach for Flux 2 Klein → Illustrious SDXL style transfer: Klein contributes layout fidelity; SDXL contributes all visual aesthetic. Pixel-transfer approaches (adapter, init-image, tile) all carry Klein's appearance to SDXL and suppress its anime style. Requires `comfyui_controlnet_aux` for the preprocessor nodes.
  - **ControlNet model must match checkpoint prediction type**: Illustrious v0.1 = **eps**; v3.0+ and some NoobAI variants = **v-pred**. Mismatched models produce washed-out or noisy images regardless of strength. The MIC-Lab fp16 models (`MIC-Lab/illustriousXLv0.1_controlnet` on HuggingFace) are eps-trained: `illustriousXLv0.1_depth_midas_fp16.safetensors`, `illustriousXLv0.1_Softedge_fp16.safetensors`. Downloaded to `ComfyUI/models/controlnet/`.
  - The `windsingai` tile model (`Illustrious-XL-Tile`) is **v-pred only** — do not use with eps Illustrious v0.1.
  - Preprocessor choice: `depth` preserves spatial layout and lighting; `softedge` preserves shape outlines loosely (more style freedom); `lineart_anime` traces anime contours precisely (strongest guidance, transfers art style too). For cross-model style transfer, `softedge` or `depth` are preferred — `lineart_anime` can over-constrain when the goal is aesthetic freedom.
  - Recommended starting strength: **0.85–0.9** for depth/softedge. Above 1.0 overwhelms prompt composition.
- **Film needs ffmpeg** on the ComfyRefinery host. Resolution order in `src/services/ffmpeg.js`: `FFMPEG_PATH` / `FFPROBE_PATH` → bundled `ffmpeg-static` / `ffprobe-static` (optional npm dependencies, so `npm install` is the normal setup) → `ffmpeg` / `ffprobe` on PATH. The System page reports which (`tools.ffmpeg.source`); the Film routes refuse to run, capture or export without it. Voice consistency exists only on `cut` segments (Ref2VA `ref_audios`); `continue` segments (FL2VA) have no audio conditioning, so voices reset per clip.
- **MiniMax H3 reference-to-video requires the Audio VAE**: `audio_vae` is a required input of `MiniMaxH3ReferenceToVideo` (ComfyUI 0.34), so R2V (Generate with references, Film `cut`) fails early with a clear error when `audioVaeName` is blank; T2V/I2V still run silent without it.
- **MiniMax H3 on ROCm at 1344×768**: takes decode with a corrupt block-grid tail from ~frame 97 (the VAE's 6th temporal chunk); 1024×576 is clean and adheres better. Not memory pressure, not frame count. See docs/arch/minimaxh3.md ("1344×768 decodes with a corrupt tail").
- **MiniMax H3**: needs ComfyUI ≥ 0.30.0 (native `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` nodes); on ROCm use ≥ 0.34.0 — 0.31 produced NaN audio / GPU faults on 243-frame takes. Long takes are attention-bound: on ROCm, launching ComfyUI with `--use-ck-attention` roughly halves step time versus PyTorch SDPA (see docs/arch/minimaxh3.md, performance notes). On ROCm the nvfp4 text encoder yields all-NaN conditioning (prompt ignored) — use the int8_convrot encoder (docs/arch/minimaxh3.md). Guidance-free — the video step's guidance/negative params are ignored by this arch. R2V requires the optional `refUnetName` (Ref2VA checkpoint) on the model config; without it, uploaded references fall back to I2V first-frame conditioning. The R2V builder passes reference images as dotted dynamic inputs (`ref_images.ref_image_0` …) as serialized in the official Comfy-Org templates — if a ComfyUI update rejects them, re-export a template via "Save (API format)" to confirm the current serialization. Open weights are 768p-capped and region-restricted (see docs/arch/minimaxh3.md).
- **LTX-2.3 VRAM on a single 30 GB card**: the fp8 DiT is 23.9 GB resident, so the in-checkpoint VAEs force partial unloads (ROCm crashed there) or OOM the decode. Extract the VAEs (`scripts/extract-safetensors.js`), set them as the model's external `vae` / `audioVaeName` and place them on the second GPU — docs/arch/ltxvideo.md. Verified: 1024×576×121f with audio in 45 s.
- **LTX-2.3 two-stage needs the distilled LoRA**: `upscaleModel` (spatial latent upscaler) and `samplingMode: distilled` both require `distilledLoraName`; the builder throws a clear config error otherwise. Output sizes are on a /64 grid (`dimMultiple`), frames snap to 8n+1. Cut mode / reference-to-video does not exist for LTX (Film uses `continue` only). LTX 2.5 (ComfyUI 0.34 templates, Gemma 4 encoder + duration head) is a different loader setup and is not covered by the `ltxvideo` arch.
- **Anima IP-Adapter disabled**: builder support exists (`AnimaIPAdapterApply`), but
  `capabilities.adapter` is `false` for anima because the adapter weights are not yet
  publicly released — flip the flag in `src/workflows/index.js` when they ship.
