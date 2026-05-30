import type { MaterialRequestStatus, MaterialRequestUrgency } from "./types";

/**
 * Pure helpers for the material-requests domain — used by the API
 * (mirrored in plain JS), the inbox UI, and any future per-job slice.
 *
 * Cross-ref: src/domains/snags/service.ts — precedent state machine.
 */

/* ---------------------------------------------------------------------
 * State machine — coarse on purpose. The procurement flow is short and
 * the boss often jumps states (e.g. "I rang the supplier, mark it
 * ordered" with no separate approve step). So allow the common direct
 * jumps; the audit-log captures the actual path via metadata.from/to.
 *
 * Happy path:
 *   requested → approved → ordered → delivered
 *
 * Allowed shortcuts:
 *   requested → ordered          (small jobs, no formal approve step)
 *   requested → cancelled        (oops, not needed)
 *   approved  → cancelled
 *   ordered   → cancelled        (called the supplier in time)
 *   ordered   → delivered
 *   delivered → ordered          (received the wrong qty / rejected on site)
 *   approved  → requested        (un-approve mistake)
 *
 * Cancellation requires a reason (schema enforces); re-opening a cancel
 * is delivered → ordered scope and intentionally not in scope here —
 * cancelled is the terminal state.
 * -------------------------------------------------------------------*/

const ALLOWED_TRANSITIONS: ReadonlyArray<string> = [
  "null→requested",
  "requested→approved",
  "requested→ordered",
  "requested→cancelled",
  "approved→ordered",
  "approved→cancelled",
  "approved→requested",
  "ordered→delivered",
  "ordered→cancelled",
  "delivered→ordered",
];
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_TRANSITIONS);

export type MaterialRequestTransitionFrom = MaterialRequestStatus | null;
export type MaterialRequestTransitionTo = MaterialRequestStatus;

export function canTransition(
  from: MaterialRequestTransitionFrom,
  to: MaterialRequestTransitionTo
): boolean {
  return ALLOWED_SET.has(`${from ?? "null"}→${to}`);
}

export function allowedTransitionsList(): ReadonlyArray<string> {
  return ALLOWED_TRANSITIONS;
}

/* ---------------------------------------------------------------------
 * Inbox sorting + summary.
 *
 * Same exception-first shape as the observations inbox (PR 3): the
 * "you need to do something" rows sit at the top, "we're waiting on
 * the supplier" below, "delivered / cancelled" at the bottom.
 * Within a status, urgent → low. Within a priority, newest first.
 * -------------------------------------------------------------------*/

const STATUS_ORDER: Record<MaterialRequestStatus, number> = {
  requested: 0,
  approved: 1,
  ordered: 2,
  delivered: 3,
  cancelled: 4,
};

const URGENCY_ORDER: Record<MaterialRequestUrgency, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function compareForInbox(
  a: { status: MaterialRequestStatus; urgency: MaterialRequestUrgency; requestedAt: string },
  b: { status: MaterialRequestStatus; urgency: MaterialRequestUrgency; requestedAt: string }
): number {
  const sa = STATUS_ORDER[a.status] ?? 99;
  const sb = STATUS_ORDER[b.status] ?? 99;
  if (sa !== sb) return sa - sb;
  const ua = URGENCY_ORDER[a.urgency] ?? 99;
  const ub = URGENCY_ORDER[b.urgency] ?? 99;
  if (ua !== ub) return ua - ub;
  return String(b.requestedAt || "").localeCompare(String(a.requestedAt || ""));
}

const OPEN_STATUSES: ReadonlySet<MaterialRequestStatus> = new Set([
  "requested",
  "approved",
  "ordered",
]);

export function isOpenRequest(status: MaterialRequestStatus): boolean {
  return OPEN_STATUSES.has(status);
}

export interface MaterialRequestSummary {
  total: number;
  open: number;
  requested: number;
  approved: number;
  ordered: number;
  delivered: number;
  cancelled: number;
  urgentOpen: number;
}

export function summariseInbox(
  requests: ReadonlyArray<{ status: MaterialRequestStatus; urgency: MaterialRequestUrgency }>
): MaterialRequestSummary {
  const s: MaterialRequestSummary = {
    total: requests.length,
    open: 0,
    requested: 0,
    approved: 0,
    ordered: 0,
    delivered: 0,
    cancelled: 0,
    urgentOpen: 0,
  };
  for (const r of requests) {
    s[r.status] += 1;
    if (isOpenRequest(r.status)) {
      s.open += 1;
      if (r.urgency === "urgent" || r.urgency === "high") s.urgentOpen += 1;
    }
  }
  return s;
}
