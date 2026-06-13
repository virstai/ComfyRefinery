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

> **Note:** This is a vibe-coded / AI-assisted project. Most features work, but many have not been fully human-tested — especially less common model architectures and more complex multi-step workflows. Expect rough edges and bugs.

## Prerequisites

- **Node.js** 18+
- **An OpenAI-compatible LLM** with vision support — Ollama (`gemma4:31b`, `llava:13b`),
  LM Studio, OpenAI, vLLM, or any server that speaks `/v1/chat/completions`
- **ComfyUI** running with at least one model loaded

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

- **LLM base URL** — any OpenAI-compatible server, e.g. `http://127.0.0.1:11434/v1`
  for Ollama or `https://api.openai.com/v1` for OpenAI.
- **API key** — leave blank for local servers.
- **LLM model** — the model name your server exposes (e.g. `gemma4:31b`). **Must be
  vision-capable** (able to accept images) — it receives generated images for review
  and optionally reference images for prompt building.
- **ComfyUI URL** — default `http://127.0.0.1:8188`.

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
   | Upscale model | `models/upscale_models/` |

3. Give the model a label and save.

### Step 3 — Add a Workflow

Open **Workflows** (▶) and click **Add workflow**:

1. Add a **generate step** and select the Model you just created.
2. Configure resolution, sampler, scheduler, and review settings.
3. Optionally add an **upscale** or **video** step after the generate step.
4. Click **Use** to make it the active workflow.

### Optional — LoRAs

Open **LoRAs** (✦) and click **Rescan ComfyUI** to discover LoRA files. Each entry's
architecture is auto-detected from its training metadata where possible; assign it
manually otherwise (untagged LoRAs are never offered to the LLM). Add trigger words and
a description — the LLM uses these to decide when a LoRA helps.

In a workflow generate step you can then pin **always-on LoRAs** (e.g. turbo LoRAs —
remember to set the step's Steps/CFG to the LoRA's recommended values) and/or enable
**LLM may add LoRAs**, which lets the prompt-builder agent apply catalog LoRAs per prompt.

LoRAs are supported on every image architecture (SD 1.5, SDXL, SD3, Flux, Flux 2,
ChromaHD, Anima) — the LoRA chain is injected right after the model loader.

### Optional — Pose ControlNet

Currently supported on the **anima** architecture (see the in-app Anima setup guide for
the required custom nodes and weights). Select the ControlNet weights in the **model's**
settings, then set a workflow step's **Pose mode** to `auto` (the LLM decides per prompt)
or `always`. A pose draft is rendered with the step's model from a detection-friendly
pose description, DWPose extracts the skeleton, and the generation follows it. If no
pose can be extracted, the step fails rather than generating without pose control.
Strength below ~1.0 lets the prompt override the pose.

**Anima IP-Adapter** is implemented but currently **disabled**: the adapter weights
from the comfyui-anima-ipadapter project are still in training and not publicly
released. The "Adapter conditioning" reference mode is therefore not offered for
anima steps; it will be re-enabled (one capability flag) once the weights ship.

### Step 4 — Generate

Type a prompt and click **Generate**. The LLM builds the prompt, ComfyUI generates
the image, and the AI reviews it — repeating until accepted or the iteration limit
is reached.

### Environment variable overrides

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | LLM base URL — `/v1` is appended automatically; accepts any OpenAI-compat server |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | ComfyUI base URL |
| `OLLAMA_MODEL` | _(from config)_ | LLM model name |

## Development

```bash
npm run dev     # Express --watch on :3000 + Vite hot-reload on :5173
npm test        # all tests
```

## Supported architectures

### Image

| Key | Name | Loader | LoRA | Adapter | Pose ControlNet |
|---|---|---|---|---|---|
| `sd15` | SD 1.5 / SD 2.x | Checkpoint + optional external VAE | ✓ | IPAdapter | — |
| `sdxl` | SDXL | Checkpoint + optional VAE + optional refiner | ✓ | IPAdapter | — |
| `flux` | Flux.1 | Checkpoint, or split (UNet + CLIP-L + T5-XXL + VAE) | ✓ | Redux | — |
| `flux2` | Flux 2 (Dev / Klein) | Split only (UNet + CLIP/Mistral or Qwen-3 + VAE) | ✓ | ReferenceLatent | — |
| `sd3` | SD 3 / SD 3.5 | Checkpoint + optional external VAE | ✓ | — | — |
| `chroma` | ChromaHD | Split only (UNet + T5 encoder + VAE); standard ComfyUI nodes | ✓ | — | — |
| `anima` | Anima | Split only (UNet + CLIP/Qwen-3 + Qwen-Image VAE); needs `er_sde` sampler | ✓ | — ¹ | LLLite |

¹ Anima IP-Adapter is implemented but disabled — weights not yet publicly released.

### Video

Video architectures are used in **video steps** within a workflow. They generate a short
clip from the final prompt text (T2V) or the previous step's output image (I2V).

| Key | Name | Loader |
|---|---|---|
| `wanvideo` | WanVideo (Wan 2.2) | Split (UNet + CLIP/T5 + VAE) |
| `hunyuanvideo` | HunyuanVideo | Split (UNet + CLIP/T5 + VAE) |
| `ltxvideo` | LTX-Video | Split (UNet + CLIP/T5 + VAE) |
| `cogvideox` | CogVideoX | Checkpoint + VAE + CLIP |

## Settings

| Setting | Default | Description |
|---|---|---|
| Max iterations | 3 | Generate-review cycles per run (overridable per workflow step) |
| Acceptance grace period | 10 s | Hold after acceptance before finalising; 0 = disabled |
| Human review | off | Pause after each iteration for manual accept/reject |

### Acceptance grace period

When the AI accepts an iteration the result is held for a configurable window. During
this time a **Refuse** button appears, letting you reject without restarting. After the
timer the session completes normally. You can also refuse after the session ends — open
the iteration modal and use **Continue session** to keep iterating.

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
every session using accept/reject history.

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
- `POST /sdapi/v1/img2img`: `init_images` are always forwarded to the LLM as vision
  context (the prompt builder sees them). They are also uploaded to ComfyUI and used as
  diffusion references when the active workflow step is configured for `adapter` or
  `init-image` mode; otherwise only the vision context path is active.
  `denoising_strength` maps to `denoise` in `init-image` mode.

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
