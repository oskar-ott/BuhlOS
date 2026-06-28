'use strict';

// Conditional ITP points — CJS mirror of src/domains/itp/applicability.ts
// (#293, scope-type v1). api/*.js can't import TS, so this reproduces the
// SAME pure, total, deterministic rules. The parity test
// (api/_lib/itp-applicability.parity.test.ts) asserts JS and TS agree on a
// shared truth table so they can't drift.
//
// Snapshot semantics: callers pass the attach-time snapshot point
// (templateSnapshot.points[…]), never the live template — editing a
// template must not retro-change an existing instance's checklist.
//
// FAIL-OPEN (P7): only ever returns "does not apply" for a condition we
// fully understand AND that genuinely excludes the scope. Missing /
// unknown / malformed → APPLIES, so a typo never silently drops a real
// inspection. (FAIL-CLOSED at save lives in api/itp-templates.js.)
//
// Closed vocabulary v1 — mirrors ITP_CONDITION_KEYS in
// src/domains/itp/schema.ts. Add new keys to BOTH lists + both evaluators
// + the save-time whitelist together.
const CONDITION_KEYS = ['scopeType'];

function toAllowedList(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === 'string');
  }
  if (typeof value === 'string') return [value];
  return [];
}

// Does this point apply to an instance with the given context { scope }?
// Rules (in order):
//   1. No onlyIf (or not an object) → APPLIES (pre-#293 behaviour).
//   2. onlyIf carries only keys we don't recognise → APPLIES (fail-open).
//   3. scopeType present → applies iff ctx.scope ∈ allowed set;
//      malformed scopeType → APPLIES (fail-open).
function isPointApplicable(point, ctx) {
  const onlyIf = point && point.onlyIf;
  if (!onlyIf || typeof onlyIf !== 'object') return true;

  const hasKnownKey = CONDITION_KEYS.some(
    (k) =>
      Object.prototype.hasOwnProperty.call(onlyIf, k) && onlyIf[k] != null,
  );
  if (!hasKnownKey) return true;

  if (
    Object.prototype.hasOwnProperty.call(onlyIf, 'scopeType') &&
    onlyIf.scopeType != null
  ) {
    const allowed = toAllowedList(onlyIf.scopeType);
    if (allowed.length === 0) return true; // malformed → fail open
    return allowed.includes(ctx && ctx.scope);
  }

  return true; // no understood key produced a verdict → fail open
}

// Human-readable exclusion reason for ADMIN/EXPORT only (never Phil).
// Null when the point applies.
function applicabilityReason(point, ctx) {
  if (isPointApplicable(point, ctx)) return null;
  const onlyIf = point && point.onlyIf;
  if (onlyIf && onlyIf.scopeType != null) {
    const allowed = toAllowedList(onlyIf.scopeType);
    if (allowed.length > 0) {
      return 'Only applies to ' + allowed.join(', ');
    }
  }
  return 'Does not apply to this scope';
}

module.exports = { isPointApplicable, applicabilityReason, CONDITION_KEYS };
