# Anima

A flow-matching diffusion model using Qwen-3 as its text encoder and a custom Qwen-Image VAE. Requires the `er_sde` sampler, available in recent ComfyUI builds or via the RES4LYF custom node pack.

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | e.g. `anima.safetensors` | `models/diffusion_models/` |
| CLIP-L (text encoder) | e.g. `qwen_3_06b_base.safetensors` | `models/clip/` or `models/text_encoders/` |
| VAE | Qwen-Image VAE — see release page | `models/vae/` |
| Adapter model *(optional, adapter mode only)* | e.g. `anima_ipadapter.safetensors` | anywhere on disk — set the full path |

## Where to download

- **Anima UNet + VAE** — [circlestone-labs/Anima on Hugging Face](https://huggingface.co/circlestone-labs/Anima) or [Civitai](https://civitai.com/models/2458426/anima-official)
- **Qwen-3 encoder** — see the Anima release notes for the specific quantised filename
- **Anima IP-Adapter weights** — check the [comfyui-anima-ipadapter releases](https://github.com/Wenaka2004/comfyui-anima-ipadapter) or the CircleStone Labs Hugging Face org for released adapter checkpoints

## Required custom nodes

- **RES4LYF** *(for the `er_sde` sampler, if not in your ComfyUI build)* — [ClownsharkBatwing/RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF)
- **comfyui-anima-ipadapter** *(only if using adapter reference mode)* — [Wenaka2004/comfyui-anima-ipadapter](https://github.com/Wenaka2004/comfyui-anima-ipadapter)

## Reference adapter (IP-Adapter) setup

> **Note:** The Anima IP-Adapter weights are not yet publicly available — they are still being trained by CircleStone Labs. The node support is wired up and ready; check the [comfyui-anima-ipadapter repo](https://github.com/Wenaka2004/comfyui-anima-ipadapter) or the CircleStone Labs Hugging Face org for a release announcement.

Once weights are released: Anima's IP-Adapter uses **SigLIP2** (`google/siglip2-base-patch16-512`) as its vision encoder — downloaded automatically from Hugging Face on first use (~4 GB VRAM while encoding, unloaded after). No CLIP Vision model file is needed in ComfyUI.

1. Install the `comfyui-anima-ipadapter` custom node
2. Download the Anima IP-Adapter `.safetensors` checkpoint and place it in `models/ipadapter/`
3. In the model editor, select it from the **Adapter model** dropdown (same list as IPAdapter models)
4. Set a workflow step's reference strategy to **adapter** mode

Weight defaults to 1.0 (full effect). Lower it (0.5–0.8) if the reference is overriding the text prompt too strongly.

## Notes

CFG scale applies. `er_sde` at 30–35 steps is a common starting point. Check the model release page for current recommended settings.
