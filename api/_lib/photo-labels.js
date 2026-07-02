// AI photo labels — server authority (#262).
//
// Fixed electrical-trade taxonomy + the pure merge/correction rules for the
// additive `labels` array on evidence rows. The client mirror
// (src/domains/evidence/labels.ts) re-declares the constants for typed UI use;
// a sync test keeps the two identical (audit-log enum precedent).
//
// Model of record:
//   labels: [{ label, source: 'ai'|'human',
//              status: 'suggested'|'accepted'|'rejected' (ai) | 'confirmed' (human),
//              confidence (ai, 0..1), modelVersion, promptVersion (ai),
//              at, byId, byName, reviewedById, reviewedByName, reviewedAt }]
//   aiLabelRuns: [{ modelVersion, promptVersion, at, labelCount }]
//
// Rules (the honesty contract):
//   - Suggestions never overwrite human decisions: a label with a human
//     `confirmed` entry is never duplicated, and a `rejected` label never
//     resurfaces from ANY later AI run (sticky — trust beats recall).
//   - Idempotent per (photo, modelVersion): a run marker is written even when
//     zero labels came back, so re-opening the queue never re-bills a photo.
//   - Server whitelist: labels outside the taxonomy are dropped, exactly like
//     api/tags.js drops unknown OCR fields.

const PHOTO_LABEL_TAXONOMY = [
  'switchboard',
  'rough-in',
  'fit-off',
  'cable-tray',
  'containment',
  'outlet',
  'lighting',
  'data-comms',
  'possible-defect',
  'progress',
  'materials',
  'equipment',
];

// Suggestions below this confidence are hidden by the display layer — no
// confident-looking wrong answers.
const LABEL_CONFIDENCE_DISPLAY_MIN = 0.5;

// Conservative floor for the #267 defect→snag suggestion (documented contract:
// a snag suggestion costs office attention; tune only from recorded precision).
const POSSIBLE_DEFECT_CONFIDENCE_MIN = 0.75;

const PHOTO_LABELS_PROMPT_VERSION = 'photo-labels-v1';

function isTaxonomyLabel(label) {
  return PHOTO_LABEL_TAXONOMY.includes(label);
}

function labelEntries(item) {
  return Array.isArray(item && item.labels) ? item.labels : [];
}

/** Has this row already been classified at this modelVersion? (Run markers
 *  count even when the run produced zero labels.) */
function hasAiLabelRun(item, modelVersion) {
  const runs = Array.isArray(item && item.aiLabelRuns) ? item.aiLabelRuns : [];
  return runs.some((r) => r && r.modelVersion === modelVersion);
}

/** Labels a human has rejected — sticky across every future run. */
function rejectedLabelSet(item) {
  const out = new Set();
  for (const e of labelEntries(item)) {
    if (e && e.source === 'ai' && e.status === 'rejected' && e.label) out.add(e.label);
  }
  return out;
}

function activeLabelSet(item) {
  const out = new Set();
  for (const e of labelEntries(item)) {
    if (!e || !e.label) continue;
    if (e.status === 'rejected') continue;
    out.add(e.label);
  }
  return out;
}

/**
 * Merge one AI run's raw labels into a row. Pure — returns
 * { labels, aiLabelRuns, added } without mutating the item.
 * Raw labels outside the taxonomy or with unusable confidence are dropped.
 */
function mergeAiLabels(item, rawLabels, { modelVersion, promptVersion, at } = {}) {
  if (!modelVersion) throw new Error('mergeAiLabels requires modelVersion');
  const stamp = at || new Date().toISOString();
  const rejected = rejectedLabelSet(item);
  const present = activeLabelSet(item);
  const next = labelEntries(item).slice();
  const added = [];

  for (const raw of Array.isArray(rawLabels) ? rawLabels : []) {
    if (!raw || !isTaxonomyLabel(raw.label)) continue;
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    if (rejected.has(raw.label)) continue; // human said no — stays no
    if (present.has(raw.label)) continue; // already carried by this row
    const entry = {
      label: raw.label,
      source: 'ai',
      status: 'suggested',
      confidence,
      modelVersion,
      promptVersion: promptVersion || PHOTO_LABELS_PROMPT_VERSION,
      at: stamp,
      byId: null,
      byName: null,
      reviewedById: null,
      reviewedByName: null,
      reviewedAt: null,
    };
    next.push(entry);
    present.add(raw.label);
    added.push(entry);
  }

  const runs = (Array.isArray(item && item.aiLabelRuns) ? item.aiLabelRuns : []).slice();
  runs.push({
    modelVersion,
    promptVersion: promptVersion || PHOTO_LABELS_PROMPT_VERSION,
    at: stamp,
    labelCount: added.length,
  });

  return { labels: next, aiLabelRuns: runs, added };
}

/**
 * Apply a human correction. Pure — returns { ok, labels?, error?, changed }.
 *   add:    string[] — new human labels (confirmed, human-owned)
 *   accept: string[] — AI suggestions the human confirmed
 *   remove: string[] — AI labels → rejected (sticky, auditable);
 *                      human labels → dropped
 */
function applyLabelCorrection(item, { add, accept, remove } = {}, actor, at) {
  const stamp = at || new Date().toISOString();
  const byId = (actor && actor.id) || null;
  const byName = (actor && (actor.username || actor.name)) || null;
  const wants = [...(add || []), ...(accept || []), ...(remove || [])];
  if (wants.length === 0) return { ok: false, error: 'nothing to change' };
  for (const label of wants) {
    if (!isTaxonomyLabel(label)) return { ok: false, error: `unknown label "${label}"` };
  }

  let labels = labelEntries(item).slice();
  let changed = false;

  for (const label of remove || []) {
    const kept = [];
    for (const e of labels) {
      if (!e || e.label !== label || e.status === 'rejected') {
        kept.push(e);
        continue;
      }
      if (e.source === 'human') {
        changed = true; // human label removed outright
        continue;
      }
      kept.push({
        ...e,
        status: 'rejected',
        reviewedById: byId,
        reviewedByName: byName,
        reviewedAt: stamp,
      });
      changed = true;
    }
    labels = kept;
  }

  for (const label of accept || []) {
    labels = labels.map((e) => {
      if (!e || e.label !== label || e.source !== 'ai' || e.status !== 'suggested') return e;
      changed = true;
      return {
        ...e,
        status: 'accepted',
        reviewedById: byId,
        reviewedByName: byName,
        reviewedAt: stamp,
      };
    });
  }

  const active = new Set(labels.filter((e) => e && e.status !== 'rejected').map((e) => e.label));
  for (const label of add || []) {
    if (active.has(label)) continue;
    labels.push({
      label,
      source: 'human',
      status: 'confirmed',
      confidence: null,
      modelVersion: null,
      promptVersion: null,
      at: stamp,
      byId,
      byName,
      reviewedById: null,
      reviewedByName: null,
      reviewedAt: null,
    });
    active.add(label);
    changed = true;
  }

  if (!changed) return { ok: false, error: 'no matching labels to change' };
  return { ok: true, labels, changed };
}

module.exports = {
  PHOTO_LABEL_TAXONOMY,
  LABEL_CONFIDENCE_DISPLAY_MIN,
  POSSIBLE_DEFECT_CONFIDENCE_MIN,
  PHOTO_LABELS_PROMPT_VERSION,
  isTaxonomyLabel,
  hasAiLabelRun,
  rejectedLabelSet,
  mergeAiLabels,
  applyLabelCorrection,
};
