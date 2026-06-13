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

module.exports = { applyLoraChain };
