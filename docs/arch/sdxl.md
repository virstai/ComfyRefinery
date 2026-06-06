# SDXL

Stable Diffusion XL — native 1024×1024 checkpoint format with an optional two-stage refiner. Wide model library on Civitai; most community SDXL models are single-file checkpoints.

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| Checkpoint | e.g. `sd_xl_base_1.0.safetensors` | `models/checkpoints/` |
| VAE *(optional)* | `sdxl-vae-fp16-fix.safetensors` | `models/vae/` |
| Refiner checkpoint *(optional)* | `sd_xl_refiner_1.0.safetensors` | `models/checkpoints/` |
| IPAdapter model *(optional, adapter mode only)* | e.g. `ip-adapter_sdxl.safetensors` | `models/ipadapter/` |
| CLIP Vision *(optional, required with IPAdapter)* | `clip_vision_ViT-H.safetensors` | `models/clip_vision/` |

The fp16-fix VAE is strongly recommended over the base SDXL VAE — it prevents NaN colour artefacts when running in fp16.

## Where to download

- **SDXL base + refiner** — [Hugging Face stabilityai/stable-diffusion-xl-base-1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)
- **Community SDXL checkpoints** — [Civitai](https://civitai.com) (filter by SDXL)
- **VAE (fp16-fix)** — [Hugging Face madebyollin/sdxl-vae-fp16-fix](https://huggingface.co/madebyollin/sdxl-vae-fp16-fix)
- **IPAdapter models + CLIP Vision** — [Hugging Face h94/IP-Adapter](https://huggingface.co/h94/IP-Adapter) (`models/sdxl/` folder)

## Required custom nodes

- **IPAdapter** *(only if using adapter reference mode)* — [cubiq/ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus)

## Notes

Refiner switch at 0.8 is a common starting point. Skip the refiner for faster generation. Typical CFG: 7–9. Negative prompts work well.
