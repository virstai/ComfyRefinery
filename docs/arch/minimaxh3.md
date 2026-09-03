# MiniMax H3 (Hailuo 3)

MiniMax H3 is an open-weights 33B omni-modal video model (released 2026-08-03) that
generates up to ~15 seconds of video **with native stereo audio in a single pass**. It
uses only native ComfyUI nodes — **ComfyUI ≥ 0.30.0 required**, no custom node packs.

Two checkpoints cover three modes:

| Mode | Checkpoint | ComfyRefinery behavior |
|---|---|---|
| Text-to-video | FL2VA | Video step with no image input |
| Image-to-video | FL2VA | Previous step's output (or a single uploaded reference) becomes the first frame |
| Reference-to-video | Ref2VA | Uploaded reference images are passed as `<Picture 1>…<Picture N>` — requires the **Ref2VA UNet file** and the **Audio VAE file** to be set on the model; routing is automatic when references are present |
| Film (long video) | both | The **Film** view builds a long video shot by shot: `continue` segments run FL2VA from the previous take's last frame, `cut` segments run Ref2VA with bank images, voice clips and (optionally) the previous take's tail — see [Film](#film-long-video-shot-by-shot) |

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| UNet file | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (19.5 GB) | `models/diffusion_models/` |
| Ref2VA UNet file *(optional)* | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| Text encoder file | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (14.6 GB) on NVIDIA; `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` (25.3 GB) on AMD/ROCm — see [ROCm](#rocm-use-the-int8-text-encoder-not-nvfp4) | `models/text_encoders/` |
| VAE file | `minimax_h3_video_vae_fp16.safetensors` (4.9 GB) | `models/vae/` |
| Audio VAE file *(optional for T2V/I2V; required for R2V and Film)* | `minimax_h3_audio_vae_fp32.safetensors` (0.6 GB) | `models/vae/` |
| Turbo LoRA (FL2VA) *(optional)* | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | `models/loras/` |
| Turbo LoRA (Ref2VA) *(optional)* | `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | `models/loras/` |

Larger/heavier variants exist in the same repo (`_int8_convrot` 31.7 GB, `_bf16`
61.7 GB for the UNet; `int8_convrot`/`bf16` for the text encoder) — the pruned int8 UNet +
nvfp4 encoder combination is the recommended NVIDIA setup (~40 GB total; runs on 12 GB
VRAM cards via dynamic offloading). On AMD/ROCm the nvfp4 encoder is emulated and produces
NaN conditioning, so use the int8 convrot encoder there (~51 GB total).

## Where to download

```bash
cd /path/to/ComfyUI/models
wget -P diffusion_models/ "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
wget -P diffusion_models/ "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"
wget -P text_encoders/   "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
# AMD/ROCm: use this encoder instead of the nvfp4 one
# wget -P text_encoders/ "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
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
| Enable | Set the **Audio VAE file** on the model — leave it blank to skip audio decoding on T2V/I2V. Reference-to-video cannot skip it: `audio_vae` is a required input of `MiniMaxH3ReferenceToVideo`, so R2V refuses to run without the file |
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
reference falls back to plain I2V first-frame conditioning instead. The Audio VAE must
be set: the reference node requires `audio_vae` (ComfyUI 0.34) and the step fails early
with a clear message when it is blank.

`MiniMaxH3ReferenceToVideo` accepts more than images (ComfyUI 0.34 schema). The builder
wires all three groups; the Film view is what uses the video/audio ones today:

| Node input group | Max | Source | Prompt tag |
|---|---|---|---|
| `ref_images.ref_image_{i}` | 9 | `LoadImage` | `<Picture i>` |
| `ref_videos.ref_video_{k}` (frames, 2–15 s at 24 fps) + `ref_video_audios.ref_video_audio_{k}` (its soundtrack) | 3 | `LoadVideo → GetVideoComponents` ([0] frames, [1] audio) | `<Video k>` |
| `ref_audios.ref_audio_{j}` (standalone audio, e.g. a voice sample) | 3 | `LoadAudio` | `<Audio j>` |

Reference clips and audio files are uploaded to ComfyUI's `input/` through the same
`/upload/image` route the ComfyUI frontend uses for media. The FL2VA node also takes an
optional `last_frame` (wired as `lastFrameRef`, same scaling chain as `first_frame`) —
the Film `bridge` mode will use it to end a shot on a chosen keyframe.

## Film (long video, shot by shot)

The **Film** view (`/api/projects`, `ui/src/components/film/`) builds a long video out of
many ~5 s H3 takes. It is a separate mode from Generate: a project pins a raw model entry
plus its own format/generation settings (no workflow, no steps), keeps a per-project
reference bank, and grows a timeline one segment at a time — write what happens next,
run a take, approve it or try another, move on. Approved takes are stitched with ffmpeg.

| Segment start mode | Checkpoint | What the model receives | Consistency |
|---|---|---|---|
| `continue` | FL2VA | `first_frame` = the previous approved take's last frame, or a bank image you pick — including a still generated in place with any image model (e.g. an anima scene start). Bank images are shown to the prompt writer only. | Pixel-continuous with the previous shot. No audio conditioning — voices reset each clip. Drift accumulates over many hops, so mix in cuts. |
| `cut` | Ref2VA | Bank images as `<Picture i>` (≤9), voice clips as `<Audio j>` (≤3), optionally the previous take's last ≤10 s as `<Video 1>` with its soundtrack (**Include previous tail**). | Identity, wardrobe, setting and **voice** carry over; the framing is new. This is where dialogue belongs. |
| `bridge` | FL2VA | `first_frame` + `last_frame` (a chosen keyframe). | Builder support only — not exposed yet. |

Alternating `continue` and `cut` swaps between the two 19.5 GB checkpoints, so runs of
one mode are faster. Each take is downloaded to `data/projects/<id>/clips/` and its last
frame extracted, so a film survives ComfyUI's `output/` being cleared. Requirements:
both UNet files, the Audio VAE, and **ffmpeg + ffprobe on the ComfyRefinery host** —
bundled by `npm install` (`ffmpeg-static` / `ffprobe-static`), else a system ffmpeg on
PATH or `FFMPEG_PATH` / `FFPROBE_PATH`; the System page reports which one is in use.

## ROCm: 1344×768 decodes with a corrupt tail — use 1024×576

Observed 2026-09-03 on an R9700 (ROCm 7.13, ComfyUI 0.34, `--use-ck-attention`, video VAE on a
second GPU): every 1344×768 × 124-frame take came out clean for ~4 s and then dissolved into a
16 px block grid with black cells from frame ~97 onward — exactly where the VAE's sixth temporal
chunk (of seven) starts. Not memory pressure (it reproduced with the LLM unloaded and 26 GB
free on the VAE's card), not the frame count (73 and 243 frames decode fine, and the 17k+5
chunk plan for 124 frames has no padded remainder). The same seed and prompt at **1024×576**
decoded cleanly and followed the prompt better, which also matches the adherence-vs-resolution
reports on the model's HF discussions. Until the 1344-wide path is understood (candidates: the
ck attention kernel inside the ViT decoder, ComfyUI's tiled decode — see Comfy-Org/ComfyUI
issue 15416), keep Film projects at 1024×576 on ROCm.

## ROCm: use the int8 text encoder, not nvfp4

On AMD (gfx1201, ROCm 7.13, ComfyUI 0.34) the `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` encoder returns **all-NaN
conditioning for every prompt** — the NaN is created inside an nvfp4 `QuantizedTensor` Linear (`layers.10.mlp.up_proj`) on
the *emulated* nvfp4 path, and bf16/fp32 encoder flags do not help. The symptom is a video that ignores the prompt entirely
(text-to-video with "red car", "ocean" and an empty prompt produced the same clip). Use `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`
(25 GB, Comfy-Org/MiniMax-H3) instead: int8 convrot is a native op on this GPU and the same probe returns real embeddings.
Verify with a text-to-video A/B on a fixed seed — different prompts must give clearly different clips.

## Performance notes (measured on an AMD R9700 32 GB, ROCm 7.13, ComfyUI 0.34)

H3 is attention-bound: token count = latent frames × (W/16 × H/16)/4, and 1024×1024 × 243 frames is ~73k tokens.
The attention backend matters far more than where the weights live:

| Job (I2V, turbo LoRA, 8 steps) | PyTorch SDPA | flash_attn | `--use-ck-attention` |
|---|---|---|---|
| 1024×1024 × 73 f (fits in VRAM) | 25.5 s/step | 21.7 s/step | **15.5 s/step** |
| 1024×1024 × 243 f (8.7 GB of UNet streamed) | 200 s/step, ~27 min | — | **103 s/step, 15.5 min** |

Comfy Kitchen's HIP attention (`--use-ck-attention` on the ComfyUI command line) produced output indistinguishable from SDPA
(brightness, detail, motion, audio). Streaming part of the UNet costs almost nothing by comparison: at 124 frames, 3 GB streamed
from RAM and 6 GB parked on the second GPU via DisTorch both gave 60 s/step. `--enable-dynamic-vram` changed nothing either.
The UNet cannot be fully resident at 1024² × 243 f on a 32 GB card (19.5 GB weights + ~12 GB peak activations); moving the
VAEs to a second card (model settings → device) frees ~5.5 GB and lets shorter takes load fully.

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
- **LoRAs**: H3 LoRAs patch the DiT only, so they load through `LoraLoaderModelOnly`,
  chained after the turbo LoRA. Workflow video steps take an always-on `loras` list;
  Film segments have their own per-segment list (scene, style or motion LoRAs). Register
  and tag files as `minimaxh3` on the LoRAs page so the pickers offer them.
- **Turbo LoRAs**: distilled for **8** steps (FL2VA) / **4** steps (Ref2VA) — ~2× faster
  with a small quality cost. When a turbo LoRA is active and the video step doesn't pin
  a step count, ComfyRefinery uses the LoRA's trained count automatically (running a
  turbo LoRA at the full 20 steps over-walks the schedule and produces grainy output).
  For maximum quality, clear the turbo LoRA field and generate at 20 steps.
- **License**: released under the MiniMax H3 Community License; the open weights carry
  region restrictions (US, EU, UK, and South Korea are excluded territories) — check
  the license terms for your jurisdiction before downloading.
- **Prompting** (default skill, `src/services/skills.js`): the official brief format from
  the model repo's `docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` — an alignment line when
  frames are given ("Picture 1 (from Shot 1) aligns with the 0.00-second mark…"; ComfyUI's
  tokenizer presents the first/last frame as `<Picture 1>`/`<Picture 2>` with no chat
  template), then `integrated_multimodal_description:` / `overall_soundscape:` /
  `non_diegetic_music:` sections, `[Shot 2] At 00:03.500, the camera cuts to…` for cuts,
  `(S1) says: <d>[English] …</d>` for dialogue, and the camera vocabulary (Static Shot,
  Push In, Pan Left, … with amplitude/speed). **A fixed camera must be written as
  "The camera holds a static shot"** with no other camera language — the model adds motion
  whenever a move is implied ("handheld", "reveal", "dynamic"). Adherence is better at
  lower resolutions (community reports on the HF discussions).
