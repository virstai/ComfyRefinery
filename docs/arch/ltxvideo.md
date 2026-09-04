# LTX-Video 2.3

Lightricks' open audio-video diffusion model (22B DiT, native stereo audio) and the
fine-tunes built on it — notably **Sulphur 2**, a full fine-tune in the same checkpoint
layout. Native ComfyUI nodes only; the graph follows ComfyUI's own LTX-2.3 templates
and the Sulphur 2 workflows, which share one recipe.

## Files needed in ComfyUI

| Field | File | ComfyUI folder | Notes |
|---|---|---|---|
| Checkpoint | `ltx-2.3-22b-dev-fp8.safetensors` **or** `sulphur_dev_fp8mixed.safetensors` | `models/checkpoints/` | One file holds the DiT, video VAE, audio VAE and vocoder. Sulphur 2 has the identical tensor layout, so it is a drop-in swap. ~29 GB each. |
| Text encoder | `gemma_3_12B_it_fp4_mixed.safetensors` (9.4 GB) or `gemma_3_12B_it_fp8_scaled.safetensors` (13 GB) | `models/text_encoders/` | Gemma 3 12B; loaded by `LTXAVTextEncoderLoader` together with the checkpoint. |
| Distilled LoRA | `ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors` (0.66 GB, Sulphur 2 repo) or `ltx-2.3-22b-distilled-lora-384-1.1.safetensors` (7.6 GB, Lightricks) | `models/loras/` | Drives the **distilled** sampling mode and is required for the two-stage refine. |
| Spatial upscaler | `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` (1 GB) | `models/latent_upscale_models/` | Enables the two-stage recipe (half-size sampling → ×2 → refine). Strongly recommended: it is how the official templates run and it is far lighter on VRAM than sampling at full size. |

## Where to download

```bash
cd /path/to/ComfyUI/models

# Sulphur 2 (community fine-tune of LTX-2.3; motion / human interaction focus, uncensored)
curl -L -C - -o checkpoints/sulphur_dev_fp8mixed.safetensors \
  "https://huggingface.co/SulphurAI/Sulphur-2-base/resolve/main/sulphur_dev_fp8mixed.safetensors"
curl -L -C - -o loras/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors \
  "https://huggingface.co/SulphurAI/Sulphur-2-base/resolve/main/distill_loras/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors"

# Official LTX-2.3 dev checkpoint (for comparison, same layout)
curl -L -C - -o checkpoints/ltx-2.3-22b-dev-fp8.safetensors \
  "https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-dev-fp8.safetensors"

# Spatial upscaler and text encoder
curl -L -C - -o latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors \
  "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
curl -L -C - -o text_encoders/gemma_3_12B_it_fp4_mixed.safetensors \
  "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors"
```

- **Sulphur 2** — [SulphurAI/Sulphur-2-base](https://huggingface.co/SulphurAI/Sulphur-2-base) (also `sulphur_dev_bf16`, `sulphur_distil_bf16`, a rank-768 LoRA version, and a prompt-enhancer GGUF — see below). LTX-2 Community License.
- **LTX-2.3 fp8** — [Lightricks/LTX-2.3-fp8](https://huggingface.co/Lightricks/LTX-2.3-fp8); LoRAs / upscalers — [Lightricks/LTX-2.3](https://huggingface.co/Lightricks/LTX-2.3)
- **Text encoders** — [Comfy-Org/ltx-2](https://huggingface.co/Comfy-Org/ltx-2)

Disk: a checkpoint is 29 GB; Sulphur 2 + the official dev model + LoRA + upscaler + Gemma fp4 ≈ 70 GB.

## Model settings

| Field | Meaning |
|---|---|
| **Sampling mode** | `distilled` (default when a distilled LoRA is set): the LoRA drives stage 1 at 0.7 — cfg 1, 8 steps, `LTXVScheduler` max_shift 4 / base_shift 1.5 / terminal 0.1, `euler_ancestral_cfg_pp`. Fast. `full`: the base model samples with CFG (guidance, default 3.6) and the negative prompt — 30 steps by default (Sulphur's own workflow uses 50), max_shift 2.72 / base_shift 0.8, `euler_ancestral`; the LoRA is only used in the refine. Slower, more prompt control. |
| **Spatial upscaler (two-stage)** | When set, stage 1 samples at **half** the output size, `LTXVLatentUpsampler` doubles the latent, and a short LCM refine runs with the distilled LoRA at 0.5 and cfg 1 (3 sigmas in distilled mode, 5 in full). The stage-1 audio latent is carried through untouched. Without it the clip is sampled once at full size (heavy: the June OOMs on a 30 GB card were single-stage 768×512×118f runs). |
| **Distilled LoRA** | Required for `distilled` mode and for the refine. Both Lightricks' 384-rank file and Sulphur's compressed `condsafe` file work; the graph loads it with `LoraLoaderModelOnly`. |
| **Generate audio** | Adds the audio latent (`LTXVEmptyLatentAudio` → `LTXVConcatAVLatent`) to sampling and decodes it with the checkpoint's audio VAE into the MP4. |
| **Negative prompt** | Video steps expose it (blank = the templates' default, `pc game, console game, video game, cartoon, childish, ugly`). Only matters in `full` mode (cfg > 1). |
| **LoRAs** | `capabilities.lora` — video steps' `loras` and Film segments' LoRAs chain with `LoraLoaderModelOnly` under the distilled LoRA on both stages. Sulphur 2 is also distributed as a 10 GB LoRA (`sulphur_lora_rank_768.safetensors`) for use over the official checkpoint — use the LoRA *or* the full fine-tune, never both. |

Sizes are on a **/64 grid** (twice the /32 latent grid, so the half-size stage lands on
the grid too); `dimMultiple: 64` drives I2V aspect-follow and the Film presets. Frame
counts snap to 8n+1 (121 ≈ 5 s at 24 fps). Default output 1024×576 — the same size as
MiniMax H3's lighter preset, for side-by-side comparisons; 1280×704 is the 720p size and
1920×1088 the model's 1080p size (heavy).

## VRAM: split the VAEs off the checkpoint (multi-GPU)

The fp8 DiT alone is 23.9 GB resident. On a 30 GB card that leaves no room for the
VAEs on the same GPU: with the in-checkpoint VAEs ComfyUI has to partially unload the
DiT for the audio VAE (on ROCm that path died with `hipErrorIllegalAddress`) and the
video decode of even 49 frames at 1024×576 OOMed. The fix is the same one used for
MiniMax H3 — put the VAEs on the other GPU — which needs them as standalone files:

```bash
# from the ComfyRefinery checkout; the tool streams tensors, no Python or torch needed
node scripts/extract-safetensors.js /path/to/ComfyUI/models/checkpoints/sulphur_dev_fp8mixed.safetensors \
  /path/to/ComfyUI/models/vae/ltx-2.3-video-vae.safetensors --prefix vae.=
node scripts/extract-safetensors.js /path/to/ComfyUI/models/checkpoints/sulphur_dev_fp8mixed.safetensors \
  /path/to/ComfyUI/models/vae/ltx-2.3-audio-vae.safetensors --prefix audio_vae. --prefix vocoder.
```

Then on the model: **External VAE** → `ltx-2.3-video-vae.safetensors`, **Audio VAE file** →
`ltx-2.3-audio-vae.safetensors`, and their device dropdowns → the second GPU
(needs ComfyUI-MultiGPU; blank device = same GPU as the DiT, which still avoids the
in-checkpoint loader path). ComfyUI's `VAELoader` recognises both files by their keys;
the `config` metadata the VAE constructors read is carried over. The VAE weights are
the same in the official checkpoint and in Sulphur 2, so one pair serves both.

Measured on two R9700 32 GB (ROCm, `--use-ck-attention`), Sulphur 2 fp8mixed, distilled
two-stage, audio on, VAEs on cuda:1: **1024×576 × 49 f in 25 s, × 121 f (5 s) in 45 s**
end to end, DiT fully resident, no partial unloads of consequence. Without the split the
same 49-frame take crashed ComfyUI.

## Image-to-video

The start image goes through `ImageScale` (lanczos, centre crop to the output size) →
`LTXVPreprocess` (compression 18, the light JPEG-style degradation the model was trained
on) → `LTXVImgToVideoInplace`, which writes the frame into the latent in place — 0.7 in
stage 1 and 1.0 after the upscale, exactly as the templates do (1.0 when single-stage).
`LTXVAddGuide` is no longer used. The first frame of the output is therefore the input
image; the Film view relies on this for `continue` segments.

## Film (long video, shot by shot)

`ltxvideo` is Film-eligible in **continue** mode only: every segment starts from a frame
(the previous approved take's last frame, or a still from the bank), and new segments
default to `continue`. There is no reference-to-video checkpoint, so the **Cut** mode is
disabled for LTX projects and voice references are never used — voices reset per clip.
Film presets (Setup → Format) are the /64 sizes above; the default take is 121 frames.

## Prompting

LTX-2.3 wants plain prose: describe the core actions as they unfold over time, the
visual details you want to see, and the sounds and dialogue. The default skill in
`src/services/skills.js` covers this. Sulphur 2 ships a **prompt enhancer** (a Gemma-based
GGUF with an mmproj for image input, in `prompt_enhancer/`); it is an ordinary chat model,
so it can be served by any OpenAI-compatible server (LM Studio, llama-swap, Ollama) and
pointed at from Settings as the LLM for prompt writing — no code changes needed.

## Required custom nodes

None — everything is ComfyUI core (`LTXAVTextEncoderLoader`, `LTXVConditioning`,
`LTXVScheduler`, `SamplerCustomAdvanced`, `CFGGuider`, `LTXVLatentUpsampler`,
`LatentUpscaleModelLoader`, `LTXVImgToVideoInplace`, `LTXVPreprocess`, `VAEDecodeTiled`,
the LTX audio nodes). ComfyUI ≥ 0.31 for `LTXVImgToVideoInplace`; verified on 0.34.

- **ComfyUI-GGUF** *(optional, for quantised GGUF variants such as "Rebels Sulphur 2 GGUF")* — [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF); not wired by the builder.

## Notes

- **LTX 2.5** exists (ComfyUI 0.34 ships `video_ltx2_5_*` templates: Gemma 4 text encoder,
  a duration predictor and a new diffusion decoder). It is a different loader/encoder
  setup and is **not** covered by this arch entry.
- **I2V dimensions follow the input image.** When a video step chains from a previous
  step (or uses an uploaded reference as its first frame) and does not pin both `width`
  and `height`, the size is derived from the image's aspect ratio, fitted to the default
  pixel budget on the /64 grid with neither edge beyond the default long edge. Pin one
  dimension to keep it and let the other follow; pin both to disable the follow.
- Older single-stage graphs (`KSampler` + `ModelSamplingLTXV` + `LTXVAddGuide`) are gone;
  model entries from before this change still work — add the upscaler to get the
  two-stage recipe.
