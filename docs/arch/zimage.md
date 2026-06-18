# Z-Image

**Architecture key:** `zimage`  
**Loading mode:** Split (UNETLoader + CLIPLoader + VAELoader)  
**Custom nodes required:** None — uses standard ComfyUI nodes only

Z-Image is a 6B-parameter Single-Stream Diffusion Transformer (S3-DiT) from Alibaba's Tongyi Lab. It supports classifier-free guidance (CFG), negative prompts, and is designed as a foundation model for community LoRA fine-tuning. Licensed Apache 2.0.

- HuggingFace: [Tongyi-MAI/Z-Image](https://huggingface.co/Tongyi-MAI/Z-Image)
- GitHub: [Tongyi-MAI/Z-Image](https://github.com/Tongyi-MAI/Z-Image)

---

## Model Files

Download all three files and place them in the directories below.

| File | Directory | Download |
|------|-----------|----------|
| `z_image_bf16.safetensors` | `ComfyUI/models/diffusion_models/` | [Comfy-Org/z_image on HuggingFace](https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors) |
| `qwen_3_4b.safetensors` | `ComfyUI/models/text_encoders/` | [Comfy-Org/z_image_turbo on HuggingFace](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors) |
| `ae.safetensors` | `ComfyUI/models/vae/` | [Comfy-Org/z_image_turbo on HuggingFace](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors) |

> **Note:** `ae.safetensors` is the same VAE used by Flux.1. If you already have it in `models/vae/` from a Flux setup, you can reuse it — just set the VAE field to the same filename.

---

## ComfyRefinery Model Config

In the Models panel, create a new model with:

- **Architecture:** Z-Image
- **Diffusion model (UNet):** `z_image_bf16.safetensors`
- **CLIP / Text encoder:** `qwen_3_4b.safetensors`
- **VAE:** `ae.safetensors`
- **CFG scale:** 4.0 (recommended range: 3–5)
- **Negative prompt:** optional; the model responds well to negative prompting

---

## Capabilities

### LoRA

Z-Image is a non-distilled foundation model designed for LoRA fine-tuning. Standard `LoraLoader` nodes are used — add LoRAs via the workflow step editor as with any other architecture.

### img2img (init-image)

Supported. Use `referenceStrategy.diffusion.mode: "init-image"` in the workflow step. Default denoise is 0.6.

### Adapter (IP-Adapter)

Not available — no adapter weights have been released for Z-Image.

### ControlNet

Not available — no ControlNet weights have been released yet. The model is noted as a suitable base for future ControlNet development; support can be added when weights ship.

---

## Recommended Settings

| Parameter | Value | Notes |
|-----------|-------|-------|
| Resolution | 1024×1024 | Supports 512×512 to 2048×2048, any aspect ratio |
| Steps | 25–50 | 25 is a good starting point |
| CFG scale | 3–5 | Default 4.0 |
| Sampler | `res_multistep` | Requires a recent ComfyUI build — use nightly for portable installs |
| Scheduler | `simple` | |

---

## Known Limitations

- **`res_multistep` sampler** requires a recent ComfyUI build. Desktop and Cloud versions update automatically; portable installs should use the nightly build.
- **ControlNet** weights are not yet available. Watch the [Tongyi-MAI/Z-Image GitHub](https://github.com/Tongyi-MAI/Z-Image) for releases.
- **Adapter (IP-Adapter)** weights are not yet available.
