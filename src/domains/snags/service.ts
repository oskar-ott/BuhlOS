import type { SnagStatus } from "./types";

/**
 * Pure helpers + state-machine logic for the snags domain.
 *
 * Lives separately from `format.ts` (display) and `client.ts` (network)
 * so server-side code (api/snags.js mirrors the same logic in plain JS
 * to avoid the TypeScript build dependency) can validate transitions
 * without dragging fetch / Zod into the hot path.
 *
 * Cross-ref:
 *   docs/rebuild-audit/phase-d55-snags-runbook.md
 *   src/domains/evidence/service.ts — precedent (same shape, narrower
 *   state machine)
 */

/* ---------------------------------------------------------------------
 * State machine
 *
 * Happy path:
 *   null         → open          (create)
 *   open         → in_progress   (someone picks it up)
 *   in_progress  → resolved      (assignee marks it resolved)
 *   resolved     → verified      (admin signs off on the fix)
 *   verified     → closed        (admin closes the loop)
 *
 * Recovery paths:
 *   in_progress  → open          (drop the claim)
 *   resolved     → in_progress   (re-open: fix didn't stick)
 *   resolved     → open          (re-open without re-claim)
 *   verified     → resolved      (admin un-verifies a verification mistake)
 *   closed       → verified      (admin re-opens a closed snag)
 *   open         → rejected      (admin rejects the report — needs reason)
 *   in_progress  → rejected      (same)
 *   resolved     → rejected      (admin rejects the proposed fix)
 *   rejected     → open          (someone re-opens a rejected snag)
 *
 * Direct close from open / in_progress is intentionally NOT allowed —
 * the verify step is the audit trail. If a snag was never a real
 * problem the admin rejects it with a reason instead.
 *
 * The set below is kept in sync with the JS copy in api/snags.js. The
 * shared test in src/domains/snags/snags.test.ts asserts both lists
 * resolve to the same set.
 * -------------------------------------------------------------------*/

export type SnagTransitionFrom = SnagStatus | null;
export type SnagTransitionTo = SnagStatus;

const ALLOWED_TRANSITIONS: ReadonlyArray<string> = [
  // create
  "null→open",
  // happy path
  "open→in_progress",
  "in_progress→resolved",
  "resolved→verified",
  "verified→closed",
  // recovery (forward + sideways)
  "in_progress→open",
  "resolved→in_progress",
  "resolved→open",
  "verified→resolved",
  "closed→verified",
  // reject branch
  "open→rejected",
  "in_progress→rejected",
  "resolved→rejected",
  "rejected→open",
];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_TRANSITIONS);

export function canTransition(
  from: SnagTransitionFrom,
  to: SnagTransitionTo
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
 * Tradies and Leading Hands have a narrower set of transitions than
 * admins. The server enforces these in api/snags.js; the same helper
 * is exported here so the Phil + Admin UIs can hide buttons the user
 * couldn't actually use.
 *
 * Worker rules:
 *   - any field user (tradie/LH) assigned to the job can pick up an
 *     open snag (open→in_progress) and drop their claim (in_progress→open).
 *   - the creator OR the current assignee can mark in_progress→resolved
 *     and re-open resolved→in_progress.
 *   - workers cannot verify, close, or reject — that's admin work.
 *
 * Admin rules:
 *   - any transition allowed by canTransition().
 *
 * `creatorId` and `assignedToId` may be null. `userId` is the actor
 * making the request. -------------------------------------------------*/

export interface RolePermissionContext {
  userId: string;
  role: string | null | undefined;
  creatorId: string | null | undefined;
  assignedToId: string | null | undefined;
}

const ADMIN_ROLES = new Set(["admin", "boss", "owner", "manager", "office"]);
const FIELD_ROLES = new Set(["tradie", "apprentice", "leadingHand"]);

function isAdminRole(role: string | null | undefined): boolean {
  return typeof role === "string" && ADMIN_ROLES.has(role);
}

function isFieldRole(role: string | null | undefined): boolean {
  return typeof role === "string" && FIELD_ROLES.has(role);
}

/**
 * Returns true if the role is allowed to perform the named transition.
 * Does NOT check the state machine — callers should AND this with
 * canTransition().
 */
export function canRoleTransition(
  from: SnagTransitionFrom,
  to: SnagTransitionTo,
  ctx: RolePermissionContext
): boolean {
  if (isAdminRole(ctx.role)) return true;
  if (!isFieldRole(ctx.role)) return false;

  // Field users can pick up + drop open snags on jobs they can write to
  // (job-level access is checked at the API gate, not here).
  if (from === "open" && to === "in_progress") return true;
  if (from === "in_progress" && to === "open") return true;

  // Creator / assignee can move their snag through the resolution path.
  const isCreator = !!ctx.creatorId && ctx.creatorId === ctx.userId;
  const isAssignee = !!ctx.assignedToId && ctx.assignedToId === ctx.userId;
  if ((isCreator || isAssignee) && from === "in_progress" && to === "resolved") {
    return true;
  }
  if (
    (isCreator || isAssignee) &&
    from === "resolved" &&
    (to === "in_progress" || to === "open")
  ) {
    return true;
  }

  // Everything else (verify, close, reject, re-open from closed/rejected)
  // is admin-only.
  return false;
}

/**
 * Read-side helper: returns true if a worker (tradie/LH/apprentice)
 * is allowed to see the snag at all. Mirrors the API's GET filter so
 * the Phil panel can decide what to render before the server replies.
 *
 * Field users see every snag on jobs they're assigned to (server
 * enforces the job-level gate). Clients are 403'd at the API layer.
 */
export function canFieldViewSnag(role: string | null | undefined): boolean {
  return isAdminRole(role) || isFieldRole(role);
}

/* ---------------------------------------------------------------------
 * Status / priority comparators for stable sorting in lists.
 *
 * Open + in_progress on top, then resolved, then verified, then
 * closed, then rejected. Within the same status, urgent → high →
 * normal → low. Within the same priority, newest first.
 * -------------------------------------------------------------------*/

const STATUS_ORDER: Record<SnagStatus, number> = {
  open: 0,
  in_progress: 1,
  resolved: 2,
  verified: 3,
  closed: 4,
  rejected: 5,
};

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function compareForQueue(
  a: { status: SnagStatus; priority: string; createdAt: string },
  b: { status: SnagStatus; priority: string; createdAt: string }
): number {
  const sa = STATUS_ORDER[a.status] ?? 99;
  const sb = STATUS_ORDER[b.status] ?? 99;
  if (sa !== sb) return sa - sb;
  const pa = PRIORITY_ORDER[a.priority] ?? 99;
  const pb = PRIORITY_ORDER[b.priority] ?? 99;
  if (pa !== pb) return pa - pb;
  // Newest first as the tiebreaker — matches evidence sort.
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}
