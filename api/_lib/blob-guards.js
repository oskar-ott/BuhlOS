// Write guards for the blob stores (#157) — PREVENTION in front of the
// backup system's recovery (#151).
//
// Three guards, run inside writeBlob for every store:
//   1. VALIDATION   — per-store shape sanity (registry below). Unparseable /
//                     shape-invalid documents are rejected loudly; garbage
//                     never persists. Stores without a validator pass.
//   2. SHRINKAGE    — a write dropping >20% of a guarded store's top-level
//                     records is rejected unless the caller explicitly passes
//                     { allowShrink: true }. Catches the truncated-document
//                     bug class (the "users.json is suddenly 3 users" event).
//   3. REVISION     — every stored doc carries { __rev, __updatedAt }.
//                     Callers that pass { expectedRev } get a stale-write
//                     rejection when the stored rev moved. HONEST LIMIT:
//                     Vercel Blob has no compare-and-swap, so this NARROWS
//                     the lost-update window (fresh read at write time), it
//                     does not eliminate it. True CAS arrives with Postgres
//                     (the Phase 1 schema's `revision` column is the same
//                     concept).
//
// Rejections are audit-logged (storage.write_rejected, target 'system') via
// a LAZY require — audit-log.js itself writes through blob.js, so a top-level
// require here would be a CJS cycle.
//
// Validators are O(n) single-pass, no zod, no deep clones — observations.json
// can be large and this is the hottest path in the system.

class InvalidWriteError extends Error {
  constructor(key, reason) {
    super(`invalid write to ${key}: ${reason}`);
    this.code = 'invalid_write';
    this.key = key;
    this.reason = reason;
  }
}

class ShrinkWriteError extends Error {
  constructor(key, field, before, after) {
    super(
      `suspicious shrink writing ${key}: ${field} ${before} → ${after} records — pass allowShrink if intentional`
    );
    this.code = 'shrink_rejected';
    this.key = key;
    this.before = before;
    this.after = after;
  }
}

class StaleWriteError extends Error {
  constructor(key, expectedRev, currentRev) {
    super(`stale write to ${key}: expected rev ${expectedRev}, store is at ${currentRev}`);
    this.code = 'stale_write';
    this.key = key;
    this.expectedRev = expectedRev;
    this.currentRev = currentRev;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Every item must be an object with a non-empty string id. Single pass. */
function arrayOfIdObjects(field) {
  return (doc) => {
    if (!isPlainObject(doc)) return `${field} document must be an object`;
    const arr = doc[field];
    if (!Array.isArray(arr)) return `${field} must be an array`;
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i];
      if (!isPlainObject(it)) return `${field}[${i}] must be an object`;
      if (typeof it.id !== 'string' || !it.id) return `${field}[${i}].id must be a non-empty string`;
    }
    return null;
  };
}

function timeEntryDoc(doc) {
  if (!isPlainObject(doc)) return 'entry must be an object';
  if (typeof doc.id !== 'string' || !doc.id) return 'entry.id must be a non-empty string';
  if (typeof doc.userId !== 'string' || !doc.userId) return 'entry.userId must be a non-empty string';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.date))) return 'entry.date must be YYYY-MM-DD';
  if (typeof doc.status !== 'string' || !doc.status) return 'entry.status must be a string';
  return null;
}

/** Exact-key validators + the shrink-guard config (highest blast radius first). */
const EXACT_GUARDS = {
  'users.json': { validate: arrayOfIdObjects('users'), shrinkField: 'users', shrinkFloor: 10 },
  'jobs.json': { validate: arrayOfIdObjects('jobs'), shrinkField: 'jobs', shrinkFloor: 10 },
  'observations.json': {
    validate: arrayOfIdObjects('observations'),
    shrinkField: 'observations',
    shrinkFloor: 20,
  },
  'flags.json': {
    validate: (doc) => (isPlainObject(doc) && isPlainObject(doc.flags) ? null : 'flags must be an object'),
  },
  'structure-presets.json': { validate: arrayOfIdObjects('presets') },
  // Tag/calibration reminder dedupe state (#305): { entries: { key → {threshold,
  // notifiedAt} } }. No shrink guard — it legitimately empties as items get
  // retested and leave the alert window.
  'leave-requests.json': { validate: arrayOfIdObjects('requests') },
  'tag-reminder-state.json': {
    validate: (doc) =>
      isPlainObject(doc) && isPlainObject(doc.entries) ? null : 'entries must be an object',
  },
};

/** Pattern validators (multi-document stores). */
const PATTERN_GUARDS = [
  {
    test: (key) => /^users\/[^/]+\/time-entries\/\d{4}-\d{2}-\d{2}\.json$/.test(key),
    validate: timeEntryDoc,
  },
];

function guardFor(key) {
  if (EXACT_GUARDS[key]) return EXACT_GUARDS[key];
  const p = PATTERN_GUARDS.find((g) => g.test(key));
  return p ? { validate: p.validate } : null;
}

const SHRINK_RATIO = 0.8; // new count below 80% of old → rejected

/**
 * Run all guards. `current` is the stored document (or null/fallback shape).
 * Returns the STAMPED copy to persist. Throws typed errors on rejection.
 */
function applyGuards(key, data, current, opts = {}) {
  const guard = guardFor(key);

  if (guard && guard.validate) {
    const problem = guard.validate(data);
    if (problem) throw new InvalidWriteError(key, problem);
  }

  if (guard && guard.shrinkField && !opts.allowShrink && isPlainObject(current)) {
    const beforeArr = current[guard.shrinkField];
    const afterArr = isPlainObject(data) ? data[guard.shrinkField] : null;
    if (Array.isArray(beforeArr) && Array.isArray(afterArr)) {
      const before = beforeArr.length;
      const after = afterArr.length;
      if (before >= (guard.shrinkFloor || 10) && after < before * SHRINK_RATIO) {
        throw new ShrinkWriteError(key, guard.shrinkField, before, after);
      }
    }
  }

  const currentRev =
    isPlainObject(current) && Number.isFinite(current.__rev) ? current.__rev : 0;
  if (opts.expectedRev !== undefined && opts.expectedRev !== null) {
    if (Number(opts.expectedRev) !== currentRev) {
      throw new StaleWriteError(key, Number(opts.expectedRev), currentRev);
    }
  }

  // Stamp a shallow copy — never mutate the caller's object, never deep-clone.
  const stamped = Array.isArray(data) ? data : { ...data };
  if (isPlainObject(stamped)) {
    stamped.__rev = currentRev + 1;
    stamped.__updatedAt = new Date().toISOString();
  }
  return stamped;
}

/** Best-effort audit of a rejection. Lazy require — see header. */
function auditRejection(key, err, actor) {
  try {
    const { append } = require('./audit-log');
    append({
      action: 'storage.write_rejected',
      actorId: (actor && actor.id) || 'system',
      actorName: (actor && actor.username) || 'system',
      actorRole: (actor && actor.role) || 'system',
      jobId: null,
      targetType: 'system',
      targetId: key,
      summary: `write rejected (${err.code}) — ${String(err.message).slice(0, 160)}`,
      metadata: {
        code: err.code,
        key,
        ...(err.before !== undefined ? { before: err.before, after: err.after } : {}),
        ...(err.expectedRev !== undefined
          ? { expectedRev: err.expectedRev, currentRev: err.currentRev }
          : {}),
      },
    }).catch(() => {});
  } catch {
    /* audit must never mask the rejection itself */
  }
}

module.exports = {
  applyGuards,
  auditRejection,
  guardFor,
  InvalidWriteError,
  ShrinkWriteError,
  StaleWriteError,
  SHRINK_RATIO,
};
