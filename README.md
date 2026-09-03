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
- **ffmpeg + ffprobe** *(for the Film view)* — nothing to install: `npm install` bundles
  them via `ffmpeg-static` / `ffprobe-static`. See [Film](#optional--film-long-video).

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
| **ComfyUI-LTXVideo** | [Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) | LTX-Video advanced features (`LTXVAddGuide` for I2V, `LTX2LoraLoaderAdvanced` for distilled LoRA) — all nodes used by ComfyRefinery are built into recent ComfyUI builds; install this pack only if nodes are missing | LTX-Video |
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
ChromaHD, Anima, Z-Image, Krea 2) — the LoRA chain is injected right after the model loader.

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

### Optional — Film (long video)

The **Film** view builds a long video shot by shot from a MiniMax H3 model (see
`docs/arch/minimaxh3.md`). It uses `ffmpeg` and `ffprobe` on the ComfyRefinery host for
last-frame capture, reference captures and stitching. **No extra setup is needed**: the
regular `npm install` also installs `ffmpeg-static` and `ffprobe-static`, which bundle a
static binary for your platform (Linux x64/arm64, macOS, Windows), and ComfyRefinery uses
those automatically. The **System** page shows the binary in use and its version.

Overrides, only if you want them: set `FFMPEG_PATH` / `FFPROBE_PATH` to use specific
binaries (they take precedence over the bundled ones), or install a system ffmpeg
(`apt install ffmpeg`, `brew install ffmpeg`, …) which is used when the bundled package
is unavailable for your platform.

### Step 4 — Generate

Type a prompt and click **Generate**. With default settings the LLM builds the prompt,
ComfyUI generates the image, and the AI reviews it — repeating until accepted or the
iteration limit is reached. Disable any or all LLM features in Settings to simplify or
remove the LLM from the loop entirely.

After a session finishes, each step keeps its results and can be revisited:

- **↻ Redo** (step header) re-runs just that step, appending a new variant/take —
  earlier steps keep their outputs (e.g. keep the generated image, roll new video takes).
- **▶ From here** re-runs a step *and everything after it*.
- Click any variant and **Use as step output** (detail pane) to choose which one feeds
  the next step on the following "From here" run; the effective variant shows an
  `Output` badge. Navigate variants with the ‹ › arrows or arrow keys.

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
| Unload the LLM before video jobs | off | Opt-in, for setups where the LLM server and ComfyUI share a GPU. ComfyRefinery makes the configured HTTP call (URL, GET/POST, optional JSON body with `{model}`) right before every video job — workflow video steps and Film takes — which run for minutes and never need the LLM; the server reloads on its next request. Leave off when the LLM runs on another machine or GPU. See [Sharing a GPU between the LLM and ComfyUI](#sharing-a-gpu-between-the-llm-and-comfyui) |

### Sharing a GPU between the LLM and ComfyUI

ComfyUI only sees its own allocations: on a card that also hosts the LLM server, its idea
of "free VRAM" ignores the LLM, and an oversubscribed card can produce corrupt output
silently (a decoder that runs out of memory partway through a clip, for instance) rather
than an error. Two settings make the pair behave:

- **In the LLM server**, let idle models unload. llama-swap: set `globalTTL` (or a per-model
  `ttl`) to a few minutes, so a model that has not been used since the prompt was written
  is gone by the time the decoder needs the memory. Ollama: `OLLAMA_KEEP_ALIVE`.
- **In ComfyRefinery**, tick **Unload the LLM before video jobs** (Settings → LLM) and
  describe your server's unload call. The OpenAI-compatible API has no such call, so this
  is per server: llama-swap → `GET http://host:11434/unload`; Ollama → `POST
  http://host:11434/api/generate` with body `{"model":"{model}","keep_alive":0}`. Before
  each video job the server is asked to release its memory immediately instead of waiting
  for the TTL; the model reloads on the next prompt-writing or review call (seconds from
  page cache). Nothing in ComfyRefinery assumes a particular server, GPU layout, or that
  the two services even share a machine — leave the box off and nothing is called.

With both in place, components placed on the LLM's card (a text encoder or VAE via device
placement) get the whole card during the job, and the LLM gets it back afterwards.

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
| `zimage` | Z-Image | Split only (UNet + CLIP/Qwen-3 4B + VAE); standard ComfyUI nodes | ✓ | — | — | — | — |
| `krea2` | Krea 2 | Split only (UNet + CLIP/Qwen3-VL-4B + Qwen-Image VAE); standard ComfyUI nodes | ✓ | — ³ | — | — | — |

¹ Anima IP-Adapter is implemented but disabled — weights not yet publicly released.  
² Anima pose ControlNet uses `AnimaLLLiteApply` (kohya-ss/ComfyUI-Anima-LLLite) rather than standard `ControlNetApplyAdvanced`; requires DWPose via comfyui_controlnet_aux for skeleton extraction.  
Structural CN: extracts depth/edges from a previous step's output as structure-only guidance while the model generates pure txt2img — used for cross-model style transfer (e.g. Flux 2 Klein → Illustrious SDXL). Requires comfyui_controlnet_aux preprocessor nodes and a matching ControlNet model.  
³ Krea 2 has native reference-latent conditioning in ComfyUI core, but it's not wired up in ComfyRefinery yet — see [docs/arch/krea2.md](docs/arch/krea2.md).

### Video

Video architectures are used in **video steps** within a workflow. They generate a short
clip from the final prompt text (T2V), the previous step's output image (I2V), or
uploaded reference images (R2V, where supported). All video steps run LLM prompt
refinement with a video-specific system prompt (motion, camera movement, scene dynamics)
before submitting to ComfyUI. For I2V/R2V, the input image(s) are included in the LLM
prompt to guide motion description. Duration is set in seconds in the workflow editor
and converted to frames automatically. When the step's width/height are left blank,
I2V runs match the input image's aspect ratio (fitted to the model's pixel budget) —
so a portrait generate step chains into a portrait video.

| Key | Name | Loader | Audio |
|---|---|---|---|
| `wanvideo` | WanVideo (Wan 2.2) | Split (UNet × 2 + CLIP/T5 + VAE) | — |
| `hunyuanvideo` | HunyuanVideo | Split (UNet + CLIP/T5 + VAE) | — |
| `ltxvideo` | LTX-Video / LTX-Video 2.3 AV | Checkpoint (`LTXAVTextEncoderLoader` for 2.3 AV: Gemma 3 12B + T5 from checkpoint) | ✓ ¹ |
| `cogvideox` | CogVideoX | Checkpoint + VAE + CLIP | — |
| `minimaxh3` | MiniMax H3 (Hailuo 3) | Split (UNet + Qwen3-VL-32B + video/audio VAEs) | ✓ ² |

¹ LTX-Video 2.3 AV (`ltx-2.3-22b-dev-fp8.safetensors`) embeds an audio VAE in the same checkpoint — no additional download needed. Enable the **Generate audio** toggle in model settings. Output is a single MP4 with the audio track embedded. Requires a Gemma 3 12B text encoder (`gemma_3_12B_it_fp4_mixed.safetensors`) in `models/text_encoders/`; earlier LTX-Video models use a standard T5-XXL CLIP loader instead.

² MiniMax H3 generates native stereo audio in the same sampling pass — set the **Audio VAE file** in model settings (leave blank to skip audio). It is also the first architecture with reference-to-video: configure the optional **Ref2VA UNet file** and uploaded references route to `MiniMaxH3ReferenceToVideo` automatically, cited in the prompt as `<Picture 1>…<Picture N>`. Guidance-free (no negative prompt / CFG); optional 8-step (FL2VA) and 4-step (Ref2VA) turbo LoRAs. Requires ComfyUI ≥ 0.30.0 — see [docs/arch/minimaxh3.md](docs/arch/minimaxh3.md).

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

**`POST /api/generate/continue/:id`** — resume an existing session (full re-run).

**`POST /api/generate/rerun/:id`** — partial re-run: body `{ "fromStep": 1, "toStep": 1 }`.
Runs only steps `fromStep..toStep` (default `toStep` = last), chaining from the kept
output of the step before `fromStep` (honoring any variant selection). Streams the same
SSE events, replaying full history first.

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
| `video` | `{ step, iteration, url }` — final video URL for a video-step take |
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

Marks an accepted iteration as refused. Pass `{ "stepIndex": 0, "iterationN": 2 }` to
target a specific iteration; with an empty body the most recent accepted iteration is
used. Safe on completed sessions.

### Selecting a variant

**`POST /api/generate/sessions/:id/select`**

```json
{ "stepIndex": 0, "iteration": 2 }
```

Picks which iteration (variant) of a step feeds downstream steps on the next partial
re-run. Recomputes the step's output URLs; a fresh run of the step clears the selection.

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

### Media proxy

**`GET /api/video`** — proxies ComfyUI video output so the browser doesn't need direct
access. Same query string as ComfyUI's `/view` endpoint (`filename`, `subfolder`, `type`).

**`GET /api/audio`** — proxies ComfyUI audio output (used when audio is embedded separately). Same query string as `/api/video`.

### Film projects

The Film view builds a long video shot by shot from a MiniMax H3 model: a project pins a
model entry and its own format/generation settings (no workflow), keeps a per-project
reference bank (characters, locations, props, styles, voices), and grows a timeline one
segment at a time. A scene can start from a still made in place with any image model
(anima, SDXL, …) — "✨ Generate start image" on the segment — or from an uploaded / session
image; each segment runs one ~5 s take per attempt; approving a take captures its last
frame for the next segment and adds a beat to the running script.
Requires ffmpeg on the host. See `docs/arch/minimaxh3.md` for the continue / cut modes.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/projects` | `{ projects: [summary] }` |
| `GET` | `/api/projects/capabilities` | `{ ffmpeg: { available, version, path, ffprobe, error } }` |
| `POST` | `/api/projects` | `{ title, modelId, logline? }` |
| `GET` / `PUT` / `DELETE` | `/api/projects/:id` | `PUT`: `title`, `logline`, `gen`, `format` (reframe any time; export re-encodes mixed sizes), `modelId` (until a take is approved) |
| `POST` / `PUT` / `DELETE` | `/api/projects/:id/refs[/:rid]` | Reference bank entries `{ kind, name, description, pinned, media? }` |
| `POST` / `DELETE` | `/api/projects/:id/refs/:rid/media[/:mid]` | `{ type: 'image'\|'audio', source: { type: 'upload'\|'session' }, name?, data? (base64), imageUrl? }` |
| `POST` | `/api/projects/:id/images/prompt` | SSE — write an image prompt in the model's own language from a plain description: `{ modelId, intent, steering?, segmentId? }` (`token`, `prompt`, `done`) |
| `POST` | `/api/projects/:id/images/generate` | SSE — render a still with any image model into the bank: `{ modelId, prompt, seed?, width?, height?, refId? \| newRef?, segmentId? }`; with `segmentId` it becomes that segment's start frame (`image_start`, `phase`, `progress`, `preview`, `image`, `done`) |
| `POST` | `/api/projects/:id/takes/:tid/capture` | `{ refId? \| newRef?, frame?: t }` or `{ …, audio?: [from, to] }` → frame PNG / WAV into the bank |
| `POST` / `PUT` / `DELETE` | `/api/projects/:id/segments[/:sid]` | `{ intent, steering, start: { mode: 'continue'\|'cut', startImage?, includePrevTail? }, refIds, frames, seed, loras: [{ name, weight }] }` |
| `POST` | `/api/projects/:id/segments/:sid/prompt` | SSE — LLM prompt preview (`phase`, `token`, `prompt`, `done`) |
| `POST` | `/api/projects/:id/segments/:sid/run` | SSE — one take: `take_start`, `phase`, `token`, `prompt`, `progress`, `warning`, `video`, `take_complete`, `done` / `stopped` / `error`. Body `{ prompt?, seed?, intent?, steering? }` |
| `POST` | `/api/projects/:id/segments/:sid/takes/:tid/verdict` | `{ verdict: 'approved'\|'rejected', note? }` → `{ project, staled, beat, nextSegment }`. A rejection note steers the next take's prompt |
| `POST` | `/api/projects/:id/export` | Stitches approved takes → `{ url, file, durationSec, clips }` |
| `POST` | `/api/projects/:id/kill` | Stops the running take |
| `GET` | `/api/projects/:id/media/<path>` | Local clips, last frames, reference files, export |

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
  projects/         one JSON file per Film project + <id>/{clips,refs,export}/ media
```

Each `skills/<workflowId>.json` contains:
- **`skill`** — prompt-engineering guide (e.g. preferred tag format, things to avoid)
- **`notes`** — enforce rules and blacklist words; each has an `enabled` toggle and an
  `auto` flag (LLM-generated vs user-created)
- **`outcomes`** — running accept/reject counts used to synthesise the skill
