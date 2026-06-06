# Anima

A flow-matching diffusion model using Qwen-3 as its text encoder and a custom Qwen-Image VAE. Requires the `er_sde` sampler, available in recent ComfyUI builds or via the RES4LYF custom node pack.

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | e.g. `anima.safetensors` | `models/diffusion_models/` |
| CLIP-L (text encoder) | e.g. `qwen_3_06b_base.safetensors` | `models/clip/` or `models/text_encoders/` |
| VAE | Qwen-Image VAE — see release page | `models/vae/` |

## Where to download

- **Anima UNet + VAE** — Check the Anima model release page on Hugging Face or Civitai for current recommended files
- **Qwen-3 encoder** — Check the release notes for the specific quantised filename to use

## Required custom nodes

- **RES4LYF** *(for the `er_sde` sampler, if not in your ComfyUI build)* — [ClownsharkBatwing/RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF)

## Notes

CFG scale applies. `er_sde` at 30 steps is a common starting point. Check the model release page for current recommended settings.
