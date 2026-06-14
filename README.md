# ComfyRefinery

A workflow orchestration layer on top of ComfyUI. Describe what you want, pick a
**Workflow**, and ComfyRefinery iterates: build prompt → generate → AI reviews →
optionally pause for human review → repeat until accepted. Workflows are reusable,
configurable chains of steps (generate → upscale → video → …) that accumulate a learned
**skill** — a short prompt-engineering guide the LLM uses to improve over time.

The prompt builder runs as a tool-calling **agent**: based on the step's settings it can
pick **LoRAs** from a registry (auto-detected per architecture, with trigger words and
descriptions you curate) and request a **pose ControlNet** guide — a draft image is
rendered from a pose description, a skeleton is extracted with DWPose, and the main
generation follows it.

All LLM features are individually optional. With all four disabled ComfyRefinery acts
as a pure ComfyUI frontend with structured workflows — no LLM server required.

> **Note:** This is a vibe-coded / AI-assisted project. Most features work, but many have not been fully human-tested — especially less common model architectures and more complex multi-step workflows. Expect rough edges and bugs.

## Prerequisites

- **Node.js** 18+
- **ComfyUI** running with at least one model loaded
- **An OpenAI-compatible LLM** with vision support *(optional)* — Ollama (`gemma4:31b`,
  `llava:13b`), LM Studio, OpenAI, vLLM, or any server that speaks
  `/v1/chat/completions`. Required only when one or more LLM features are enabled.

## ComfyUI custom nodes and models

Most architectures work with stock ComfyUI. The table below lists every custom node
pack and special model type referenced across the architecture guides — install only
what you need for the archs you actually use.

### Custom node packs

| Pack | Repo | Required for | Archs |
|---|---|---|---|
| **ComfyUI_IPAdapter_plus** | [cubiq/ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus) | Adapter reference mode (IPAdapter) | SD 1.5, SDXL |
| **comfyui_controlnet_aux** | [Fannovel16/comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) | Pose ControlNet (DWPose skeleton extractor) and structural ControlNet preprocessors (MiDaS depth, HED, lineart, canny) | SD 1.5, SDXL, Anima |
| **ComfyUI-Anima-LLLite** | [kohya-ss/ComfyUI-Anima-LLLite](https://github.com/kohya-ss/ComfyUI-Anima-LLLite) | Pose ControlNet on Anima via the LLLite format (`AnimaLLLiteApply` node — no pip deps) | Anima |
| **comfyui-anima-ipadapter** | [Wenaka2004/comfyui-anima-ipadapter](https://github.com/Wenaka2004/comfyui-anima-ipadapter) | Adapter reference mode on Anima *(weights not yet publicly released)* | Anima |
| **RES4LYF** | [ClownsharkBatwing/RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF) | `er_sde` sampler for Anima *(may already be in your ComfyUI build — check samplers list first)* | Anima |
| **ComfyUI-CogVideoXWrapper** | [kijai/ComfyUI-CogVideoXWrapper](https://github.com/kijai/ComfyUI-CogVideoXWrapper) | CogVideoX — required, auto-downloads models on first use; also needs `diffusers>=0.30.1` | CogVideoX |
| **ComfyUI-LTXVideo** | [Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) | LTX-Video advanced features (`LTXVPreprocess`, `LTXVAddGuide`, etc.) — basic T2V/I2V works without it | LTX-Video |
| **ComfyUI-GGUF** | [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | Quantised GGUF model variants for LTX-Video | LTX-Video |
| **ComfyUI-HunyuanVideoWrapper** | [kijai/ComfyUI-HunyuanVideoWrapper](https://github.com/kijai/ComfyUI-HunyuanVideoWrapper) | HunyuanVideo on older ComfyUI builds — native support is built-in on current ComfyUI | HunyuanVideo |

**No custom nodes required:** Flux.1, Flux 2, SD 3 / 3.5, ChromaHD, WanVideo.

### Special model files

Some architectures need model files that sit outside the usual checkpoint/VAE/LoRA
categories:

| Model | File(s) | Folder | Used for |
|---|---|---|---|
| **DWPose detectors** | `yolox_l.onnx`, `dw-ll_ucoco_384.onnx` | Auto-downloaded by `comfyui_controlnet_aux` | Person detection + keypoint extraction for pose pre-pass (SD 1.5, SDXL, Anima) |
| **Anima-LLLite weights** | e.g. `anima-lllite-pose-1.safetensors` | `models/controlnet/` | Anima pose ControlNet — from [kohya-ss/Anima-LLLite](https://huggingface.co/kohya-ss/Anima-LLLite) |
| **Illustrious XL structural CNs** | `illustriousXLv0.1_depth_midas_fp16.safetensors`, `illustriousXLv0.1_Softedge_fp16.safetensors` | `models/controlnet/` | Structural ControlNet on Illustrious XL checkpoints — from [MIC-Lab/illustriousXLv0.1_controlnet](https://huggingface.co/MIC-Lab/illustriousXLv0.1_controlnet); use eps-trained CNs with eps checkpoints |
| **Flux Redux** | `flux1-redux-dev.safetensors` + `sigclip_vision_patch14_384.safetensors` | `models/style_models/`, `models/clip_vision/` | Adapter reference mode on Flux.1 |
| **WanVideo CLIP Vision** | `sigclip_vision_patch14_384.safetensors` | `models/clip_vision/` | Image-to-video conditioning on WanVideo 14B I2V |
| **HunyuanVideo CLIP Vision** | `llava_llama3_vision.safetensors` | `models/clip_vision/` | Image-to-video conditioning on HunyuanVideo I2V |

See each architecture's guide in [`docs/arch/`](docs/arch/) for exact filenames, download
links, and step-by-step setup instructions.

---

## Install

```bash
git clone https://github.com/virstai/ComfyRefinery.git
cd ComfyRefinery
npm install
npm run ui:build
```

## Run

```bash
npm start
```

Opens on **http://localhost:3000**. Override the port with `PORT=8080 npm start`.

## First-time setup

ComfyRefinery is an orchestration layer — it builds prompts, submits workflows to
ComfyUI, and reviews the results. **ComfyUI must already be running** with your model
files in place before the app is useful.

Two things need to be configured before generating:

- **Model** — a named entry that points to model files already present in ComfyUI
  (checkpoint, UNet, VAE, CLIP, etc.). ComfyRefinery reads what's available directly
  from ComfyUI, so it only lists files ComfyUI can actually load.
- **Workflow** — a pipeline (generate → upscale → …) that references one or more
  Models. You must have at least one Model before you can create a Workflow.

### Step 1 — Settings

Open **Settings** (⚙) and fill in:

- **ComfyUI URL** — default `http://127.0.0.1:8188`. Change if ComfyUI is on another
  host or port.
- **LLM base URL** *(optional)* — any OpenAI-compatible server, e.g.
  `http://127.0.0.1:11434/v1` for Ollama or `https://api.openai.com/v1` for OpenAI.
- **API key** *(optional)* — leave blank for local servers.
- **LLM model** *(optional)* — the model name your server exposes (e.g. `gemma4:31b`).
  When image review or vision guidance is enabled the model must support image inputs.

### Step 2 — Add a Model

Open **Models** (⊞) and click **Add model**:

1. Choose an **architecture** (SDXL, Flux, SD 1.5, …). Each architecture shows a
   short note describing which files and folders ComfyUI expects, and whether any
   custom nodes are required.
2. Fill in the file fields. The dropdowns are populated from ComfyUI's own file lists —
   if they are empty, click **Reload asset lists** (this calls ComfyUI's API to refresh
   its model cache and re-reads all available files). Files must already be present in
   the correct ComfyUI folder for their type:

   | Field | ComfyUI folder |
   |---|---|
   | Checkpoint | `models/checkpoints/` |
   | UNet / diffusion model | `models/diffusion_models/` or `models/unet/` |
   | VAE | `models/vae/` |
   | CLIP / text encoder | `models/clip/` or `models/text_encoders/` |
   | IP-Adapter | `models/ipadapter/` |
   | CLIP Vision | `models/clip_vision/` |
   | ControlNet model (pose or tile) | `models/controlnet/` |
   | Upscale model | `models/upscale_models/` |

3. Give the model a label and save.

### Step 3 — Add a Workflow

Open **Workflows** (▶) and click **Add workflow**:

1. Add a **generate step** and select the Model you just created.
2. Configure resolution, sampler, and scheduler.
3. Under **Image inputs**, configure how reference images and (for step 2+) the
   previous step's output are used — init-image, adapter, tile ControlNet, or ignored.
4. Optionally add an **upscale** or **video** step after the generate step.
5. Click **Use** to make it the active workflow.

### Optional — LoRAs

Open **LoRAs** (✦) and click **Rescan ComfyUI** to discover LoRA files. Each entry's
architecture is auto-detected from its training metadata where possible; assign it
manually otherwise (untagged LoRAs are never offered to the LLM). Add trigger words and
a description — the LLM uses these to decide when a LoRA helps.

In a workflow generate step you can then pin **always-on LoRAs** (e.g. turbo LoRAs —
remember to set the step's Steps/CFG to the LoRA's recommended values) and/or enable
**LLM may add LoRAs**, which lets the prompt-builder agent apply catalog LoRAs per
prompt. LLM LoRA selection requires the **Vision guidance & LoRA selection** LLM feature
to be enabled.

LoRAs are supported on every image architecture (SD 1.5, SDXL, SD3, Flux, Flux 2,
ChromaHD, Anima) — the LoRA chain is injected right after the model loader.

### Optional — Pose ControlNet

Supported on **SD 1.5**, **SDXL**, and **Anima**. Select the ControlNet weights in the
**model's** settings, then set a workflow step's **Pose mode** to `auto` (the LLM
decides per prompt) or `always`. A pose draft is rendered with the step's model from a
detection-friendly pose description, DWPose extracts the skeleton, and the main generation
follows it. If no pose can be extracted, the step fails rather than generating without
pose control. Strength below ~1.0 lets the prompt override the pose.

- **SD 1.5 / SDXL** use standard ComfyUI `ControlNetLoader` + `ControlNetApplyAdvanced`
  nodes (no custom nodes) — requires a matching OpenPose ControlNet model in
  `models/controlnet/` and `comfyui_controlnet_aux` for the DWPose extractor.
- **Anima** uses the LLLite variant (`AnimaLLLiteApply`) — see the in-app Anima setup
  guide for the required custom node packs and weights.

**Anima IP-Adapter** is implemented but currently **disabled**: the adapter weights
are not yet publicly released. The "Adapter conditioning" reference mode is therefore
not offered for Anima steps; it will be re-enabled once the weights ship.

### Optional — Image input modes

Each generate step has an **Image inputs** section controlling how external images
influence generation. The same modes apply to both the previous step's output (step 2+)
and user-uploaded references.

- **Init-image (img2img)** — denoises at a configurable strength. Simple, but loses
  detail at any denoise value.
- **Adapter** — feeds via IPAdapter / Redux / ReferenceLatent as a style reference.
  No denoising, but less spatially faithful.
- **Tile ControlNet** — the source image guides generation via tile ControlNet while
  the model renders from noise. Supported on **SD 1.5** and **SDXL**. Requires a tile
  ControlNet model in `models/controlnet/` (set in the model's settings). Strength
  defaults to 0.5.
- **Structural ControlNet** — extracts a depth map or edge map from the source via an
  inline preprocessor node, then uses it as ControlNet guidance while the model runs as
  pure txt2img (no init image). The target model contributes all pixel-level aesthetic;
  only the composition is borrowed from the source. Ideal for cross-model chaining (e.g.
  Flux 2 Klein provides layout fidelity → Illustrious SDXL applies anime style).
  Supported on **SD 1.5** and **SDXL**. Requires a structural ControlNet model and
  `comfyui_controlnet_aux`.
- **Ignore** — image is dropped; the step generates from scratch.

For user-uploaded references, the same modes are available, plus an LLM vision guidance
checkbox (sends reference images to the LLM for prompt building — requires the Vision
guidance & LoRA selection feature to be enabled).

### Step 4 — Generate

Type a prompt and click **Generate**. With default settings the LLM builds the prompt,
ComfyUI generates the image, and the AI reviews it — repeating until accepted or the
iteration limit is reached. Disable any or all LLM features in Settings to simplify or
remove the LLM from the loop entirely.

---

## Settings

All settings are configured in-app via the **Settings** panel (⚙). No environment
variables are needed for application config — the only supported env var is `PORT`
to override the HTTP listen port.

### Connection

| Setting | Default | Notes |
|---|---|---|
| ComfyUI URL | `http://127.0.0.1:8188` | Base URL of your ComfyUI instance |
| LLM base URL | `http://127.0.0.1:11434/v1` | OpenAI-compatible endpoint; unused when all LLM features are off |
| API key | *(blank)* | Leave blank for Ollama / local servers |
| LLM model | *(blank)* | Model name as your server exposes it; must support vision if image review or vision guidance is enabled |

### Review

These settings are hidden when **Image review** is disabled.

| Setting | Default | Notes |
|---|---|---|
| Max iterations | 3 | Maximum generate-review cycles per step; overridable per workflow step |
| Acceptance grace period | 10 s | Seconds to hold an accepted result before finalising; 0 = disabled |
| Human review | off | Pause for manual accept/reject after each iteration |
| Bypass grace period | off | Skip the grace period hold, finalise immediately on acceptance |

Per-step overrides for max iterations, grace period, and human review are available
in each workflow step's **Review** block (hidden when image review is globally off).

### LLM features

Four independent toggles control how much the LLM is involved. Disabling all four
removes the LLM from the generation loop entirely — only ComfyUI is needed.

| Feature | Default | What it does when enabled |
|---|---|---|
| **Prompt refinement** | on | The LLM rewrites the user's prompt using the workflow skill before each generate. When off, the raw prompt is passed directly to ComfyUI with no modification. |
| **Image review** | on | After each generation the LLM reviews the image and returns a verdict. Rejected iterations retry with a refined prompt. When off, every generation auto-accepts on the first attempt. |
| **Skill refinement** | on | After each session the LLM synthesises a skill — a compact prompt-engineering guide — from accept/reject history. Future prompts are built using this guide. When off, the architecture's built-in default skill is used and no updates are written. |
| **Vision guidance & LoRA selection** | on | The LLM receives reference images for compositional guidance, and can select LoRAs from the registry via tool calling. When off, references are only used for diffusion (adapter/init-image/tile), and LoRA selection falls back to always-on LoRAs only. |

**Typical combinations:**

- **All on** — full AI loop: prompt built from skill, image reviewed and retried, skill
  learned over time, LoRAs and references inform the prompt.
- **Prompt refinement off** — raw user prompt goes to ComfyUI as-is; review still runs
  (different seed on retry), skill still updated.
- **Image review off** — one generation per step, auto-accepted; no LLM review calls.
  Fastest mode when you trust the prompt.
- **All off** — ComfyUI-only mode. No LLM server required. Prompts pass through
  unchanged, every generation accepts immediately, skills are not updated.

### Acceptance grace period

When the AI accepts an iteration the result is held for a configurable window. During
this time a **Refuse** button appears, letting you reject without restarting. After the
timer the session completes normally. You can also refuse after the session ends — open
the iteration modal and use **Continue session** to keep iterating.

---

## Supported architectures

### Image

| Key | Name | Loader | LoRA | Adapter | Pose CN | Tile CN | Structural CN |
|---|---|---|---|---|---|---|---|
| `sd15` | SD 1.5 / SD 2.x | Checkpoint + optional external VAE | ✓ | IPAdapter | ✓ | ✓ | ✓ |
| `sdxl` | SDXL | Checkpoint + optional VAE + optional refiner | ✓ | IPAdapter | ✓ | ✓ | ✓ |
| `flux` | Flux.1 | Checkpoint, or split (UNet + CLIP-L + T5-XXL + VAE) | ✓ | Redux | — | — | — |
| `flux2` | Flux 2 (Dev / Klein) | Split only (UNet + CLIP/Mistral or Qwen-3 + VAE) | ✓ | ReferenceLatent | — | — | — |
| `sd3` | SD 3 / SD 3.5 | Checkpoint + optional external VAE | ✓ | — | — | — | — |
| `chroma` | ChromaHD | Split only (UNet + T5 encoder + VAE); standard ComfyUI nodes | ✓ | — | — | — | — |
| `anima` | Anima | Split only (UNet + CLIP/Qwen-3 + Qwen-Image VAE); needs `er_sde` sampler | ✓ | — ¹ | LLLite ² | — | — |

¹ Anima IP-Adapter is implemented but disabled — weights not yet publicly released.  
² Anima pose ControlNet uses `AnimaLLLiteApply` (kohya-ss/ComfyUI-Anima-LLLite) rather than standard `ControlNetApplyAdvanced`; requires DWPose via comfyui_controlnet_aux for skeleton extraction.  
Structural CN: extracts depth/edges from a previous step's output as structure-only guidance while the model generates pure txt2img — used for cross-model style transfer (e.g. Flux 2 Klein → Illustrious SDXL). Requires comfyui_controlnet_aux preprocessor nodes and a matching ControlNet model.

### Video

Video architectures are used in **video steps** within a workflow. They generate a short
clip from the final prompt text (T2V) or the previous step's output image (I2V).

| Key | Name | Loader |
|---|---|---|
| `wanvideo` | WanVideo (Wan 2.2) | Split (UNet + CLIP/T5 + VAE) |
| `hunyuanvideo` | HunyuanVideo | Split (UNet + CLIP/T5 + VAE) |
| `ltxvideo` | LTX-Video | Split (UNet + CLIP/T5 + VAE) |
| `cogvideox` | CogVideoX | Checkpoint + VAE + CLIP |

---

## Development

```bash
npm run dev     # Express --watch on :3000 + Vite hot-reload on :5173
npm test        # all tests
```

---

## Native API

All endpoints under `/api`.

### Generate (SSE streams)

**`POST /api/generate`** — start a new session using the active workflow.

**`POST /api/generate/continue/:id`** — resume an existing session.

```json
{
  "prompt": "a cat on the moon",
  "references": [],
  "overrides": { "width": 1024, "height": 1024 }
}
```

**`POST /api/generate/run`** — full per-request control.

```json
{
  "prompt": "a cat on the moon",
  "workflowId": "portrait-sd15",
  "overrides": { "steps": 28, "sampler": "euler" },
  "humanReview": false,
  "acceptanceGracePeriod": 10
}
```

| Field | Required | Description |
|---|---|---|
| `prompt` | yes | Image description |
| `workflowId` | no | Override active workflow |
| `references` | no | Array of ComfyUI image refs `[{ filename, subfolder, type }]` |
| `overrides` | no | Override generation params (`width`, `height`, `steps`, `sampler`, `scheduler`, `cfgScale`, `guidance`, `negativePrompt`, `seed`) — also accepts `maxIterations`, `humanReview`, `acceptanceGracePeriod` to override per-step review |
| `humanReview` | no | Override human review for this request |
| `acceptanceGracePeriod` | no | Override grace period in seconds |

All three SSE endpoints emit:

| Event | Payload |
|---|---|
| `session` | `{ id, prompt }` (or `{ id, resume: true }` when resuming) |
| `step` | `{ index, type, label, total }` — start of each pipeline step |
| `phase` | `{ step, phase, iteration }` — `prompt_building`, `posing`, `generating`, `reviewing` |
| `token` | `{ step, iteration, phase, token }` — streaming LLM token |
| `prompt` | `{ step, iteration, prompt }` — finalised prompt |
| `progress` | `{ step, iteration, pct }` — ComfyUI progress 0–100 |
| `preview` | `{ step, iteration, url }` — base64 data URL preview frame |
| `image` | `{ step, iteration, url }` |
| `video` | `{ step, url }` — final video URL for video steps |
| `pose` | `{ step, iteration, url }` — extracted pose skeleton image |
| `warning` | `{ step, iteration, message }` — non-fatal issue (e.g. unknown LoRA dropped) |
| `review` | `{ step, iteration, verdict, diagnosis, loras?, poseUsed? }` |
| `human_review` | `{ step, iteration, aiVerdict, aiDiagnosis }` |
| `human_verdict` | `{ step, iteration, accepted, feedback }` |
| `accepted_pending` | `{ step, iteration, gracePeriod, humanReview, maxIterations? }` |
| `acceptance_refused` | `{ step, iteration }` |
| `step_complete` | `{ step, imageUrl?, videoUrl?, accepted }` — step finished |
| `done` | `{ accepted, imageUrl?, videoUrl?, sessionId, prompt, iterations }` |
| `stopped` | `{ step }` — user-aborted; in-progress step cleared |
| `error` | `{ message }` |

### Human review

**`POST /api/generate/human-review/:sessionId`**

```json
{ "stepIndex": 0, "accept": true, "feedback": "try warmer colours" }
```

### Refusing an accepted result

**`POST /api/generate/sessions/:id/refuse-accepted`**

Marks the most recent accepted iteration as refused. Safe on completed sessions.

### Kill a running generation

**`POST /api/generate/kill`**

```json
{ "sessionId": "…" }
```

Aborts the running pipeline, cancels the in-progress ComfyUI job, and emits `stopped`.

### Broadcast event stream

**`GET /api/generate/events`** — SSE stream broadcasting every generation event to all
connected clients. The browser subscribes on load so externally-triggered sessions
(SDAPI, scripts) show live progress in the UI.

### Sessions

```
GET    /api/generate/sessions
GET    /api/generate/sessions/:id
DELETE /api/generate/sessions/:id
```

### Video proxy

**`GET /api/video`** — proxies ComfyUI video output so the browser doesn't need direct
access. Same query string as ComfyUI's `/view` endpoint (`filename`, `subfolder`, `type`).

### Config, models, workflows

```
GET    /api/sessions/config
PATCH  /api/sessions/config

GET    /api/sessions/models/list
POST   /api/sessions/models
PUT    /api/sessions/models/:id
DELETE /api/sessions/models/:id

GET    /api/sessions/workflows
POST   /api/sessions/workflows
PUT    /api/sessions/workflows/:id
DELETE /api/sessions/workflows/:id

GET    /api/sessions/architectures
GET    /api/sessions/assets

GET    /api/sessions/loras          # LoRA registry
POST   /api/sessions/loras/scan     # sync registry against ComfyUI's lora list
PUT    /api/sessions/loras          # update one entry ({ filename, ...fields } in body)
```

### Skills

Each workflow accumulates a **skill**: a prompt-engineering guide the LLM uses when
building prompts, plus optional enforce rules (style mandates) and a blacklist (words
stripped from all generated prompts). The skill is re-synthesised automatically after
every session using accept/reject history (when skill refinement is enabled).

**`GET /api/sessions/skills/:workflowId`**

**`PATCH /api/sessions/skills/:workflowId/notes`**

```json
{ "notes": [ { "id": "…", "type": "enforce", "text": "Always use Danbooru tags", "enabled": true, "auto": false } ] }
```

**`POST /api/sessions/skills/:workflowId/refresh`**

```json
{ "note": "This workflow only produces anime — never attempt photorealistic prompts." }
```

Triggers an immediate re-synthesis. Use the optional `note` to correct wrong lessons the
model has learned; it takes priority over inferred patterns. Returns the updated skill record.

---

## Stable Diffusion WebUI API (`/sdapi/v1`)

Partial [Automatic1111](https://github.com/AUTOMATIC1111/stable-diffusion-webui)
compatible API so existing SD tooling works as a drop-in backend.

| Endpoint | Method | Description |
|---|---|---|
| `/sdapi/v1/txt2img` | POST | Generate (blocking — full iteration loop) |
| `/sdapi/v1/img2img` | POST | Generate with reference images (see Notes) |
| `/sdapi/v1/progress` | GET | Poll progress during a running request |
| `/sdapi/v1/interrupt` | POST | Abort current generation |
| `/sdapi/v1/sd-models` | GET | List configured models |
| `/sdapi/v1/options` | GET/POST | Get/set active workflow via `sd_model_checkpoint` |
| `/sdapi/v1/samplers` | GET | |
| `/sdapi/v1/schedulers` | GET | ComfyUI scheduler names |
| `/sdapi/v1/upscalers` | GET | Stub |
| `/sdapi/v1/latent-upscale-modes` | GET | Stub |
| `/sdapi/v1/sd-vae` | GET | Stub |

**Supported txt2img parameters:** `prompt`, `negative_prompt`, `steps`, `cfg_scale`,
`width`, `height`, `sampler_name`, `scheduler`, `seed`, `batch_size`, `n_iter`,
`override_settings.sd_model_checkpoint`.

`sd_model_checkpoint` accepts a model label (`SDXL Base`), model ID (`sdxl-base`), or
`Label [id]` format. The active workflow is switched to the first workflow whose generate
step uses the matched model.

**Python example:**
```python
import requests, base64

r = requests.post('http://localhost:3000/sdapi/v1/txt2img', json={
    'prompt': 'a tiger in golden light, photorealistic',
    'steps': 26, 'cfg_scale': 3.8, 'width': 1152, 'height': 1152,
})
with open('output.png', 'wb') as f:
    f.write(base64.b64decode(r.json()['images'][0]))
```

### Notes
- The acceptance grace period applies to SDAPI sessions; the browser UI (via the
  broadcast stream) shows the result and a refuse button while it is active.
- `cfg_scale` is forwarded as both `guidance` and `cfgScale`; each architecture uses
  whichever applies.
- `POST /sdapi/v1/img2img`: `init_images` are forwarded to the LLM as vision context
  when vision guidance is enabled. They are also uploaded to ComfyUI and used as
  diffusion references when the active workflow step is configured for `adapter` or
  `init-image` mode. `denoising_strength` maps to `denoise` in `init-image` mode.

---

## Data

```
data/
  config.json       global settings, model registry, workflow registry
  sessions/         one JSON file per session
  skills/           one JSON file per workflow id (skill + notes + outcomes)
```

Each `skills/<workflowId>.json` contains:
- **`skill`** — prompt-engineering guide (e.g. preferred tag format, things to avoid)
- **`notes`** — enforce rules and blacklist words; each has an `enabled` toggle and an
  `auto` flag (LLM-generated vs user-created)
- **`outcomes`** — running accept/reject counts used to synthesise the skill
