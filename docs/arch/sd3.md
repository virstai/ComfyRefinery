# SD 3 / SD 3.5

Stability AI's third-generation architecture using a Multimodal Diffusion Transformer (MMDiT). Single checkpoint format; SD 3.5 Large and Medium are the most capable variants.

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| Checkpoint | e.g. `sd3.5_large.safetensors` | `models/checkpoints/` |
| VAE *(optional)* | Baked into most checkpoints — leave blank unless you have a standalone file | `models/vae/` |

SD 3 / 3.5 checkpoints include text encoders internally; ComfyUI loads them automatically.

## Where to download

- **SD 3 Medium** — [Hugging Face stabilityai/stable-diffusion-3-medium](https://huggingface.co/stabilityai/stable-diffusion-3-medium) *(requires accepting license)*
- **SD 3.5 Large** — [Hugging Face stabilityai/stable-diffusion-3.5-large](https://huggingface.co/stabilityai/stable-diffusion-3.5-large) *(requires accepting license)*
- **SD 3.5 Large Turbo** — [Hugging Face stabilityai/stable-diffusion-3.5-large-turbo](https://huggingface.co/stabilityai/stable-diffusion-3.5-large-turbo) *(requires accepting license)*
- **SD 3.5 Medium** — [Hugging Face stabilityai/stable-diffusion-3.5-medium](https://huggingface.co/stabilityai/stable-diffusion-3.5-medium) *(requires accepting license)*

## Notes

Typical CFG: 4.5 for SD 3.5 Large; 5 for Medium. Supports negative prompts. No custom nodes required.
