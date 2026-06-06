# CogVideoX

Zhipu AI's open-source video generation model using a 3D Causal VAE for efficient spatiotemporal compression. Requires the `kijai/ComfyUI-CogVideoXWrapper` custom node. Available in 2B and 5B sizes, with text-to-video and image-to-video variants.

## Files needed in ComfyUI

The wrapper auto-downloads models to `models/CogVideo/` on first use. For manual setup:

### CogVideoX-5B (Text-to-Video)

| Field | File | Location |
|---|---|---|
| Model | Auto-downloaded by wrapper | `models/CogVideo/CogVideoX-5b/` |
| Text encoder (T5) | `t5xxl_fp8_e4m3fn.safetensors` *(if not already present)* | `models/clip/` |

### CogVideoX-5B-I2V (Image-to-Video)

| Field | File | Location |
|---|---|---|
| Model | Auto-downloaded by wrapper | `models/CogVideo/CogVideoX-5b-I2V/` |
| Text encoder (T5) | `t5xxl_fp8_e4m3fn.safetensors` *(if not already present)* | `models/clip/` |

## Where to download

- **CogVideoX-2B** — [Hugging Face THUDM/CogVideoX-2b](https://huggingface.co/THUDM/CogVideoX-2b)
- **CogVideoX-5B** — [Hugging Face THUDM/CogVideoX-5b](https://huggingface.co/THUDM/CogVideoX-5b)
- **CogVideoX-5B-I2V** — [Hugging Face THUDM/CogVideoX-5b-I2V](https://huggingface.co/THUDM/CogVideoX-5b-I2V)
- **CogVideoX 1.5-5B** — [Hugging Face THUDM/CogVideoX1.5-5B](https://huggingface.co/THUDM/CogVideoX1.5-5B)
- **T5 encoder** — [Hugging Face comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders)
- **Single-file converted versions** — [Hugging Face Kijai/CogVideoX-comfy](https://huggingface.co/Kijai/CogVideoX-comfy)
- **Official toolchain** — [GitHub THUDM/CogVideo](https://github.com/THUDM/CogVideo)

## Required custom nodes

- **ComfyUI-CogVideoXWrapper** *(required)* — [kijai/ComfyUI-CogVideoXWrapper](https://github.com/kijai/ComfyUI-CogVideoXWrapper)

Also requires `diffusers>=0.30.1` (`pip install diffusers --upgrade`).

## Notes

The 3D Causal VAE processes frames with 3D convolutions, capturing motion between frames rather than treating each frame independently (which causes flicker in 2D VAE models). Typical CFG: 6. Requires ~24 GB VRAM for the 5B model. Available in 2B (faster) and 5B (higher quality) sizes — no 9B variant exists.
