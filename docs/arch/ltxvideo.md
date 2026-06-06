# LTX-Video

Lightricks' open-source video diffusion model. One of the fastest and most VRAM-efficient open video models. Checkpoint-based format — the main model goes in `models/checkpoints/`. Available in 0.9.x (2B, stable) and 2.3 (22B, newer). Native ComfyUI support built-in; advanced workflows use the official custom node pack.

## Files needed in ComfyUI

### LTX-Video 0.9.5 (2B — stable, ~8 GB VRAM)

| Field | File | ComfyUI folder |
|---|---|---|
| Checkpoint | `ltx-video-2b-v0.9.5.safetensors` | `models/checkpoints/` |
| Text encoder | `t5xxl_fp16.safetensors` | `models/text_encoders/` |

The VAE is baked into the 0.9.5 checkpoint — no separate VAE file needed.

### LTX-2.3 (22B — higher quality, ~12 GB VRAM)

| Field | File | ComfyUI folder |
|---|---|---|
| Checkpoint | `ltx-2.3-22b-distilled-1.1.safetensors` | `models/checkpoints/` |
| Text encoder | Gemma 3 12B — see release page | `models/text_encoders/gemma-3-12b-it-qat-q4_0-unquantized/` |
| Spatial upscaler *(optional)* | `ltx-2.3-spatial-upscaler-*.safetensors` | `models/latent_upscale_models/` |

## Where to download

- **LTX-Video 0.9.5** — [Hugging Face Lightricks/LTX-Video](https://huggingface.co/Lightricks/LTX-Video)
- **LTX-2.3** — [Hugging Face Lightricks/LTX-2.3](https://huggingface.co/Lightricks/LTX-2.3)
- **T5-XXL text encoder** — [Hugging Face comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders)

## Required custom nodes

Native ComfyUI support is built-in for basic use.

- **ComfyUI-LTXVideo** *(recommended for advanced workflows — LTXVPreprocess, LTXVAddGuide, etc.)* — [Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo)
- **ComfyUI-GGUF** *(optional, for quantised GGUF variants)* — [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF)

## Notes

Generates in ~90 seconds on a 4090, ~7 minutes on a 3060 12 GB for short clips. No negative prompt support. Check the release page for the current LTX-2.3 filename — it may be versioned.
