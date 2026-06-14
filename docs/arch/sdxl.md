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
| Pose ControlNet model *(optional, pose ControlNet only)* | e.g. `OpenPoseXL2.safetensors` | `models/controlnet/` |
| Tile ControlNet model *(optional, tile chain/reference mode only)* | e.g. `controlnet-tile-sdxl-1.0.safetensors` | `models/controlnet/` |
| Structural ControlNet model *(optional, structural chain mode only)* | e.g. `illustriousXLv0.1_depth_midas_fp16.safetensors` | `models/controlnet/` |

The fp16-fix VAE is strongly recommended over the base SDXL VAE — it prevents NaN colour artefacts when running in fp16.

## Where to download

- **SDXL base + refiner** — [Hugging Face stabilityai/stable-diffusion-xl-base-1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)
- **Community SDXL checkpoints** — [Civitai](https://civitai.com) (filter by SDXL)
- **VAE (fp16-fix)** — [Hugging Face madebyollin/sdxl-vae-fp16-fix](https://huggingface.co/madebyollin/sdxl-vae-fp16-fix)
- **IPAdapter models + CLIP Vision** — [Hugging Face h94/IP-Adapter](https://huggingface.co/h94/IP-Adapter) (`models/sdxl/` folder)
- **Pose ControlNet model** — [Hugging Face thibaud/controlnet-openpose-sdxl-1.0](https://huggingface.co/thibaud/controlnet-openpose-sdxl-1.0) (`OpenPoseXL2.safetensors`). Alternative: [Hugging Face xinsir/controlnet-openpose-sdxl-1.0](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0).
- **Tile ControlNet model** — [Hugging Face xinsir/controlnet-tile-sdxl-1.0](https://huggingface.co/xinsir/controlnet-tile-sdxl-1.0) (the file in that repo is `diffusion_pytorch_model.safetensors` — rename it when downloading). Alternative: [Hugging Face TTPlanet/TTP_Controlnet_Tile_Weights_SDXL](https://huggingface.co/TTPlanet/TTP_Controlnet_Tile_Weights_SDXL) if you want a version tuned for high-detail upscale workflows.
- **Structural ControlNet models** — use Illustrious-native CNs trained on the same latent distribution as the checkpoint (see [Structural ControlNet setup](#structural-controlnet-setup) below). Using a generic SDXL CN against an Illustrious checkpoint causes colour drift.

## Required custom nodes

- **IPAdapter** *(only if using adapter reference mode)* — [cubiq/ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus)

Neither pose nor tile ControlNet requires custom nodes — `ControlNetLoader` and `ControlNetApply` are built into ComfyUI. The DWPose skeleton extractor used for the pose pre-pass does require `comfyui_controlnet_aux` (see below).

## Pose ControlNet setup

ComfyRefinery generates a pose draft from a detection-friendly prompt, extracts an OpenPose skeleton via DWPose, and feeds it through ControlNet into the main generation — using standard SDXL ControlNet nodes. When a refiner is configured, pose ControlNet applies to the base pass only.

1. Download `OpenPoseXL2.safetensors` from [thibaud/controlnet-openpose-sdxl-1.0](https://huggingface.co/thibaud/controlnet-openpose-sdxl-1.0) and place it in `models/controlnet/`
2. Install the DWPose extractor custom node pack — [Fannovel16/comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux): clone into `custom_nodes/`, then `pip install -r requirements.txt` with ComfyUI's venv. The DWPose detector models (`yolox_l.onnx`, `dw-ll_ucoco_384.onnx`) auto-download from Hugging Face on first use.
3. In the model editor, select the OpenPose model from the **ControlNet model** dropdown
4. In a workflow step, set **Pose mode** to `auto` (LLM decides) or `always`

## Tile ControlNet setup

Tile ControlNet lets the model re-render a source image at full quality while following its structure — ideal for cross-model chaining without the quality loss of img2img denoising. When a refiner is configured, tile ControlNet applies to the base pass only; the refiner continues normally from the base latent.

1. Download `controlnet-tile-sdxl-1.0.safetensors` from [xinsir/controlnet-tile-sdxl-1.0](https://huggingface.co/xinsir/controlnet-tile-sdxl-1.0) and place it in `models/controlnet/`
2. In the model editor, select it from the **Tile ControlNet model** dropdown
3. To use it for chain input: in a workflow step (step 2+), set **Chain input → Mode** to `Tile ControlNet`
4. To use it for reference guidance: in a workflow step, enable **Tile ControlNet** and upload a reference image — the model will follow the reference's structure

Strength defaults to 0.7. Lower values give the model more creative freedom; higher values enforce the source structure more strictly.

## Structural ControlNet setup

Structural ControlNet extracts a composition-only signal (depth map, soft edges, etc.) from a previous step's output using an inline preprocessor node, then uses it to guide generation while the model runs as pure txt2img — no init image. This lets SDXL express its full aesthetic while respecting only the layout from the previous step. The primary use case is cross-model chaining: a model with stronger prompt adherence (e.g. Flux 2 Klein) generates the composition, and SDXL applies its own style on top.

Unlike tile ControlNet (which carries pixel-level appearance and suppresses the model's style), structural ControlNet transfers only structure — depth, silhouettes, or edges — so SDXL's aesthetic is fully free.

**ControlNet model must match the checkpoint's prediction type.** Illustrious XL v0.1 uses **eps** prediction. The windsingai Tile model is v-pred only and will produce washed-out results with eps checkpoints. Use the MIC-Lab collection for Illustrious.

1. Download the MIC-Lab Illustrious-native CNs from [Hugging Face MIC-Lab/illustriousXLv0.1_controlnet](https://huggingface.co/MIC-Lab/illustriousXLv0.1_controlnet) and place them in `models/controlnet/`:
   - `illustriousXLv0.1_depth_midas_fp16.safetensors` — depth map (MiDaS); best for spatial layout and lighting
   - `illustriousXLv0.1_Softedge_fp16.safetensors` — soft edges (HED); looser guidance, more style freedom
2. Install the preprocessor custom node pack — [Fannovel16/comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux): clone into `custom_nodes/`, then `pip install -r requirements.txt` with ComfyUI's venv. This provides `MiDaS-DepthMapPreprocessor`, `HEDPreprocessor`, `AnimeLineArtPreprocessor`, `CannyEdgePreprocessor`, etc.
3. In the model editor, select the CN file from the **Structural ControlNet model** dropdown and pick the matching **Preprocessor** from the dropdown that appears (depth CN → MiDaS, softedge CN → HED)
4. In a workflow step (step 2+), set **Image inputs → Mode** to `Structural ControlNet` and set strength (recommended: 0.85–0.9)

**Preprocessor guide:**

| Preprocessor | Node | Best for |
|---|---|---|
| `depth` | `MiDaS-DepthMapPreprocessor` | Spatial layout, depth relationships, lighting feel |
| `softedge` | `HEDPreprocessor` | Shape outlines, looser structure — more style freedom |
| `lineart_anime` | `AnimeLineArtPreprocessor` | Precise anime contours — also transfers art style, use carefully |
| `lineart_realistic` | `LineartRealisticPreprocessor` | Photo-to-lineart conversion |
| `canny` | `CannyEdgePreprocessor` | Hard edges, architectural detail |

Start with `depth` at strength 0.9. Reduce strength if SDXL's style is being over-constrained by the composition hint.

## Notes

Refiner switch at 0.8 is a common starting point. Skip the refiner for faster generation. Typical CFG: 7–9. Negative prompts work well.
