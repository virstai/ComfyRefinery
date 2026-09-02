# LTX-Video

Lightricks' open-source video diffusion model. One of the fastest and most VRAM-efficient open video models. Checkpoint-based format — the main model goes in `models/checkpoints/`. Available in 0.9.x (2B, stable) and 2.3 (22B, newer). Native ComfyUI support built-in; advanced workflows use the official custom node pack.

## Files needed in ComfyUI

### LTX-Video 0.9.5 (2B — stable, ~8 GB VRAM)

| Field | File | ComfyUI folder |
|---|---|---|
| Checkpoint | `ltx-video-2b-v0.9.5.safetensors` | `models/checkpoints/` |
| Text encoder | `t5xxl_fp16.safetensors` | `models/text_encoders/` |

The VAE is baked into the 0.9.5 checkpoint — no separate VAE file needed.

### LTX-2.3 (22B — higher quality, ~12 GB VRAM fp8)

| Field | File | ComfyUI folder | Notes |
|---|---|---|---|
| Checkpoint (dev) | `ltx-2.3-22b-dev-fp8.safetensors` | `models/checkpoints/` | Base model; used by T2V and I2V blueprints |
| Checkpoint (distilled) | `ltx-2.3-22b-distilled-fp8.safetensors` | `models/checkpoints/` | Faster; used by First-Last-Frame blueprint |
| Text encoder | `gemma_3_12B_it_fp4_mixed.safetensors` | `models/text_encoders/` | Required for all LTX-2.3 workflows |
| Distilled guidance LoRA | `ltx-2.3-22b-distilled-lora-384.safetensors` | `models/loras/` | Strongly recommended; improves quality/speed |
| Spatial upscaler *(optional)* | `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | `models/latent_upscale_models/` | 2× latent upscale pass |

## Where to download

### LTX-2.3 (from built-in ComfyUI blueprints)

```bash
cd /path/to/ComfyUI/models

# Main checkpoint (dev fp8) — ~22B params
wget -P checkpoints/ "https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-dev-fp8.safetensors"

# Distilled checkpoint — for First-Last-Frame workflow
wget -P checkpoints/ "https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors"

# Text encoder (Gemma 3 12B fp4)
wget -P text_encoders/ "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors"

# Distilled guidance LoRA (recommended)
wget -P loras/ "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-lora-384.safetensors"

# Spatial upscaler (optional)
wget -P latent_upscale_models/ "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
```

- **LTX-Video 0.9.5** — [Hugging Face Lightricks/LTX-Video](https://huggingface.co/Lightricks/LTX-Video)
- **LTX-2.3 fp8 models** — [Hugging Face Lightricks/LTX-2.3-fp8](https://huggingface.co/Lightricks/LTX-2.3-fp8)
- **LTX-2.3 LoRAs / upscaler** — [Hugging Face Lightricks/LTX-2.3](https://huggingface.co/Lightricks/LTX-2.3)
- **T5-XXL text encoder** (for 0.9.5) — [Hugging Face comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders)

## Audio generation (LTX-AV)

LTX-2.3 22B is the audio-video variant of the model. When **Generate audio** is enabled in model settings, ComfyRefinery wires in the built-in audio nodes alongside the video sampler. No extra model download is needed — the audio VAE is embedded in the same checkpoint.

| What changes | Detail |
|---|---|
| Audio VAE | Extracted from `ltx-2.3-22b-dev-fp8.safetensors` via `LTXVAudioVAELoader` |
| Output | `.flac` audio file alongside the `.mp4` video |
| Route | `/api/audio?filename=...` proxied from ComfyUI output folder |
| SSE events | `audio { step, url }` emitted after `video`; `step_complete` and `done` include `audioUrl` |

Enable via the **Generate audio** checkbox in model settings. Disabled by default.

## Required custom nodes

No custom nodes required — all nodes used are built into ComfyUI core (`LTXAVTextEncoderLoader`, `LTXVConditioning`, `LTXVEmptyLatentAudio`, `LTXVConcatAVLatent`, `LTXVSeparateAVLatent`, etc.).

- **ComfyUI-GGUF** *(optional, for quantised GGUF variants)* — [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF)

## Notes

Generates in ~90 seconds on a 4090, ~7 minutes on a 3060 12 GB for short clips. No negative prompt support.

**I2V dimensions follow the input image.** When a video step chains from a previous step (or uses an uploaded reference as its first frame) and does not pin both `width` and `height`, ComfyRefinery derives the video size from the input image's aspect ratio: fitted to this arch's default pixel budget, rounded to its 32-pixel grid, with neither edge exceeding the default long edge. Pin one dimension to keep it and let the other follow the image; pin both to disable the follow entirely.
