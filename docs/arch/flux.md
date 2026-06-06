# Flux.1

Black Forest Labs' Flux.1 — a flow-matching diffusion model with exceptional prompt adherence. Available as Dev (non-commercial) and Schnell (Apache 2.0). Supports single-file checkpoint or split-load (separate UNet + text encoders + VAE).

## Files needed in ComfyUI

### Option A — Single checkpoint

| Field | File | ComfyUI folder |
|---|---|---|
| Checkpoint | `flux1-dev.safetensors` or `flux1-schnell.safetensors` | `models/checkpoints/` |
| CLIP-L | `clip_l.safetensors` | `models/text_encoders/` |
| T5-XXL | `t5xxl_fp8_e4m3fn.safetensors` | `models/text_encoders/` |
| VAE | `ae.safetensors` | `models/vae/` |

> Even in checkpoint mode, Flux requires the CLIP-L and T5-XXL text encoders separately.

### Option B — Split loading (lower VRAM)

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | `flux1-dev.safetensors` or `flux1-schnell.safetensors` | `models/diffusion_models/` |
| CLIP-L | `clip_l.safetensors` | `models/text_encoders/` |
| T5-XXL | `t5xxl_fp8_e4m3fn.safetensors` | `models/text_encoders/` |
| VAE | `ae.safetensors` | `models/vae/` |

### Redux *(optional — adapter reference mode)*

| Field | File | ComfyUI folder |
|---|---|---|
| Adapter model | `flux1-redux-dev.safetensors` | `models/style_models/` |
| CLIP Vision | `sigclip_vision_patch14_384.safetensors` | `models/clip_vision/` |

## Where to download

- **Flux.1 Dev** — [Hugging Face black-forest-labs/FLUX.1-dev](https://huggingface.co/black-forest-labs/FLUX.1-dev) *(requires accepting license)*
- **Flux.1 Schnell** — [Hugging Face black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell)
- **Text encoders (CLIP-L + T5-XXL fp8)** — [Hugging Face comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders)
- **VAE** — Same repo as Flux.1 Dev above (`ae.safetensors`)
- **Redux + CLIP Vision** — [Hugging Face black-forest-labs/FLUX.1-Redux-dev](https://huggingface.co/black-forest-labs/FLUX.1-Redux-dev)

## Notes

CFG (guidance scale) for Flux is typically 1 — it uses flow matching, not classifier-free guidance. No negative prompt needed. Schnell generates in ~4 steps; Dev typically uses 20–30. Community fine-tunes are on [Civitai](https://civitai.com) (filter by Flux).
