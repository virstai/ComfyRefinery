'use strict';

function applyLoraChain(nodes, modelRef, clipRef, loras, makeId = i => String(30 + i)) {
  (loras ?? []).forEach((l, i) => {
    const id = makeId(i);
    nodes[id] = { class_type: "LoraLoader", inputs: {
      lora_name:      l.name,
      strength_model: l.weight ?? 1.0,
      strength_clip:  l.weight ?? 1.0,
      model:          modelRef,
      clip:           clipRef,
    }};
    modelRef = [id, 0];
    clipRef  = [id, 1];
  });
  return { modelRef, clipRef };
}

// Model-only variant for archs whose LoRAs never touch the text encoder
// (e.g. Krea 2, trained on the DiT only) — ComfyUI's LoraLoaderModelOnly.
function applyModelOnlyLoraChain(nodes, modelRef, loras, makeId = i => String(30 + i)) {
  (loras ?? []).forEach((l, i) => {
    const id = makeId(i);
    nodes[id] = { class_type: "LoraLoaderModelOnly", inputs: {
      lora_name:      l.name,
      strength_model: l.weight ?? 1.0,
      model:          modelRef,
    }};
    modelRef = [id, 0];
  });
  return modelRef;
}

module.exports = { applyLoraChain, applyModelOnlyLoraChain };
