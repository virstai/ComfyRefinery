# Anima

A flow-matching diffusion model using Qwen-3 as its text encoder and a custom Qwen-Image VAE. Requires the `er_sde` sampler, available in recent ComfyUI builds or via the RES4LYF custom node pack.

## Files needed in ComfyUI

| Field | File | ComfyUI folder |
|---|---|---|
| UNet | e.g. `anima.safetensors` | `models/diffusion_models/` |
| CLIP-L (text encoder) | e.g. `qwen_3_06b_base.safetensors` | `models/clip/` or `models/text_encoders/` |
| VAE | Qwen-Image VAE — see release page | `models/vae/` |
| Adapter model *(optional, adapter mode only)* | e.g. `anima_ipadapter.safetensors` | anywhere on disk — set the full path |
| ControlNet-LLLite weights *(optional, pose ControlNet only)* | e.g. `anima-lllite-pose-1.safetensors` | `models/controlnet/` |

## Where to download

- **Anima UNet + VAE** — [circlestone-labs/Anima on Hugging Face](https://huggingface.co/circlestone-labs/Anima) or [Civitai](https://civitai.com/models/2458426/anima-official)
- **Qwen-3 encoder** — see the Anima release notes for the specific quantised filename
- **Anima IP-Adapter weights** — check the [comfyui-anima-ipadapter releases](https://github.com/Wenaka2004/comfyui-anima-ipadapter) or the CircleStone Labs Hugging Face org for released adapter checkpoints

## Required custom nodes

- **RES4LYF** *(for the `er_sde` sampler, if not in your ComfyUI build)* — [ClownsharkBatwing/RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF)
- **comfyui-anima-ipadapter** *(only if using adapter reference mode)* — [Wenaka2004/comfyui-anima-ipadapter](https://github.com/Wenaka2004/comfyui-anima-ipadapter)
- **ComfyUI-Anima-LLLite** *(only if using the pose ControlNet)* — [kohya-ss/ComfyUI-Anima-LLLite](https://github.com/kohya-ss/ComfyUI-Anima-LLLite) — plain `git clone` into `custom_nodes/`, no extra Python dependencies
- **comfyui_controlnet_aux** *(only if using the pose ControlNet — provides the DWPose extractor)* — [Fannovel16/comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) — clone into `custom_nodes/`, then `pip install -r requirements.txt` with ComfyUI's venv

## Reference adapter (IP-Adapter) setup

> **Note:** The Anima IP-Adapter weights are not yet publicly available — they are still being trained by CircleStone Labs. The node support is wired up and ready; check the [comfyui-anima-ipadapter repo](https://github.com/Wenaka2004/comfyui-anima-ipadapter) or the CircleStone Labs Hugging Face org for a release announcement.

Once weights are released: Anima's IP-Adapter uses **SigLIP2** (`google/siglip2-base-patch16-512`) as its vision encoder — downloaded automatically from Hugging Face on first use (~4 GB VRAM while encoding, unloaded after). No CLIP Vision model file is needed in ComfyUI.

1. Install the `comfyui-anima-ipadapter` custom node
2. Download the Anima IP-Adapter `.safetensors` checkpoint and place it in `models/ipadapter/`
3. In the model editor, select it from the **Adapter model** dropdown (same list as IPAdapter models)
4. Set a workflow step's reference strategy to **adapter** mode

Weight defaults to 1.0 (full effect). Lower it (0.5–0.8) if the reference is overriding the text prompt too strongly.

## Pose ControlNet (Anima-LLLite) setup

LLLite is a lightweight ControlNet variant for Anima's DiT. ComfyRefinery uses it for the
pose pre-pass: a draft image is generated from a detection-friendly prompt, DWPose extracts
an OpenPose skeleton from it, and the main generation follows that skeleton.

1. Install both custom node packs listed above
   (`ComfyUI-Anima-LLLite` and `comfyui_controlnet_aux`), then restart ComfyUI
2. Download LLLite weights from [kohya-ss/Anima-LLLite on Hugging Face](https://huggingface.co/kohya-ss/Anima-LLLite)
   — e.g. `anima-lllite-pose-1.safetensors` for pose — into `models/controlnet/`
3. In the model editor, select the weights in the **ControlNet model** dropdown
4. In a workflow step, set **Pose mode** to `auto` (LLM decides per prompt) or `always`,
   and pick a **pose draft model** (any configured model; general-purpose/photoreal
   models give the most reliable pose detection)

Notes:

- The DWPose detector models (`yolox_l.onnx`, `dw-ll_ucoco_384.onnx`) auto-download from
  Hugging Face the first time a pose runs — expect the first pose to be slow
- Strength defaults to 1.0; below ~1.0 the text prompt can override the pose. Other
  LLLite weights from the same repo (depth, lineart, scribble, inpainting) load the
  same way
- If no person can be detected in the pose draft, the step fails with
  "no person detected in the draft" rather than generating without pose control

## Notes

CFG scale applies. `er_sde` at 30–35 steps is a common starting point. Check the model release page for current recommended settings.
