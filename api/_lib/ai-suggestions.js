// Shared AI-suggestion review conventions (2026-07 standalone AI batch:
// #246 quote drafts, #262 photo labels, #267 snag suggestions, #347 insights
// digest, #373 contract obligations).
//
// The house rule is "AI assists, never silently decides" — every AI output is
// a SUGGESTION carrying provenance + confidence, and becomes real data only
// through an explicit human review action. Storage stays feature-local (per-
// quote ai section, evidence rows, per-job extraction blobs, digest blobs);
// what is shared is the envelope shape, the review state machine, and the
// honesty helpers (strict model-JSON parsing, numeral grounding).
//
// This module deliberately holds NO store access and NO model access — the
// model call is api/_lib/ai.js (#170 gateway); persistence is the caller's.

const { nanoid } = require('./validation');

// ── review state machine ─────────────────────────────────────────────────
//
//   suggested → accepted | edited | rejected | superseded
//
// `edited` is accept-with-changes: the human correction is recorded alongside
// the original AI payload so the trail shows both. Terminal states never
// transition again — a re-run produces NEW suggestions and marks stale ones
// `superseded`, it never rewrites reviewed history.

const AI_SUGGESTION_STATUSES = ['suggested', 'accepted', 'edited', 'rejected', 'superseded'];

const REVIEW_TRANSITIONS = {
  suggested: new Set(['accepted', 'edited', 'rejected', 'superseded']),
  accepted: new Set(),
  edited: new Set(),
  rejected: new Set(),
  superseded: new Set(),
};

function canTransition(from, to) {
  const allowed = REVIEW_TRANSITIONS[from];
  return Boolean(allowed && allowed.has(to));
}

// ── envelope ─────────────────────────────────────────────────────────────

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * The provenance envelope every AI suggestion carries. Callers spread this
 * into their feature-local record next to the feature payload.
 */
function suggestionEnvelope({ type, model, promptVersion, confidence, sources, createdBy, jobId, sourceEntityType, sourceEntityId, sourceLocation } = {}) {
  if (!type || typeof type !== 'string') throw new Error('suggestionEnvelope requires a type');
  if (!model || typeof model !== 'string') throw new Error('suggestionEnvelope requires the model id');
  if (!promptVersion || typeof promptVersion !== 'string') {
    throw new Error('suggestionEnvelope requires a promptVersion');
  }
  return {
    id: nanoid('ais_'),
    type,
    status: 'suggested',
    model,
    promptVersion,
    confidence: clampConfidence(confidence),
    // {store, id} refs, same shape the #170 tool layer returns.
    sources: Array.isArray(sources) ? sources : [],
    jobId: jobId || null,
    sourceEntityType: sourceEntityType || null,
    sourceEntityId: sourceEntityId || null,
    sourceLocation: sourceLocation || null,
    createdAt: new Date().toISOString(),
    createdBy: createdBy || 'system:ai',
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewNote: null,
    humanCorrection: null,
    auditLogIds: [],
  };
}

/**
 * Apply a human review to a suggestion. Pure — returns a NEW record or an
 * error; never mutates. `humanCorrection` is required for `edited` (that is
 * what distinguishes it from a plain accept).
 */
function reviewSuggestion(record, { status, reviewedById, reviewedByName, reviewNote, humanCorrection } = {}) {
  if (!record || typeof record !== 'object') return { ok: false, error: 'no suggestion record' };
  if (!AI_SUGGESTION_STATUSES.includes(status)) {
    return { ok: false, error: `unknown review status "${status}"` };
  }
  if (!canTransition(record.status, status)) {
    return { ok: false, error: `cannot move a ${record.status} suggestion to ${status}` };
  }
  if (status === 'edited' && (humanCorrection === undefined || humanCorrection === null)) {
    return { ok: false, error: 'edited requires the humanCorrection payload' };
  }
  if (status !== 'superseded' && !reviewedById) {
    return { ok: false, error: 'review requires the reviewing user' };
  }
  return {
    ok: true,
    record: {
      ...record,
      status,
      reviewedById: reviewedById || null,
      reviewedByName: reviewedByName || null,
      reviewedAt: new Date().toISOString(),
      reviewNote: typeof reviewNote === 'string' && reviewNote.trim() ? reviewNote.trim() : null,
      humanCorrection: humanCorrection === undefined ? null : humanCorrection,
    },
  };
}

// ── model-output honesty helpers ─────────────────────────────────────────

/**
 * Strict JSON from a model reply. Tolerates a fenced ```json block (models
 * add them) but never guesses beyond that — a non-JSON reply is an honest
 * failure, not a partial answer.
 */
function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'empty model reply' };
  }
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, error: 'model reply was not valid JSON' };
  }
}

/**
 * Grounding check for phrased output (#347): every number in the prose must
 * literally appear in the findings payload. Returns the missing numerals so
 * the caller can fail honestly (and fall back to a deterministic template).
 *
 * Numbers are compared as normalised strings ("18.0" ≡ "18"); numerals inside
 * dates/ids in the payload count as grounded values.
 */
function extractNumerals(text) {
  if (typeof text !== 'string') return [];
  const matches = text.match(/\d+(?:\.\d+)?/g) || [];
  return matches.map((m) => String(Number(m)));
}

function ungroundedNumerals(prose, payload) {
  let payloadText;
  try {
    payloadText = JSON.stringify(payload);
  } catch {
    payloadText = '';
  }
  const allowed = new Set(extractNumerals(payloadText));
  const missing = [];
  for (const n of extractNumerals(prose)) {
    if (!allowed.has(n) && !missing.includes(n)) missing.push(n);
  }
  return missing;
}

module.exports = {
  AI_SUGGESTION_STATUSES,
  canTransition,
  clampConfidence,
  suggestionEnvelope,
  reviewSuggestion,
  parseModelJson,
  extractNumerals,
  ungroundedNumerals,
};
