# Krea 2

**Architecture key:** `krea2`
**Loading mode:** Split (UNETLoader + CLIPLoader + VAELoader) — no checkpoint file exists
**Custom nodes required:** None, but requires a recent ComfyUI build with Krea 2 support (core, not a custom node pack)

Krea 2 is a 12.9B-parameter single-stream diffusion transformer from Krea AI — a ground-up
architecture, not a Flux derivative (it is unrelated to the earlier `FLUX.1-Krea-dev`
collaboration). Two open checkpoints are released: **Turbo** (guidance- and timestep-distilled,
8-step generation) and **Raw** (undistilled, for higher quality or LoRA fine-tuning). Licensed
under the Krea 2 Community License (free for individuals and small teams).

- HuggingFace (ComfyUI-repackaged, ungated): [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2)
- Technical report: [krea.ai/blog/krea-2-technical-report](https://www.krea.ai/blog/krea-2-technical-report)
- ComfyUI tutorial: [docs.comfy.org/tutorials/image/krea/krea-2](https://docs.comfy.org/tutorials/image/krea/krea-2)

> **Note:** the upstream `krea/Krea-2-Raw` and `krea/Krea-2-Turbo` repos are gated (license
> click-through required). The Comfy-Org mirror above re-hosts the same weights ungated for
> automated download.

---

## Model Files

Download and place in the directories below. Pick one diffusion-model precision (bf16, fp8,
or int8) depending on available VRAM.

| File | Directory | Download |
|------|-----------|----------|
| `krea2_turbo_fp8_scaled.safetensors` (or `_bf16`, `_int8_convrot`) | `ComfyUI/models/diffusion_models/` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/diffusion_models) |
| `qwen3vl_4b_fp8_scaled.safetensors` (or `_bf16`) | `ComfyUI/models/text_encoders/` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/text_encoders) |
| `qwen_image_vae.safetensors` | `ComfyUI/models/vae/` | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/vae) |

> **Note:** for the undistilled Raw checkpoint, download `krea2_raw_bf16.safetensors` (or
> `_fp8_scaled` / `_int8_convrot`) instead of the turbo file — same text encoder and VAE.

---

## ComfyRefinery Model Config

In the Models panel, create a new model with:

- **Architecture:** Krea 2
- **Diffusion model (UNet):** `krea2_turbo_fp8_scaled.safetensors`
- **CLIP / Text encoder:** `qwen3vl_4b_fp8_scaled.safetensors`
- **VAE:** `qwen_image_vae.safetensors`
- **CFG scale:** 1.0 for Turbo (recommended). Raise to 3.0–3.5 and swap in the Raw diffusion
  model for higher-quality, non-distilled generation.
- **Negative prompt:** only has an effect above CFG 1.0 — see Known Limitations.

---

## Capabilities

### LoRA

Supported. Krea 2 LoRAs are trained on the diffusion transformer only, so the builder uses
`LoraLoaderModelOnly` — the text encoder path is never patched. Nine official style LoRAs are
available on the [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/tree/main/loras)
repo; each needs its trigger phrase appended to the prompt to activate:

| LoRA | Trigger phrase |
|---|---|
| `krea2_darkbrush` | monochrome ink wash style |
| `krea2_dotmatrix` | monochrome stippling style |
| `krea2_kidsdrawing` | naive expressive sketch style |
| `krea2_neondrip` | textured abstract style |
| `krea2_rainywindow` | rainy window style |
| `krea2_retroanime` | purple retro anime style |
| `krea2_softwatercolor` | art deco watercolor style |
| `krea2_sunsetblur` | ethereal motion blur style |
| `krea2_vintagetarot` | vintage tarot style |

Recommended strength: 1.0.

### img2img (init-image)

Supported. Use `referenceStrategy.diffusion.mode: "init-image"` in the workflow step. Default
denoise is 0.6.

### Adapter (reference images)

Not implemented in ComfyRefinery yet. Krea 2 does have native reference-latent conditioning in
ComfyUI core (Flux-Kontext-style, via `TextEncodeQwenImageEditPlus` +
`FluxKontextMultiReferenceLatentMethod`), but it requires a different sampler branch
(`ModelSamplingFlux → CFGGuider → SamplerCustomAdvanced` instead of plain `KSampler`) and a
community style-reference LoRA (`ostris/krea2_turbo_style_reference`) — out of scope for now.
User-uploaded references still work for vision notes and img2img.

### ControlNet

Not available — no ControlNet support exists in ComfyUI core for Krea 2. Only third-party
packs exist (e.g. `facok/comfyui-krea2-controlnet`, a Control-LoRA-style implementation);
untested and not wired up here.

---

## Recommended Settings

| Parameter | Turbo (default) | Raw |
|-----------|------------------|-----|
| Resolution | 1024×1024 | 1024×1024 |
| Steps | 8 | ~52 |
| CFG scale | 1.0 | 3.0–3.5 |
| Sampler | `euler` | `euler` |
| Scheduler | `simple` | `simple` |
| Negative prompt | No effect (uncond branch unused at CFG 1.0) | Active — write a real negative prompt |

Model shift (1.15) is fixed by ComfyUI's Krea 2 model detection — there's no shift setting to
tune.

---

## Known Limitations

- **Negative prompts do nothing at CFG 1.0.** The Turbo default runs at CFG 1.0, where the
  unconditional branch is never sampled — the builder swaps in `ConditioningZeroOut`
  automatically. To make negative prompting effective, raise CFG above 1.0 (Raw territory).
- **No reference-image / adapter support yet** — see Capabilities above.
- **No ControlNet support** — core ComfyUI has none; third-party packs are unverified.
- **Requires a recent ComfyUI build.** Krea 2 support landed in ComfyUI core relatively
  recently (Comfy-Org PR #14589) — update ComfyUI if the architecture or `"krea2"` CLIPLoader
  type isn't recognized.
