'use strict';

const fs   = require('fs');
const path = require('path');

const skillsDir = () => process.env.SKILLS_DIR || path.join(__dirname, '../../data/skills');
function skillPath(modelId) { return path.join(skillsDir(), `${modelId}.json`); }
function ensureDir() { fs.mkdirSync(skillsDir(), { recursive: true }); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

const MAX_VERSIONS = 5;

// ── Default skills per architecture ───────────────────────────────────────────

const DEFAULT_SKILLS = {
  sd15: `Write prompts as comma-separated Danbooru-style tags, not natural language sentences.

Tag ordering: quality tags first, then subject, then detail tags. Always open with "masterpiece, best quality, highly detailed".
Weighting syntax works: use (tag:1.3) to emphasize, (tag:0.8) to reduce. Keep boosts under 1.5.
Describe subjects with specific nouns: "1girl, solo, long silver hair, blue eyes" not "a pretty girl with silver hair".
Style and artist tags go after the subject: "anime style, studio ghibli, @ilya_kuvshinov".
Be specific about pose and composition: "standing, looking at viewer, upper body, cowboy shot" rather than abstract descriptions.`,

  sdxl: `Write prompts as a blend of natural language phrases and descriptive tags — SDXL handles both well.

Open with subject and quality context: "A portrait of a young woman, masterpiece, best quality, 8k uhd".
Include lighting, material, and atmosphere detail: "soft studio lighting, silk dress, bokeh background, photorealistic".
Natural language phrases work for composition: "close-up face, looking away, golden hour light".
Artist and style references are effective: "by Greg Rutkowski, concept art, digital painting".
SDXL handles longer prompts than SD1.5 — more detail generally improves output. Front-load what matters most.`,

  flux: `Write prompts as descriptive natural language sentences — Flux.1 uses a T5 encoder that reads grammar and syntax, not tag lists.

Do not use comma-separated tag lists or weighting syntax like (tag:1.4) — these are silently ignored.
Front-load the subject: "A young woman with silver hair stands in a sunlit forest" not "forest, woman, silver hair".
Use camera and lens language instead of quality tags: "shot on a Sony A7R V, 85mm f/1.8, shallow depth of field" conveys far more than "masterpiece, 8k".
Adverbs and action verbs carry pose information: "carefully reaching toward the camera" works better than a noun list.
Describe lighting with specific vocabulary: "softbox key light, rim light from behind, bounce fill on the shadow side".
Avoid "white background" — use "neutral studio backdrop" instead (white background causes blurry output in Flux Dev).`,

  flux2: `Write prompts as natural language prose — Flux 2 has a strong language model encoder (Mistral-3 for Dev, Qwen-3 for Klein) that understands sentence structure deeply.

No tag lists, no weighting syntax — write descriptive sentences.
Hex color codes work for precise color control: "wearing a jacket in #2E4A8B" reproduces specific colors reliably.
Describe complex scenes spatially: "in the foreground... behind her... in the background" — the model handles layered composition well.
Avoid contradictory descriptors in the same prompt: "bright sunny" paired with "moody dramatic shadows" produces a compromised blend rather than one being ignored.
For Klein, keep prompts concise (40–120 words) — it uses a smaller encoder than Dev.`,

  sd3: `SD3/SD3.5 uses three separate text encoders — if the ComfyUI workflow exposes separate prompt fields for each, use them differently.

T5 prompt (primary): Write full natural language description — composition, subject detail, spatial relationships, narrative.
CLIP-bigG prompt (secondary): Style and quality modifiers only — "amazing digital art, cinematic lighting, high quality". Pixel art and other style modes are driven here.
CLIP-L prompt: Leave empty when going for photorealism — populating it alongside the others causes artifacts.
If only one prompt field is available, write natural language prose and include both content and style.
SD3 handles multi-subject prompts well without special syntax: "a dog and a cat sit together" reliably produces two separate animals.`,

  chroma: `Write prompts as natural language prose — ChromaHD uses only T5 (CLIP was removed during training). Tag lists and quality booster tags have no effect.

Detailed prompts perform better than short ones: the model was specifically tuned to use more of the T5 context window.
Describe subjects, lighting, and composition in sentences rather than keyword fragments.
For portraits: describe expression, clothing texture, background environment, and lighting direction explicitly.
An intentional candid/amateur aesthetic is available and works well — prompt toward it deliberately: "amateur photograph, candid shot, slightly imperfect framing, natural light".`,

  anima: `Write prompts as Danbooru-style comma-separated tags — Anima is trained on Danbooru data.

Tag ordering: quality/safety tags → character count → character name → series/source → @artist → general description tags.
Always open with: "masterpiece, best quality, score_7, safe" — omitting safety tags on short prompts increases unwanted content.
Artist tags require an @ prefix to take effect: "@wlop", "@murata_range". Without @, the stylistic influence is negligible.
Weighting needs higher values than SD1.5: use (chibi:2) rather than (chibi:1.3) — the model's attention is less sensitive to low weights.
For multiple characters: name and describe each one individually — listing names alone without appearance tags causes identity blending.
Score tags for quality tiers: score_9, score_8_up, score_7_up. Avoid score_1 through score_4.`,

  wanvideo: `Write video prompts as natural language directions to a camera operator, not tag lists. No weighting syntax.

For I2V (image-to-video): describe motion only — the input image provides the subject, so re-describing appearance wastes the prompt budget.
For T2V: Subject + Motion → Camera Movement → Environment → Intensity modifier.
Always explicitly state background behavior — the model animates background elements by default: "the background remains static" or "trees sway gently in the wind".
Motion intensity vocabulary: "micro-" prefix for subtle (micro-blink, micro-glance), "gently" / "slowly" for low amplitude, "swaying violently" / "whipping" for high amplitude.
Camera vocabulary: "push in", "dolly out", "pan left", "orbit 15 degrees clockwise", "locked-off shot". Be specific with degrees and distances.
Specify single lighting sources for character consistency across frames — mixed lighting tones cause identity drift.`,

  hunyuanvideo: `Write video prompts as descriptive narrative prose — HunyuanVideo has a strong language model encoder (MLLM + T5) that understands semantics deeply.

T2V structure: Subject → Motion → Scene → Shot type → Camera movement → Lighting → Style → Atmosphere.
For I2V: Keep prompts shorter and focus on motion directives only — over-detailed I2V prompts cause unwanted scene transitions as the model tries to generate new scenes.
Chain sequential actions with temporal connectors: "first she looks up, then slowly turns toward the window, finally pausing to listen".
Describe emotion through physical action, not abstract labels: "tears welling and spilling down her cheek" rather than "she is sad".
Specify one clean camera move per clip — combining motions ("push in while panning left") produces a blended compromise rather than either move.
Style anchors that work well: "film noir", "cyberpunk neon city", "Ghibli animation", "ink wash painting", "BBC nature documentary".`,

  ltxvideo: `Write video prompts as a single paragraph of 4–8 present-tense sentences — no bullet points, no tag lists.

Structure: Shot type and style → Scene and lighting → Character and appearance → Action and motion → Camera movement.
For I2V: Do not describe the input image — describe only what moves, how it moves, and how the camera behaves.
Address every region of the frame: plain areas (sky, water, solid backgrounds) stay frozen unless you explicitly prompt motion in them.
Match prompt length to clip duration — a 3-sentence prompt extended to 10 seconds causes looping or abrupt motion changes.
Cinematography vocabulary: "wide establishing shot", "close-up", "tracking shot", "slow push in". Motion texture: "slow motion", "film grain", "lingering shot".`,

  minimaxh3: `Write video prompts as structured natural-language direction — MiniMax H3 uses a Qwen3-VL-32B encoder that understands long, precise briefs. No tag lists, no weighting syntax.

Structure: overall look/style first, then the action. For multi-beat clips use a timeline: "[0s-2s] ..., [2s-4s] ..." — H3 follows timestamped beats and hard cuts reliably.
Always describe the soundtrack — H3 generates native stereo audio in the same pass. End with an "Audio:" line covering music, ambience, and effects, with timing when it matters ("a low drone joins at 3s").
Dialogue is supported: quote exact lines and attribute them ("the man says: \\"...\\""); specify language and tone.
On-screen text must be quoted exactly and kept short; add "all text clearly legible, do not misspell" when text matters.
For reference-to-video, cite each reference as <Picture 1>…<Picture N> and give it an explicit role: identity ("the woman from <Picture 1>"), style, or object. Uncited references are used loosely.
Camera direction works well in plain terms: "slow push in", "handheld tracking shot", "static wide". One move per beat.`,

  cogvideox: `Write video prompts as natural language narrative (50–100 words). No tag lists. English only — translate before prompting.

Start directly with the subject — skip filler openers like "The video shows..." or "In this scene...".
Structure: Subject → Setting → Action/Motion → Atmosphere → Emotional tone.
When using camera motion LoRAs, put the camera directive first: "Camera slowly pans left. A woman walks through a market...".
Use expressive motion verbs for better temporal coherence: "cascades", "billowing", "glides", "dashes", "undulating" outperform generic "moves" or "walks".
Keep prompts above 20 words — unlike image models, very short prompts produce noticeably degraded output.
Avoid fine-grained gesture instructions ("raises her left hand") — they are unreliable. Broad motion directives work far better.`,

  zimage: `Write prompts as natural language prose — Z-Image uses a Qwen 3 4B text encoder that reads full sentences and semantic relationships, not tag lists.

No comma-separated tag syntax or weighting syntax like (tag:1.4) — write descriptive sentences instead.
CFG and negative prompts are fully supported. Use cfgScale 3–5; the default of 4 is a reliable starting point. Negative prompts are effective: "blurry, low quality, deformed anatomy, watermark, text artifacts" works well as a baseline.
Describe lighting, material texture, and optics explicitly: "shot on a 50mm prime, soft window light from the left, shallow depth of field" conveys more than generic quality boosters.
Bilingual prompting works natively — Chinese and English text in the same prompt is understood correctly.
For text-in-image generation (a standout Z-Image capability), quote the exact string in the prompt: "a neon sign reading \\"OPEN\\" in red letters" — the model renders readable text more reliably than most image models.
Negative prompt for text generation: include "garbled text, illegible characters" to suppress hallucinated glyphs.`,

  krea2: `Write prompts as long, dense natural-language prose — Krea 2 uses a Qwen3-VL-4B encoder and is tuned to reward detailed, paragraph-length descriptions over short tag lists.

No comma-separated tag syntax or weighting syntax like (tag:1.4) — write full descriptive sentences, and don't hesitate to write several.
At the default CFG of 1.0 (Krea 2 Turbo), negative prompts have no effect — the unconditional branch isn't sampled. They only matter if CFG is raised above 1 (Krea 2 Raw settings, ~cfgScale 3–3.5), so don't rely on a negative prompt for correction unless CFG has been raised.
Describe lighting, material texture, and lens/optics explicitly: "shot on a 35mm lens, overcast diffuse light, visible fabric weave" conveys more than generic quality boosters.
When using one of the official Krea 2 style LoRAs, append its trigger phrase to the prompt (e.g. "purple retro anime style" for krea2_retroanime, "monochrome ink wash style" for krea2_darkbrush) — the LoRA is tuned to respond to that exact phrase.
Keep composition and subject description concrete and spatial rather than abstract — this model favors literal descriptions of what's in frame over mood words alone.`,
};

// ── Migration ──────────────────────────────────────────────────────────────────

function migrate(data) {
  // Remap legacy workflowId/workflowLabel field names to modelId/modelLabel.
  if (!data.modelId && data.workflowId) {
    data.modelId    = data.workflowId;
    data.modelLabel = data.workflowLabel;
  }
  if (Array.isArray(data.versions)) return data;
  // Create a version if there is a skill text OR non-zero outcomes to preserve.
  const o = data.outcomes;
  const hasContent = data.skill || (o && (o.accepts + o.rejects) > 0);
  const versionId  = hasContent ? genId() : null;
  return {
    modelId:         data.modelId,
    modelLabel:      data.modelLabel,
    architecture:    data.architecture,
    skillLocked:     false,
    activeVersionId: versionId,
    versions: versionId ? [{
      id:        versionId,
      skill:     data.skill ?? null,
      createdAt: data.skillUpdatedAt ?? new Date().toISOString(),
      source:    'legacy',
      outcomes:  o ?? { accepts: 0, rejects: 0 },
    }] : [],
    notes: data.notes ?? [],
  };
}

function blankData(modelId, modelLabel, architecture) {
  return {
    modelId, modelLabel, architecture,
    skillLocked:     false,
    activeVersionId: null,
    versions:        [],
    notes:           [],
  };
}

function load(modelId) {
  try { return migrate(JSON.parse(fs.readFileSync(skillPath(modelId), 'utf8'))); }
  catch { return null; }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(skillPath(data.modelId), JSON.stringify(data, null, 2));
}

function getDefaultSkill(architecture) {
  return DEFAULT_SKILLS[architecture] ?? null;
}

function getActiveVersion(data) {
  return (data.versions ?? []).find(v => v.id === data.activeVersionId) ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

function record(modelId, modelLabel, architecture, verdict) {
  const data = load(modelId) ?? blankData(modelId, modelLabel, architecture);

  // Ensure there's always an active version to accumulate outcomes on.
  if (!data.activeVersionId || !getActiveVersion(data)) {
    const id = genId();
    data.versions.push({ id, skill: null, createdAt: new Date().toISOString(), source: 'initial', outcomes: { accepts: 0, rejects: 0 } });
    data.activeVersionId = id;
  }

  const ver = getActiveVersion(data);
  if (verdict === 'ACCEPT') ver.outcomes.accepts++;
  else                      ver.outcomes.rejects++;
  save(data);
}

// Add a new skill version, set it active, and evict the worst performer if over the cap.
function addVersion(modelId, skillText, source = 'auto') {
  const data = load(modelId);
  if (!data) return null;

  const id = genId();
  data.versions.push({ id, skill: skillText, createdAt: new Date().toISOString(), source, outcomes: { accepts: 0, rejects: 0 } });

  if (data.versions.length > MAX_VERSIONS) {
    const evictables = data.versions.filter(v => v.id !== id);
    evictables.sort((a, b) => {
      const ta = a.outcomes.accepts + a.outcomes.rejects;
      const tb = b.outcomes.accepts + b.outcomes.rejects;
      const ra = ta > 0 ? a.outcomes.accepts / ta : -1;
      const rb = tb > 0 ? b.outcomes.accepts / tb : -1;
      if (ra !== rb) return ra - rb; // ascending — worst first
      return new Date(a.createdAt) - new Date(b.createdAt); // oldest first on tie
    });
    data.versions = data.versions.filter(v => v.id !== evictables[0].id);
  }

  data.activeVersionId = id;
  save(data);
  return id;
}

// Backward-compat shim for any callers using setSkill.
function setSkill(modelId, skillText) {
  addVersion(modelId, skillText, 'manual');
}

function activateVersion(modelId, versionId) {
  const data = load(modelId);
  if (!data) return null;
  // versionId === null means revert to default skill
  if (versionId !== null && !data.versions.find(v => v.id === versionId)) return null;
  data.activeVersionId = versionId;
  save(data);
  return data;
}

function deleteVersion(modelId, versionId) {
  const data = load(modelId);
  if (!data) return null;
  if (data.activeVersionId === versionId) throw new Error('Cannot delete the active version');
  data.versions = data.versions.filter(v => v.id !== versionId);
  save(data);
  return data;
}

function setLocked(modelId, locked) {
  const data = load(modelId);
  if (!data) return null;
  data.skillLocked = Boolean(locked);
  save(data);
  return data;
}

function saveNotes(modelId, notes) {
  const data = load(modelId);
  if (!data) return;
  data.notes = notes;
  save(data);
}

function getSummary(modelId) {
  const data = load(modelId);
  if (!data) return null;

  const activeVer = getActiveVersion(data);
  const skillText = activeVer?.skill ?? getDefaultSkill(data.architecture);

  if (skillText) {
    const label = activeVer?.skill
      ? 'Prompt engineering notes for this model (learned from previous sessions)'
      : `Prompt engineering baseline for ${data.architecture ?? 'this architecture'}`;
    return `${label}:\n${skillText}`;
  }

  return null;
}

function getBlacklist(modelId) {
  const data = load(modelId);
  if (!data) return [];
  return (data.notes ?? [])
    .filter(n => n.enabled && n.type === 'blacklist')
    .flatMap(n => n.words ?? []);
}

function get(modelId) {
  const data = load(modelId);
  if (!data) return null;
  return { ...data, defaultSkill: getDefaultSkill(data.architecture) ?? null };
}

module.exports = { record, setSkill, addVersion, activateVersion, deleteVersion, setLocked, saveNotes, getSummary, getBlacklist, getDefaultSkill, get };
