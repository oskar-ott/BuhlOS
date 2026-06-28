import { ITP_CONDITION_KEYS } from "./schema";
import type { ITPScope, ITPTemplatePoint } from "./types";

/**
 * Conditional ITP points — the ONE evaluation source (#293, scope-type v1).
 *
 * A template point may carry an `onlyIf` condition so a check only
 * applies in the right context. This module is the single, pure, total,
 * deterministic decision function for "does this point apply to this
 * instance?". The CJS mirror api/_lib/itp-applicability.js reproduces
 * the same rules byte-for-byte (api/*.js can't import TS); the parity
 * test in api/_lib/itp-applicability.parity.test.ts pins them together.
 *
 * Evaluation ALWAYS reads the point's `onlyIf` exactly as supplied by
 * the caller. Callers MUST pass the attach-time snapshot point
 * (templateSnapshot.points[…]), never the live template — editing a
 * template must not retro-change an existing instance's checklist
 * (snapshot semantics, see schema.ts header).
 *
 * FAIL-OPEN (P7): the rules below ONLY ever return "does not apply" for a
 * condition we fully understand and that genuinely excludes the scope.
 * A missing condition, an unknown key, a malformed value — anything we
 * can't confidently evaluate — APPLIES. A typo in a template must never
 * silently drop a real inspection; the worst that happens is a check
 * shows when a tighter author intended to hide it, which is safe.
 * (The opposite stance, FAIL-CLOSED, lives at SAVE time in
 * api/itp-templates.js so garbage never persists in the first place.)
 *
 * The word "condition" is a DATA term here. It never reaches Phil copy
 * (P11) — non-applicable points are simply absent from the worker's
 * list, with no "condition"/"not applicable" UI.
 *
 * Cross-ref:
 *   src/domains/itp/schema.ts — onlyIf shape + closed vocabulary
 *   api/_lib/itp-applicability.js — CJS mirror (same rules)
 *   src/domains/itp/applicability.test.ts — unit + total/deterministic
 */

export interface ApplicabilityContext {
  /** The instance scope — what part of the job this ITP covers. */
  scope: ITPScope;
}

/** Normalise a scopeType value (scalar or array) to a string[] of the
 *  raw entries, tolerating non-array / non-string junk by yielding []
 *  (which the caller treats as "can't evaluate → fail open"). */
function toAllowedList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") return [value];
  return [];
}

/**
 * Does this point apply to an instance with the given context?
 *
 * Rules (in order):
 *   1. No `onlyIf` (or it isn't an object) → APPLIES (byte-for-byte the
 *      behaviour before #293).
 *   2. `onlyIf` carries ONLY keys we don't recognise → APPLIES
 *      (fail-open: an unknown/garbage key is never a silent exclusion).
 *   3. `scopeType` present → applies iff the instance scope ∈ the
 *      allowed set. A malformed scopeType (empty after normalisation)
 *      → APPLIES (fail-open).
 *
 * Total + deterministic: every input returns a boolean; the same input
 * always returns the same boolean.
 */
export function isPointApplicable(
  point: Pick<ITPTemplatePoint, "onlyIf"> & Record<string, unknown>,
  ctx: ApplicabilityContext,
): boolean {
  const onlyIf = point?.onlyIf;
  if (!onlyIf || typeof onlyIf !== "object") return true;

  const condition = onlyIf as Record<string, unknown>;

  // Does the condition carry any key we actually understand? If not,
  // it's an unknown/garbage condition → fail open (applies).
  const hasKnownKey = ITP_CONDITION_KEYS.some(
    (k) => Object.prototype.hasOwnProperty.call(condition, k) && condition[k] != null,
  );
  if (!hasKnownKey) return true;

  // scopeType — the only v1 key.
  if (
    Object.prototype.hasOwnProperty.call(condition, "scopeType") &&
    condition.scopeType != null
  ) {
    const allowed = toAllowedList(condition.scopeType);
    // Malformed value (nothing usable) → fail open.
    if (allowed.length === 0) return true;
    return allowed.includes(ctx.scope);
  }

  // No understood key produced a verdict → fail open.
  return true;
}

/**
 * Human-readable reason a point is NOT applicable, for ADMIN/EXPORT
 * surfaces only (never Phil). Returns null when the point applies (or
 * when the exclusion can't be described). Phrased as a defensible
 * exclusion, e.g. "Only applies to switchboard, area" — the kind of
 * line that reads as data on a compliance pack, not a silent gap.
 */
export function applicabilityReason(
  point: Pick<ITPTemplatePoint, "onlyIf"> & Record<string, unknown>,
  ctx: ApplicabilityContext,
): string | null {
  if (isPointApplicable(point, ctx)) return null;
  const onlyIf = point?.onlyIf as Record<string, unknown> | null | undefined;
  if (onlyIf && onlyIf.scopeType != null) {
    const allowed = toAllowedList(onlyIf.scopeType);
    if (allowed.length > 0) {
      return `Only applies to ${allowed.join(", ")}`;
    }
  }
  // isPointApplicable returned false but we can't name why — shouldn't
  // happen given the rules above, but stay total.
  return "Does not apply to this scope";
}

/** Filter a list of points to those applicable in the given context.
 *  Pure + order-preserving — the one place list surfaces should go so
 *  Phil, progress, and the export agree (one source of truth). */
export function applicablePoints<T extends Pick<ITPTemplatePoint, "onlyIf">>(
  points: ReadonlyArray<T>,
  ctx: ApplicabilityContext,
): T[] {
  return points.filter((p) =>
    isPointApplicable(p as T & Record<string, unknown>, ctx),
  );
}
