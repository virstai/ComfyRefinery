# WanVideo (Wan 2.2)

Alibaba's open-source video generation model. Wan 2.2 uses a Mixture-of-Experts (MoE) architecture — the 14B models require two separate diffusion model files (high-noise expert for layout/structure, low-noise expert for detail refinement). The 5B TI2V variant uses a single UNet. Supports text-to-video (T2V) and image-to-video (I2V).

ComfyRefinery uses **native ComfyUI nodes only** — no custom node packs required.

## Files needed in ComfyUI

### Text-to-Video (T2V) — 14B

| Field | File | ComfyUI folder |
|---|---|---|
| High-noise UNet | `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models/` |
| Low-noise UNet | `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models/` |
| Text encoder | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` *(fp8_scaled and bf16 both supported)* | `models/text_encoders/` |
| VAE | `wan_2.1_vae.safetensors` | `models/vae/` |

### Image-to-Video (I2V) — 14B

| Field | File | ComfyUI folder |
|---|---|---|
| High-noise UNet | `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models/` |
| Low-noise UNet | `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models/` |
| Text encoder | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` *(fp8_scaled and bf16 both supported)* | `models/text_encoders/` |
| VAE | `wan_2.1_vae.safetensors` | `models/vae/` |
| CLIP Vision *(optional)* | `sigclip_vision_patch14_384.safetensors` | `models/clip_vision/` |

### Text+Image-to-Video (TI2V) — 5B (single UNet)

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | `wan2.2_ti2v_5B_fp16.safetensors` | `models/diffusion_models/` |
| Text encoder | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` *(fp8_scaled and bf16 both supported)* | `models/text_encoders/` |
| VAE | `wan2.2_vae.safetensors` | `models/vae/` |

> **VAE warning — 14B I2V models require `wan_2.1_vae`.**
> The `WanImageToVideo` node produces a different latent format depending on which VAE is connected:
> - `wan_2.1_vae.safetensors` → 36-channel latent (correct for 14B I2V)
> - `wan2.2_vae.safetensors` → 64-channel latent (TI2V format — wrong for 14B I2V, causes a channel mismatch error)
>
> Always use `wan_2.1_vae.safetensors` with any 14B model. Only the 5B TI2V model uses `wan2.2_vae`.

## MoE cascade (14B models)

Both UNets are required for 14B models. ComfyRefinery implements the MoE split with two `KSamplerAdvanced` nodes:

1. **High-noise sampler** — runs steps `0 → ⌈steps/2⌉` with `add_noise: enable`, `return_with_leftover_noise: enable`
2. **Low-noise sampler** — runs steps `⌈steps/2⌉ → 10000` with `add_noise: disable`, `return_with_leftover_noise: disable`

Each sampler gets its own `ModelSamplingSD3` (shift = 8.0) applied to its respective UNet.

## Where to download

- **Wan 2.2 ComfyUI repackaged (recommended)** — [Hugging Face Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/tree/main/split_files/)
- **Official Wan-AI organisation** — [Hugging Face Wan-AI](https://huggingface.co/Wan-AI)
- **Optimised fp8 versions** — [Hugging Face Kijai/WanVideo_comfy](https://huggingface.co/Kijai/WanVideo_comfy)

## Notes

Primary use is **image-to-video (I2V)** — animates the output image from a previous workflow step. 14B models require ~20 GB VRAM at fp8. Video output is 480p or 720p depending on the workflow. The 5B TI2V model accepts both text and image input with a single UNet and runs on ~12 GB VRAM.

Pre-quantized models (`_fp8_scaled.safetensors`) should use `modelQuantization: "default"` in the model settings — setting it to `fp8_e4m3fn` would double-quantize an already-quantized model.
