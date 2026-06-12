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
npm test               # all 188 tests
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
      "controlNet": { "poseMode": "auto", "poseModelId": "pose-draft",
                      "controlNetModel": "anima_lllite_pose.safetensors", "strength": 0.8 },
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

Generate step LoRA / ControlNet fields:
- `loras` — always-on LoRA list applied to every iteration: `[{ name, weight }]`.
- `llmLoras` — `true` enables LLM tool calling; LLM may call `add_lora` / `request_pose` (bounded 3-round loop via `src/lib/loraTools.js`). Selected LoRAs are recorded on the iteration.
- `controlNet` — `{ poseMode, poseModelId, controlNetModel, strength }`. `poseMode`: `"off"` (disabled), `"auto"` (LLM-triggered via `request_pose`), `"always"` (unconditional). When active, a pose pre-pass runs (`src/services/pose.js`): draft generation with `poseModelId` + DWPreprocessor extraction in a single ComfyUI graph; skeleton re-uploaded as input for the main generation. Anima arch only (other archs ignore this field).

`referenceStrategy.diffusion` — `{ mode, denoise? }`:
- `mode: "txt2img"` — ignore refs for diffusion (still used for vision notes)
- `mode: "init-image"` — refs[0] as init image at `denoise`
- `mode: "adapter"` — IPAdapter (sd15/sdxl), Redux (flux), or native ReferenceLatent (flux2)

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
prePass?(stepDef, prepResult, ctx, hooks)              // optional; non-fatal
```

`prePass` is an optional export. When present it is called before `buildComfyWorkflow`. `hooks` provides `{ onStart(), onProgress(pct) }`. Returns `null` (skipped), `{ warning: string }` (soft failure — emits a `warning` SSE event and continues), or `{ poseImageUrl: string }` (skeleton image uploaded to ComfyUI; passed into the main generation graph as a ControlNet conditioning image).

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
    index.js          — buildWorkflow(modelConfig, params) + getDefaults(arch) + archMeta
    sd15.js           — SD1.5; supports initImage, ipAdapterImages
    sdxl.js           — SDXL + refiner; supports initImage, ipAdapterImages
    flux.js           — Flux 1 (SamplerCustomAdvanced); supports initImage, reduxImages
    flux2.js          — Flux 2 (KSampler, split-load only); supports referenceImages
    wanvideo.js       — WanVideo I2V/T2V; native ComfyUI nodes only; MoE cascade for 14B
    sd3.js / chroma.js / anima.js
  lib/
    parsers.js        — parsePromptResponse, parseReview
    loraMeta.js       — auto-detect LoRA architecture from ComfyUI /view_metadata response
    loraTools.js      — OpenAI tool definitions (add_lora, request_pose) + bounded tool-call loop (max 3 rounds)
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
npm test               # all 188 tests
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
- **Pose pre-pass**: requires the `comfyui_controlnet_aux` custom node pack for DWPreprocessor; detector and estimator filenames default to pack defaults (verify against your installation if the pose step errors).
- **AnimaLLLiteLoader**: the node name and input schema in `anima.js` are unverified against a live pack — check ComfyUI's `object_info` endpoint when the pack is installed and correct any mismatches.
- **ControlNet scope**: ControlNet (pose) is anima-only for now; other architecture builders ignore the `controlNet` step field.
- **LoRA builder scope**: the `loras` / `llmLoras` step fields inject a LoraLoader chain in anima.js only; other architecture builders currently ignore them.
