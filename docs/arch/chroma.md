# ChromaHD

A distilled flow-matching model derived from Flux, trained without classifier-free guidance. High-resolution capable; no custom nodes required. Uses a T5 text encoder.

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | e.g. `chroma-unlocked-v35.safetensors` | `models/diffusion_models/` |
| Text encoder | e.g. `t5xxl_flan_latest_float8_e4m3fn_scaled_stochastic.safetensors` | `models/text_encoders/` |
| VAE | e.g. `chroma_vae.safetensors` | `models/vae/` |

Check the specific model release page for the exact T5 encoder variant it recommends — the filename matters.

## Where to download

- **Chroma models** — [Hugging Face lodestone-rock/chroma](https://huggingface.co/lodestone-rock/chroma)
- **T5 encoder variants** — [Hugging Face comfyanonymous/flux_text_encoders](https://huggingface.co/comfyanonymous/flux_text_encoders) *(pick the `t5xxl_flan*` file named in the release notes)*
- **VAE** — Linked from the Chroma model release page above

## Notes

No custom nodes required — ComfyUI's built-in nodes handle Chroma natively. Negative prompts are supported via the `negativePrompt` field.
