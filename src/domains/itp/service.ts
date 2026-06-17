import { ITP_SIGNOFF_INDEPENDENCE_THRESHOLD } from "./schema";
import { formatProgress } from "./format";
import type { ITPInstance, ITPStatus } from "./types";

/**
 * Pure helpers + state-machine logic for the ITP domain.
 *
 * Server-side validation in api/job-itps.js mirrors the rules here in
 * plain JS — same precedent as src/domains/snags/service.ts. The
 * shared test in src/domains/itp/itp.test.ts asserts both lists
 * resolve to the same set.
 *
 * Cross-ref:
 *   docs/rebuild-audit/32-phase-e-plan.md §3 (operational loop)
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1a
 *   src/domains/snags/service.ts — precedent
 *   api/job-itps.js — server-side mirror
 */

/* ---------------------------------------------------------------------
 * State machine
 *
 * Happy path:
 *   null         → pending       (admin attaches template)
 *   pending      → in-progress   (worker records first point)
 *   in-progress  → witnessed     (worker/office taps "Submit for review")
 *   witnessed    → signed-off    (admin signs off — terminal happy path)
 *
 * Recovery / reverse paths:
 *   signed-off   → witnessed     (admin re-opens a signed-off instance)
 *
 * Notes:
 *   - Direct close from pending / in-progress to signed-off is NOT
 *     allowed. Status must reach witnessed first (i.e. the writer has
 *     captured every required point AND submitted it) before sign-off
 *     is offered.
 *   - pending → in-progress is the one auto-advance left in the record
 *     action. in-progress → witnessed is now an EXPLICIT 'submit' verb
 *     (see canSubmitForReview + api/job-itps.js action=submit) — it used
 *     to flip implicitly on the last record, which left no room for a
 *     deliberate "send it for review" step. ALLOWED_TRANSITIONS still
 *     lists in-progress → witnessed because canTransition() is the source
 *     of truth for "is this status flip legal" — the caller (record vs
 *     submit) decides which verb triggered it.
 *   - Archive is a separate boolean field, not a status; it does not
 *     appear in this machine. See ARCHIVE_VERBS below.
 * -------------------------------------------------------------------*/

export type ITPTransitionFrom = ITPStatus | null;
export type ITPTransitionTo = ITPStatus;

const ALLOWED_TRANSITIONS: ReadonlyArray<string> = [
  // create
  "null→pending",
  // happy path
  "pending→in-progress",
  "in-progress→witnessed",
  "witnessed→signed-off",
  // recovery
  "signed-off→witnessed",
];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_TRANSITIONS);

export function canTransition(
  from: ITPTransitionFrom,
  to: ITPTransitionTo,
): boolean {
  const key = `${from ?? "null"}→${to}`;
  return ALLOWED_SET.has(key);
}

/** Used by tests to assert the JS + TS state-machine lists stay in sync. */
export function allowedTransitionsList(): ReadonlyArray<string> {
  return ALLOWED_TRANSITIONS;
}

/* ---------------------------------------------------------------------
 * Role-based transition guards
 *
 * Tradies and Leading Hands have a narrower set than admins. Server
 * enforces these in api/job-itps.js; the same helper here so UIs can
 * hide buttons the user couldn't use.
 *
 * Worker rules:
 *   - any field user (tradie / LH) assigned to the job can record
 *     points. Recording can auto-advance pending → in-progress (the
 *     one auto-advance left); reaching witnessed is the explicit
 *     'submit' verb, which any writer is also allowed to trigger.
 *   - LH on an assigned job can also archive an instance (legacy
 *     behaviour: canManageJob includes LH on assigned jobs — see
 *     api/_lib/auth.js:158).
 *   - Workers cannot sign off or reopen — that's admin work.
 *
 * Admin rules:
 *   - any transition allowed by canTransition(), modulo the
 *     independence-rule check for sign-off (see canSignOff below).
 * -------------------------------------------------------------------*/

export interface RolePermissionContext {
  /** The acting user's id. */
  userId: string;
  /** Lowercased role string per src/lib/auth/roles canonical taxonomy. */
  role: string | null | undefined;
}

/** Role tiers mirror api/_lib/auth.js (PR #23 normalisation pass). The
 *  source-of-truth set lives there; this duplication exists so the
 *  service module stays pure (no api/* import on the client side). */
const ADMIN_ROLES = new Set([
  "admin",
  "boss",
  "owner",
  "manager",
  "office",
  "pm",
  "estimator",
]);
const LEADING_HAND_ROLES = new Set([
  "leadinghand",
  "leading_hand",
  "leading-hand",
  "lh",
]);
const FIELD_ROLES = new Set([
  "tradie",
  "apprentice",
  "labourer",
  "electrician",
]);

function normaliseRole(role: string | null | undefined): string {
  return String(role == null ? "" : role).toLowerCase();
}

export function isAdminRole(role: string | null | undefined): boolean {
  return ADMIN_ROLES.has(normaliseRole(role));
}

export function isLeadingHandRole(role: string | null | undefined): boolean {
  return LEADING_HAND_ROLES.has(normaliseRole(role));
}

export function isFieldRole(role: string | null | undefined): boolean {
  return FIELD_ROLES.has(normaliseRole(role));
}

/**
 * Role check for a status transition. Does NOT check the state
 * machine — callers must AND with canTransition().
 *
 * Sign-off is admin-only AND must pass the independence check —
 * callers should call canSignOff() for the full sign-off pre-check,
 * not just canRoleTransition().
 */
export function canRoleTransition(
  from: ITPTransitionFrom,
  to: ITPTransitionTo,
  ctx: RolePermissionContext,
): boolean {
  if (isAdminRole(ctx.role)) return true;
  const isField = isFieldRole(ctx.role) || isLeadingHandRole(ctx.role);
  if (!isField) return false;

  // Workers can drive the record auto-advance (pending → in-progress)
  // and the explicit 'submit' verb (in-progress → witnessed).
  if (from === "pending" && to === "in-progress") return true;
  if (from === "in-progress" && to === "witnessed") return true;

  // Sign-off + reopen are admin-only.
  return false;
}

/** Read-side helper: a worker (tradie / LH) can record on instances
 *  that aren't archived and aren't in a terminal sign-off state. The
 *  api/job-itps.js record path enforces both rules; surfacing them
 *  here lets the UI hide the input + Save button on signed-off rows. */
export function canRecord(
  instance: Pick<ITPInstance, "status" | "archived">,
  ctx: RolePermissionContext,
): boolean {
  if (instance.archived) return false;
  if (instance.status === "signed-off") return false;
  if (isAdminRole(ctx.role)) return true;
  return isFieldRole(ctx.role) || isLeadingHandRole(ctx.role);
}

/* ---------------------------------------------------------------------
 * Submit for review (in-progress → witnessed)
 *
 * The explicit "Submit for review" gate. An instance can be submitted
 * when it's mid-flight (in-progress), not archived, and every REQUIRED
 * point has been recorded. Submitting moves it to 'witnessed' — the
 * existing awaiting-sign-off state that /qa already counts. Anyone who
 * can record (field / LH / admin) can submit; the office can also push a
 * field-completed ITP for sign-off.
 *
 * Server enforces the same rules in api/job-itps.js action=submit; this
 * helper lets both the Phil recording panel and the admin queue hide /
 * disable the button without a round-trip. Tagged result so the UI can
 * pick precise copy:
 *   { ok: true }                              → safe to submit
 *   { ok: false, reason: 'wrong-role' }       → not a recorder/admin
 *   { ok: false, reason: 'archived' }         → instance archived
 *   { ok: false, reason: 'wrong-status' }     → not in-progress
 *                                               (pending/witnessed/signed-off)
 *   { ok: false, reason: 'no-required-points' } → template has no required
 *                                                 points to complete
 *   { ok: false, reason: 'incomplete-points' } → required points still open
 * -------------------------------------------------------------------*/

export type CanSubmitForReviewResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "wrong-role"
        | "archived"
        | "wrong-status"
        | "no-required-points"
        | "incomplete-points";
    };

export function canSubmitForReview(
  instance: ITPInstance,
  ctx: RolePermissionContext,
): CanSubmitForReviewResult {
  const canAct =
    isAdminRole(ctx.role) ||
    isFieldRole(ctx.role) ||
    isLeadingHandRole(ctx.role);
  if (!canAct) return { ok: false, reason: "wrong-role" };
  if (instance.archived) return { ok: false, reason: "archived" };
  if (instance.status !== "in-progress") {
    return { ok: false, reason: "wrong-status" };
  }
  // Reuse the domain's own progress criterion (required-points-with-`at`)
  // so the gate, the progress badge, and the server agree (P7).
  const progress = formatProgress(instance);
  if (progress.total === 0) return { ok: false, reason: "no-required-points" };
  if (progress.done < progress.total) {
    return { ok: false, reason: "incomplete-points" };
  }
  return { ok: true };
}

/* ---------------------------------------------------------------------
 * Independence rule (sign-off)
 *
 * The user signing off cannot be the same user who recorded a majority
 * of the points — unless they provide an override justification. The
 * threshold is configurable as ITP_SIGNOFF_INDEPENDENCE_THRESHOLD;
 * default 0.5 (must record strictly MORE than half to trip the rule).
 *
 * Server enforces the same logic in api/job-itps.js. Front-end uses
 * this to switch the modal between "Confirm sign off" and the
 * "Override justification (required)" textarea variant.
 *
 * Returns a tagged result:
 *   { ok: true, ratio }              → safe to sign off without justification
 *   { ok: false, reason: 'needs-justification', ratio }
 *                                    → requires a non-empty
 *                                       overrideJustification
 *   { ok: false, reason: 'wrong-role' }
 *                                    → not an admin; UI should never
 *                                       have offered the action
 *   { ok: false, reason: 'wrong-status', ratio: 0 }
 *                                    → status isn't 'witnessed';
 *                                       state machine would also block
 * -------------------------------------------------------------------*/

export type CanSignOffResult =
  | { ok: true; ratio: number }
  | { ok: false; reason: "needs-justification"; ratio: number }
  | { ok: false; reason: "wrong-role" }
  | { ok: false; reason: "wrong-status"; ratio: number };

export function canSignOff(
  instance: ITPInstance,
  ctx: RolePermissionContext,
): CanSignOffResult {
  if (!isAdminRole(ctx.role)) return { ok: false, reason: "wrong-role" };
  const ratio = pointsRecordedByUserRatio(instance, ctx.userId);
  if (instance.status !== "witnessed") {
    return { ok: false, reason: "wrong-status", ratio };
  }
  if (ratio > ITP_SIGNOFF_INDEPENDENCE_THRESHOLD) {
    return { ok: false, reason: "needs-justification", ratio };
  }
  return { ok: true, ratio };
}

/**
 * Ratio of recorded points where the recorder == userId. Pure helper
 * exported for the modal's UX copy ("You recorded N/M points on this
 * ITP — sign off requires a justification") and for the server's
 * threshold check.
 *
 * "Recorded" = the result row exists AND has an `at` timestamp (matches
 * formatProgress + the api/job-itps.js auto-advance criterion).
 * Optional points count toward the ratio because they're still part
 * of the work the signing user did — independence is about who
 * physically recorded the data, not which points were required.
 */
export function pointsRecordedByUserRatio(
  instance: ITPInstance,
  userId: string,
): number {
  const points = instance.templateSnapshot.points || [];
  const results = instance.results || {};
  let total = 0;
  let byUser = 0;
  for (const p of points) {
    if (p.archived) continue;
    const r = results[p.id];
    if (!r || !r.at) continue;
    total += 1;
    if (r.byUserId === userId) byUser += 1;
  }
  if (total === 0) return 0;
  return byUser / total;
}

/* ---------------------------------------------------------------------
 * Sort helper for the admin queue + Phil panel
 *
 * Active rows first (pending → in-progress → witnessed), then signed-off.
 * Within the same status, newest first by updatedAt. Mirrors the snag
 * compareForQueue ordering so admin-queue surfaces stay consistent.
 * -------------------------------------------------------------------*/

const STATUS_ORDER: Record<ITPStatus, number> = {
  pending: 0,
  "in-progress": 1,
  witnessed: 2,
  "signed-off": 3,
};

export function compareForQueue(
  a: { status: ITPStatus; updatedAt?: string },
  b: { status: ITPStatus; updatedAt?: string },
): number {
  const sa = STATUS_ORDER[a.status] ?? 99;
  const sb = STATUS_ORDER[b.status] ?? 99;
  if (sa !== sb) return sa - sb;
  // Newest first within the same status.
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}
