'use strict';

// What ComfyRefinery needs from ComfyUI, and whether it's there.
//
// Two sources of truth, combined at request time:
//  - the arch builders themselves: each arch is built once with a dummy config
//    and every node class it emits is checked against ComfyUI's node index, so
//    "available" means "this ComfyUI can run this arch's graph", not a hand-kept list;
//  - PACKS below: the custom node packs that optional features (adapter modes,
//    pose / structural ControlNet, device placement) pull in, with the nodes
//    they must provide and a link.

const { buildWorkflow, archMeta } = require('../workflows');

const PACKS = [
  {
    id: 'controlnet_aux', label: 'comfyui_controlnet_aux', url: 'https://github.com/Fannovel16/comfyui_controlnet_aux',
    nodes: ['DWPreprocessor', 'MiDaS-DepthMapPreprocessor', 'HEDPreprocessor', 'LineArtPreprocessor', 'AnimeLineArtPreprocessor', 'CannyEdgePreprocessor'],
    features: [
      { archs: ['anima'],         feature: 'Pose ControlNet pre-pass (DWPose skeleton extraction)' },
      { archs: ['sd15', 'sdxl'],  feature: 'Structural chain mode (depth / soft-edge / lineart / canny preprocessors)' },
    ],
  },
  {
    id: 'anima_lllite', label: 'ComfyUI-Anima-LLLite', url: 'https://github.com/kohya-ss/ComfyUI-Anima-LLLite',
    nodes: ['AnimaLLLiteApply'],
    features: [{ archs: ['anima'], feature: 'Pose ControlNet apply (LLLite weights)' }],
  },
  {
    id: 'anima_ipadapter', label: 'comfyui-anima-ipadapter', url: 'https://github.com/Wenaka2004/comfyui-anima-ipadapter',
    nodes: ['AnimaIPAdapterLoader', 'AnimaIPAdapterApply', 'AnimaSiglipeEncodeImage'],
    features: [{ archs: ['anima'], feature: 'Adapter reference mode (disabled until the IP-Adapter weights ship)' }],
  },
  {
    id: 'ipadapter_plus', label: 'ComfyUI_IPAdapter_plus', url: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus',
    nodes: ['IPAdapterUnifiedLoader', 'IPAdapterModelLoader', 'IPAdapter'],
    features: [{ archs: ['sd15', 'sdxl'], feature: 'Adapter reference / chain mode (IP-Adapter)' }],
  },
  {
    id: 'multigpu', label: 'ComfyUI-MultiGPU', url: 'https://github.com/pollockjj/ComfyUI-MultiGPU',
    nodes: ['UNETLoaderMultiGPU', 'CLIPLoaderMultiGPU', 'DualCLIPLoaderMultiGPU', 'VAELoaderMultiGPU', 'CheckpointLoaderSimpleMultiGPU', 'CLIPVisionLoaderMultiGPU', 'ControlNetLoaderMultiGPU'],
    features: [{ archs: ['*'], feature: 'Device placement — load text encoder / VAEs on another GPU or CPU (model settings)' }],
  },
  {
    id: 'cogvideox_wrapper', label: 'ComfyUI-CogVideoXWrapper', url: 'https://github.com/kijai/ComfyUI-CogVideoXWrapper',
    nodes: ['CogVideoXModelLoader', 'CogVideoXTextEncode', 'CogVideoXImageEncode', 'CogVideoXEmptyLatentVideo', 'CogVideoXSampler'],
    features: [{ archs: ['cogvideox'], feature: 'CogVideoX generation (the whole graph)', required: true }],
  },
  {
    id: 'hunyuan_wrapper', label: 'ComfyUI-HunyuanVideoWrapper', url: 'https://github.com/kijai/ComfyUI-HunyuanVideoWrapper',
    nodes: ['HunyuanVideoModelLoader', 'HunyuanVideoTextEncode', 'HunyuanVideoImageToVideo'],
    features: [{ archs: ['hunyuanvideo'], feature: 'HunyuanVideo loader / encoder / I2V nodes', required: true }],
  },
  {
    id: 'res4lyf', label: 'RES4LYF', url: 'https://github.com/ClownsharkBatwing/RES4LYF',
    samplers: ['er_sde'],
    features: [{ archs: ['anima'], feature: 'er_sde sampler (Anima default) — if not in your ComfyUI build' }],
  },
];

// Minimum ComfyUI core version an arch's native nodes shipped in (when known).
const CORE_MIN_VERSION = { minimaxh3: '0.30.0' };

// Dummy config that makes every builder produce its base graph.
const DUMMY_MODEL = {
  checkpoint: 'x.safetensors', unetName: 'x.safetensors', unetName2: 'x.safetensors', clipL: 'x.safetensors', t5xxl: 'x.safetensors',
  clipName: 'x.safetensors', vaeName: 'x.safetensors', vae: 'x.safetensors', clip: 'x.safetensors',
};

// Every node class an arch's base graph emits (text-to-image / text-to-video).
function archBaseNodes(arch) {
  try {
    const { workflow } = buildWorkflow({ ...DUMMY_MODEL, id: 'probe', architecture: arch }, { positivePrompt: 'probe' });
    return [...new Set(Object.values(workflow).map(n => n.class_type))].sort();
  } catch (e) {
    return null; // builder needs more than the dummy provides — report as unknown
  }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// nodeIndex: { className: pythonModule } from ComfyUI's /object_info.
// samplers: KSampler's sampler_name choices.
// coreVersion: system_stats.system.comfyui_version.
function inspect({ nodeIndex = {}, samplers = [], coreVersion = null } = {}) {
  const has = n => Object.prototype.hasOwnProperty.call(nodeIndex, n);

  const packs = PACKS.map(p => {
    const missingNodes    = (p.nodes ?? []).filter(n => !has(n));
    const missingSamplers = (p.samplers ?? []).filter(s => !samplers.includes(s));
    const installed = missingNodes.length === 0 && missingSamplers.length === 0;
    // Where the pack's nodes actually come from, per ComfyUI (a fork or a core
    // backport may satisfy the same nodes under another module name).
    const modules = [...new Set((p.nodes ?? []).filter(has).map(n => nodeIndex[n]))];
    return { id: p.id, label: p.label, url: p.url, nodes: p.nodes ?? [], installed, missingNodes, missingSamplers, modules, features: p.features };
  });

  const archs = Object.keys(archMeta).map(arch => {
    const nodes = archBaseNodes(arch);
    const missingNodes = nodes ? nodes.filter(n => !has(n)) : [];
    const packsUsed = packs.filter(p => (p.nodes ?? []).some(n => nodes?.includes(n)));
    const minVersion = CORE_MIN_VERSION[arch] ?? null;
    const coreOk = !minVersion || !coreVersion || compareVersions(coreVersion, minVersion) >= 0;
    const optional = packs.filter(p => p.features.some(f => f.archs.includes(arch) || f.archs.includes('*')) && !packsUsed.includes(p))
      .map(p => ({ id: p.id, label: p.label, installed: p.installed, features: p.features.filter(f => f.archs.includes(arch) || f.archs.includes('*')).map(f => f.feature) }));
    return {
      arch, label: archMeta[arch].label ?? arch, videoArch: !!archMeta[arch].videoArch,
      available: nodes !== null && missingNodes.length === 0 && coreOk,
      nodes, missingNodes, minVersion, coreOk,
      requiredPacks: packsUsed.map(p => ({ id: p.id, label: p.label, installed: p.installed })),
      optionalPacks: optional,
    };
  });

  // Every custom node pack ComfyUI loaded, from the node index — installed
  // packs we don't know about are listed too (name = python module folder).
  const installedPacks = {};
  for (const [node, mod] of Object.entries(nodeIndex)) {
    if (!String(mod).startsWith('custom_nodes.')) continue;
    const name = String(mod).slice('custom_nodes.'.length).split('.')[0];
    (installedPacks[name] ??= { name, nodeCount: 0, known: packs.find(p => p.modules.some(m => String(m).startsWith(`custom_nodes.${name}`)))?.id ?? null }).nodeCount++;
  }
  return { packs, archs, installedPacks: Object.values(installedPacks).sort((a, b) => a.name.localeCompare(b.name)) };
}

module.exports = { PACKS, CORE_MIN_VERSION, inspect, archBaseNodes, compareVersions };
