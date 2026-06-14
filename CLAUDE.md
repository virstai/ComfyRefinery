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
npm test               # all 247 tests
npm run ui:build       # compile Vue → public/
```

API on :3000, Vite dev on :5173. **Always stop the dev server on port 3000 after test runs.**

---

## Branch: `refactor/comfyrefinery`

All planned phases complete. Ready to merge to main.

### Phase history

| Phase | Status | Commit |
|-------|--------|--------|
| 1 — Rename + step registry + LLM abstraction | ✅ Done | `2129995` |
| 2 — Workflow entity | ✅ Done | `538f3a8` |
| LLM refactor — OpenAI-compat provider | ✅ Done | `d77467d` |
| 3 — Reference handling | ✅ Done | `d91b763` |
| 4 — Upscale step | ✅ Done | `69d0685` |
| 5 — Reference adapters + stop/kill fixes | ✅ Done | `be8c9d0` |
| 6 — Video step | ✅ Done | `e5afc2d` |

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
}
```

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

  | Capability | sd15 | sdxl | flux | flux2 | anima | wanvideo |
  |---|---|---|---|---|---|---|
  | `lora` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
  | `adapter` | ✓ | ✓ | ✓ | ✓ | — (disabled) | — |
  | `controlNet` (pose, LLLite) | — | — | — | — | ✓ | — |
  | `tileControlNet` | ✓ | ✓ | — | — | — | — |
  | `structuralControlNet` | ✓ | ✓ | — | — | — | — |

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
                        "loras": [{ "name": "anima_turbo.safetensors", "weight": 1.0, "source": "step" }],  // source: "step" | "llm"
                        "poseUsed": true, "poseImageUrl": "/api/image?...",
                        "warnings": ["DWPreprocessor not found — skipping pose"] } ],  // optional, only when non-empty
      "outputImageUrl": "/api/image?..." },
    { "type": "upscale", "label": "4x-UltraSharp.pth ×4",
      "iterations": [ { "imageUrl": "...", "verdict": "ACCEPT", "diagnosis": "..." } ],
      "outputImageUrl": "/api/image?..." }
  ],
  "status": "complete" | "stopped" | "error", "createdAt": "..."
}
```

### SSE events
All events carry `step` (0-indexed). Full event list:

| Event | Payload | Notes |
|---|---|---|
| `session` | `{ id, prompt, resume? }` | First event; client sets sessionId |
| `step` | `{ index, type, label, total }` | Start of each pipeline step |
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
| `video` | `{ step, url }` | Final video URL for video steps |
| `step_complete` | `{ step, imageUrl?, videoUrl?, accepted }` | Step finished; pipeline stops if `!accepted` |
| `done` | `{ accepted, imageUrl?, videoUrl?, sessionId, prompt, iterations }` | Pipeline complete |
| `stopped` | `{ step }` | User clicked Stop; in-progress step cleared |
| `error` | `{ message }` | Unexpected pipeline error |
| `history` | `{ step, ...iteration }` | Replayed on `/continue` |

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
`src/steps/video.js` — video step: T2V / I2V routing, uploads init image, delegates to wanvideo (or other video arch).

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
`comfyui.getAssets()` → `{ checkpoints, vaes, clips, unets, upscaleModels, ipAdapterModels, clipVisionModels, reduxModels, errors }`.

### Kill / stop mechanism
`runPipeline` creates an `AbortController` and puts `signal` on `ctx`. The kill function in `activeKills`:
1. Sets `killed = true`
2. Calls `abortController.abort()` — immediately cancels any in-flight LLM `fetch()`
3. Calls `comfyui.interrupt()` — cancels current ComfyUI generation
4. Resolves any pending reviews/acceptances

`isKilled()` is checked at: iteration start, after `prepare()` returns, after `comfyui.generate()` returns, and after the review `chatStream` returns. On kill, the pipeline emits `stopped { step }` (not `error`), clears the in-progress step's iterations from the session, and sets `session.status = 'stopped'`.

`comfyui.waitForCompletion` handles `execution_interrupted` — the `prompt_id` check is lenient (accepts messages without `prompt_id` for older ComfyUI compatibility).

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
`runPipeline(session, pipelineDef, cfg, res)` — iterates steps, threads `ctx.inputImage`.
- Creates `AbortController`; kill fn aborts it + interrupts ComfyUI.
- Emits `step_complete` after each step.
- Stops early (skips remaining steps) if a step finishes without acceptance.
- On kill: emits `stopped`; on unexpected error: emits `error`.

`runStep(stepDef, stepIndex, session, ctx, cfg, res, isKilled)` — per-step loop:
- Per-step review settings (`stepDef.review`) override global `cfg.*`.
- For generate steps with a previous step output: pre-uploads `ctx.inputImage` as `chainedInputRef`.
- Forwards ComfyUI binary WebSocket preview frames as `preview` SSE events.
- `isKilled()` checked at multiple points; all LLM calls receive `ctx.signal`.

### Config shape
```jsonc
{
  "llmBaseUrl":            "http://127.0.0.1:11434/v1",
  "llmApiKey":             "",
  "comfyuiUrl":            "http://127.0.0.1:8188",
  "llmProvider":           "openai",
  "llmModel":              "gemma4:31b",
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
| `wanvideo.md` | WanVideo |
| `hunyuanvideo.md` | HunyuanVideo |
| `ltxvideo.md` | LTX-Video |
| `cogvideox.md` | CogVideoX |

---

## Key file map

```
src/
  routes/
    generate.js       — runPipeline + runStep, SSE, session CRUD, kill route
    references.js     — POST /api/references/upload (base64 JSON → ComfyUI)
    sessions.js       — config/models/workflows/skills/assets API
    sdapi.js          — A1111 compat shim (calls /api/generate/run internally)
  services/
    config.js         — load/save, model + workflow CRUD, activeWorkflow()
    db.js             — session persistence (JSON files in data/sessions/)
    skills.js         — skill/notes read/write (data/skills/<workflowId>.json)
    skillRefresher.js — LLM-driven skill synthesis; locked notes preserved
    llm.js            — provider router
    agent.js          — generic tool-calling agent loop (guidance injection, execute handlers, bounded rounds)
    comfyui.js        — ComfyUI HTTP + WebSocket client; preview frame handling
    loraRegistry.js   — cfg.loras CRUD; scan via /api/sessions/loras/scan (reads ComfyUI LoRA list + auto-detects arch via loraMeta.js)
    pose.js           — pose pre-pass: draft gen + DWPreprocessor extraction in one ComfyUI graph; returns skeleton image ref
    providers/
      openai.js       — OpenAI-compat LLM driver; supports AbortSignal via options.signal; tool_calls response handling
  steps/
    index.js          — step-type registry (generate, upscale, video)
    generate.js       — generate step: vision notes, adapter/img2img routing, chain input, review
    upscale.js        — upscale step: model (ESRGAN) + hires (re-diffusion) types
    video.js          — video step: T2V / I2V, uploads init image, routes to video arch builder
  workflows/
    index.js          — buildWorkflow(modelConfig, params) + getDefaults(arch) + archMeta (incl. per-arch capabilities)
    lib/loraChain.js    — shared LoraLoader chain helper used by all image arch builders
    lib/preprocessors.js — buildPreprocessorNode(type, imageRef, resolution) → ComfyUI node; maps depth/softedge/lineart_realistic/lineart_anime/canny to comfyui_controlnet_aux node classes
    sd15.js           — SD1.5; supports initImage, ipAdapterImages, tileControlNet, structuralControlNet
    sdxl.js           — SDXL + refiner; supports initImage, ipAdapterImages, tileControlNet, structuralControlNet
    flux.js           — Flux 1 (SamplerCustomAdvanced); supports initImage, reduxImages
    flux2.js          — Flux 2 (KSampler, split-load only); supports referenceImages
    wanvideo.js       — WanVideo I2V/T2V; native ComfyUI nodes only; MoE cascade for 14B
    sd3.js / chroma.js / anima.js
  lib/
    parsers.js        — parsePromptResponse, parseReview
    loraMeta.js       — auto-detect LoRA architecture from ComfyUI /view_metadata response
    png.js            — dependency-free PNG pixel inspector (blank-skeleton detection)
    loraTools.js      — lora catalog helpers + agent tool factories (add_lora, request_pose) with per-tool guidance
ui/src/
  stores/
    config.js         — configState, loadConfig, saveConfig, model/workflow CRUD
    generate.js       — genState, handleEvent (incl. stopped), SSE stream helpers, killGeneration
  components/
    AppHeader.vue       — WorkflowSelect + panel buttons
    WorkflowSelect.vue  — custom dropdown for active workflow
    GenerateSection.vue — prompt input + reference drop zone; restores refs on session load
    RefGrid.vue         — presentational reference image grid + drop zone shell
    RefImage.vue        — single reference image tile (thumbnail + remove button)
    RunSection.vue      — step group renderer; type-badged headers; Stop button
    IterationCard.vue   — single iteration thumbnail; live preview via data URL
    IterationModal.vue  — full detail + human review + refuse
    ModelsPanel.vue     — model building-blocks list
    ModelEditor.vue     — loader fields, data-driven from archMeta.fields
    WorkflowsPanel.vue  — workflow list + active selector
    WorkflowEditor.vue  — step builder: generate (with adapter picker, LoRA list, ControlNet) + upscale (model/hires)
    SettingsPanel.vue   — global settings (llmBaseUrl, llmApiKey, comfyuiUrl, llmModel)
    HistoryPanel.vue    — past sessions list
    LorasPanel.vue      — LoRA registry: scan, list, edit label/description/defaultWeight/triggerWords
data/
  config.json         — models, workflows, activeWorkflow, global settings
  sessions/*.json     — one file per session
  skills/*.json       — one file per workflow id
```

---

## Testing

```bash
npm test               # all 247 tests
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
- **Anima IP-Adapter disabled**: builder support exists (`AnimaIPAdapterApply`), but
  `capabilities.adapter` is `false` for anima because the adapter weights are not yet
  publicly released — flip the flag in `src/workflows/index.js` when they ship.
