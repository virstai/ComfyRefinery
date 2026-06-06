# HunyuanVideo

Tencent's open-source video generation model using a DiT (Diffusion Transformer) architecture. Supports text-to-video (T2V) and image-to-video (I2V). Has native ComfyUI support — no custom nodes required on recent ComfyUI builds.

## Files needed in ComfyUI

### Text-to-Video (T2V)

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | `hunyuan_video_t2v_720p_bf16.safetensors` | `models/diffusion_models/` |
| Text encoder (CLIP) | `clip_l.safetensors` | `models/text_encoders/` |
| Text encoder (LLaVA) | `llava_llama3_fp8_scaled.safetensors` | `models/text_encoders/` |
| VAE | `hunyuan_video_vae_bf16.safetensors` | `models/vae/` |

### Image-to-Video (I2V)

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | `hunyuan_video_image_to_video_720p_bf16.safetensors` | `models/diffusion_models/` |
| Text encoder (CLIP) | `clip_l.safetensors` | `models/text_encoders/` |
| Text encoder (LLaVA) | `llava_llama3_fp8_scaled.safetensors` | `models/text_encoders/` |
| CLIP Vision *(I2V only)* | `llava_llama3_vision.safetensors` | `models/clip_vision/` |
| VAE | `hunyuan_video_vae_bf16.safetensors` | `models/vae/` |

> The main model goes in `models/diffusion_models/` — not `models/checkpoints/`. Two text encoders are required (CLIP-L + LLaVA-LLaMA3); the native ComfyUI `DualCLIPLoader` node set to `hunyuan_video` mode loads both.

## Where to download

- **ComfyUI repackaged (recommended)** — [Hugging Face Comfy-Org/HunyuanVideo_repackaged](https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files)
- **Official Tencent release** — [Hugging Face tencent/HunyuanVideo](https://huggingface.co/tencent/HunyuanVideo)

## Required custom nodes

Native ComfyUI support is built-in (uses standard `DualCLIPLoader` + `EmptyHunyuanLatentVideo` nodes). Keep ComfyUI updated to access the latest native nodes.

- **ComfyUI-HunyuanVideoWrapper** *(optional, for older ComfyUI or additional features)* — [kijai/ComfyUI-HunyuanVideoWrapper](https://github.com/kijai/ComfyUI-HunyuanVideoWrapper)

## Notes

Requires ~16 GB VRAM (24 GB recommended). Output is 720p. T2V and I2V use different UNet checkpoint files — check the repackaged repo for the current filenames.
