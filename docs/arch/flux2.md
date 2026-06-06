# Flux 2 (Dev / Klein)

Black Forest Labs' second-generation Flux architecture. Always split-loaded (no unified checkpoint). Uses a large language model as its text encoder instead of T5-XXL.

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | `flux2-dev.safetensors` *(Dev)* or `flux2-klein.safetensors` *(Klein)* | `models/diffusion_models/` |
| Text encoder | Mistral 3 NLP encoder *(Dev)* or Qwen 3 encoder *(Klein)* — see below | `models/text_encoders/` |
| VAE | `ae.safetensors` | `models/vae/` |

The VAE is the same file as Flux.1 (`ae.safetensors`). Check the model release page for the exact quantised text encoder filename.

## Where to download

- **Flux 2 Dev** — [Hugging Face black-forest-labs/FLUX.2-dev](https://huggingface.co/black-forest-labs/FLUX.2-dev) *(requires accepting license)*
- **Flux 2 Klein** — [Hugging Face black-forest-labs/FLUX.2-Klein](https://huggingface.co/black-forest-labs/FLUX.2-Klein) *(requires accepting license)*
- **VAE** — [Hugging Face black-forest-labs/FLUX.1-dev](https://huggingface.co/black-forest-labs/FLUX.1-dev) (`ae.safetensors`)
- **Text encoders** — linked from each model's release page above

## Notes

Flux 2 uses native `ReferenceLatent` nodes for multi-image reference conditioning — no external adapter or CLIP Vision model needed. Negative prompts are not used. Reference images are automatically scaled to ~1 MP before being passed to the latent reference.
