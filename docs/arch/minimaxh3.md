# MiniMax H3 (Hailuo 3)

MiniMax H3 is an open-weights 33B omni-modal video model (released 2026-08-03) that
generates up to ~15 seconds of video **with native stereo audio in a single pass**. It
uses only native ComfyUI nodes — **ComfyUI ≥ 0.30.0 required**, no custom node packs.

Two checkpoints cover three modes:

| Mode | Checkpoint | ComfyRefinery behavior |
|---|---|---|
| Text-to-video | FL2VA | Video step with no image input |
| Image-to-video | FL2VA | Previous step's output (or a single uploaded reference) becomes the first frame |
| Reference-to-video | Ref2VA | Uploaded reference images are passed as `<Picture 1>…<Picture N>` — requires the **Ref2VA UNet file** to be set on the model; routing is automatic when references are present |

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| UNet file | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (19.5 GB) | `models/diffusion_models/` |
| Ref2VA UNet file *(optional)* | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| Text encoder file | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (14.6 GB) | `models/text_encoders/` |
| VAE file | `minimax_h3_video_vae_fp16.safetensors` (4.9 GB) | `models/vae/` |
| Audio VAE file *(optional)* | `minimax_h3_audio_vae_fp32.safetensors` (0.6 GB) | `models/vae/` |
| Turbo LoRA (FL2VA) *(optional)* | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | `models/loras/` |
| Turbo LoRA (Ref2VA) *(optional)* | `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | `models/loras/` |

Larger/heavier variants exist in the same repo (`_int8_convrot` 31.7 GB, `_bf16`
61.7 GB for the UNet; `int8_convrot`/`bf16` for the text encoder) — the pruned int8 +
nvfp4 combination above is the recommended local setup (~40 GB total; runs on 12 GB
VRAM cards via dynamic offloading).

## Where to download

```bash
cd /path/to/ComfyUI/models
wget -P diffusion_models/ "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
wget -P diffusion_models/ "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"
wget -P text_encoders/   "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
wget -P vae/             "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors"
wget -P vae/             "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors"
wget -P loras/           "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
wget -P loras/           "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
```

- ComfyUI repackage (all files above): <https://huggingface.co/Comfy-Org/MiniMax-H3>
- Original weights (Diffusers format): <https://huggingface.co/MiniMaxAI/MiniMax-H3>

## Audio generation

| What | Detail |
|---|---|
| How | H3's sampled latent carries video **and** audio; ComfyRefinery decodes both (`VAEDecode` + `VAEDecodeAudio`) and muxes them into one MP4 via `CreateVideo` |
| Enable | Set the **Audio VAE file** on the model — leave it blank to skip audio decoding |
| Output | 32 kHz stereo embedded in the video file; no extra SSE events or routes |
| Prompting | Describe the soundtrack in the prompt (the default skill adds an `Audio:` line) — music, ambience, effects, and spoken dialogue are all generated |
| Silent fallback | When audio is enabled the graph also saves an `iterator_video_noaudio_*` copy straight from the frame decoder, written before the audio path runs. If the muxed save then fails, the take is kept without sound and a warning is recorded on it instead of losing the render. This exists because of a real incident: on ComfyUI 0.31 with a ROCm nightly (gfx1201), 243-frame takes sampled fine for 25 minutes and then died in `SaveVideo` with `[aac] Input contains (near) NaN/+-Inf`, and a 512×512 repro crashed the GPU outright with an illegal memory access. **Updating ComfyUI to ≥ 0.34 fixed it** — the same 243-frame jobs (512×512, hybrid and official checkpoints) then produced clean video and 10 s of clean audio. The trained duration range is ~124–362 frames; frame count itself is not the problem. Note that 1024×1024 × 243 frames is ~73k tokens: on a 32 GB card the UNet (19.5 GB) plus ~12 GB of peak activations no longer fits, so ComfyUI streams part of the UNet, and the step is mostly compute-bound anyway (~25 s/step at 73 frames, ~200 s/step at 243). |

## Reference-to-video (R2V)

When the workflow's video step receives uploaded references (and no chained image from
a previous step), ComfyRefinery switches to the Ref2VA checkpoint automatically and
wires every reference into `MiniMaxH3ReferenceToVideo`. References are cited in the
prompt by upload order as `<Picture 1>`, `<Picture 2>`, … with an explicit role
(identity / style / object) — the prompt refiner does this automatically. Model limits:
up to 9 reference images — extra uploads are dropped with a warning on the take
(`maxReferences: 9` in `ARCH_META`). If the Ref2VA UNet is not configured, the first
reference falls back to plain I2V first-frame conditioning instead.

## Required custom nodes

None — `MiniMaxH3ImageToVideo`, `MiniMaxH3ReferenceToVideo`, `VAEDecodeAudio`,
`SamplerCustomAdvanced`, `CreateVideo`, and `SaveVideo` are all core nodes in
ComfyUI ≥ 0.30.0.

## Notes

- **Guidance-free**: no negative prompt and no CFG — sampling uses `BasicGuider` with
  the `res_multistep` sampler and `simple` scheduler (20 steps default).
- **Frame grid**: valid lengths are `17k+5` frames (5, 22, 39, 56, 73, 90, 107, 124…).
  ComfyRefinery snaps the requested count **up** to the next valid value. Default 73
  frames ≈ 3 s at the fixed 24 fps.
- **Resolution**: native 1344×768 (0.9 MP budget, dimensions on a /32 grid). The open
  weights are capped at 768p on the short edge; input images are auto-scaled.
- **Turbo LoRAs**: distilled for **8** steps (FL2VA) / **4** steps (Ref2VA) — ~2× faster
  with a small quality cost. When a turbo LoRA is active and the video step doesn't pin
  a step count, ComfyRefinery uses the LoRA's trained count automatically (running a
  turbo LoRA at the full 20 steps over-walks the schedule and produces grainy output).
  For maximum quality, clear the turbo LoRA field and generate at 20 steps.
- **License**: released under the MiniMax H3 Community License; the open weights carry
  region restrictions (US, EU, UK, and South Korea are excluded territories) — check
  the license terms for your jurisdiction before downloading.
- Prompting: H3 follows timestamped beats (`[0s-2s] …`), hard cuts, quoted on-screen
  text, and quoted dialogue reliably — see the default skill for the structure.
