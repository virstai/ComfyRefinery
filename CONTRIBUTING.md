# Contributing to ComfyRefinery

## Forking

Fork freely and do whatever you like with it — that's what the MIT license is for.

## Pull Requests

PRs are welcome. To make review as smooth as possible, please include:

### Description
- What the PR does and why
- Any relevant context or motivation (e.g. a workflow that was broken, a missing architecture, a UX pain point)
- Screenshots or example outputs where applicable

### System info
Please include the following in your PR description:

| Field | Value |
|---|---|
| OS | e.g. Ubuntu 24.04, Windows 11, macOS 15 |
| Node.js version | `node --version` |
| ComfyUI version / commit | e.g. `git -C /path/to/ComfyUI rev-parse --short HEAD` |
| ComfyUI custom nodes relevant to the change | e.g. `comfyui_controlnet_aux @ abc1234` |
| GPU / VRAM | e.g. RTX 4090 24 GB |
| Architectures tested | e.g. sdxl, flux2 |

### Testing
- Describe how you tested the change
- Include any relevant test output (`npm test`)
- If you added a new architecture or step type, note which workflows you ran end-to-end

## Code style

- Keep changes focused — one concern per PR
- Match the existing patterns in the file you're editing
- No new comments unless the why is non-obvious
