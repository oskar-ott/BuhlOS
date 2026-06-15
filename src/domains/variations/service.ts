import type {
  CreateVariationApprovalInput,
  VariationApprovalBlocker,
  VariationApprovalEvent,
  VariationApprovalEventType,
  VariationApprovalRecord,
  VariationApprovalStatus,
  VariationApprovalTransitionErrorCode,
  VariationApprovalTransitionResult,
  WorkAtRiskAuthorisation,
} from "./types";

/**
 * Pure variation/daywork approval logic (no I/O, no UI, no persistence). The
 * one rule that drives everything: **work is not released without a recorded
 * builder approval**, and the only way around that is the explicit, named
 * `work_at_risk` exception. Every time-dependent value (`at`) is injected so
 * the domain stays deterministic and unit-testable (the dayworks/exceptions
 * convention).
 */

// ── Transition table ─────────────────────────────────────────────────────────

/**
 * Allowed status moves. Crucially absent: `draft → released_for_work` and
 * `sent_to_builder → released_for_work` — release is only ever reachable from
 * `approved`. `work_at_risk` is the sole way work proceeds without approval.
 */
const TRANSITIONS: ReadonlyArray<readonly [VariationApprovalStatus, VariationApprovalStatus]> = [
  // Normal path.
  ["draft", "sent_to_builder"],
  ["sent_to_builder", "approved"],
  ["approved", "released_for_work"],
  ["released_for_work", "completed"],
  ["completed", "claimed"],
  ["claimed", "invoiced"],

  // Builder decision side-paths.
  ["sent_to_builder", "rejected"],
  ["sent_to_builder", "expired"],
  ["approved", "cancelled"],

  // Dispute paths.
  ["completed", "disputed"],
  ["claimed", "disputed"],

  // Exception: work starts before approval. Enterable from draft (no quote out
  // yet) or sent_to_builder (awaiting decision).
  ["draft", "work_at_risk"],
  ["sent_to_builder", "work_at_risk"],
  // …and how at-risk work resolves: builder approves retroactively, the work
  // finishes (still unapproved → claim risk), or it is abandoned.
  ["work_at_risk", "approved"],
  ["work_at_risk", "completed"],
  ["work_at_risk", "cancelled"],
];

/** Whether a status change is structurally allowed. Pure shape check — it does
 *  NOT verify required payload (use {@link transitionVariationApproval} for
 *  the full guard, including approver / at-risk authorisation). */
export function canTransitionVariationStatus(
  from: VariationApprovalStatus,
  to: VariationApprovalStatus,
): boolean {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function allowedVariationTransitions(): ReadonlyArray<
  readonly [VariationApprovalStatus, VariationApprovalStatus]
> {
  return TRANSITIONS;
}

/** Target status each event drives the record toward. */
const EVENT_TARGET: Record<VariationApprovalEventType, VariationApprovalStatus> = {
  send_to_builder: "sent_to_builder",
  approve: "approved",
  reject: "rejected",
  expire: "expired",
  release_for_work: "released_for_work",
  start_work_at_risk: "work_at_risk",
  complete: "completed",
  cancel: "cancelled",
  claim: "claimed",
  invoice: "invoiced",
  dispute: "disputed",
};

// ── Approval / risk predicates ────────────────────────────────────────────────

const CLOSED_WITHOUT_WORK: ReadonlySet<VariationApprovalStatus> = new Set([
  "rejected",
  "expired",
  "cancelled",
]);

const WORK_DONE: ReadonlySet<VariationApprovalStatus> = new Set([
  "completed",
  "claimed",
  "invoiced",
  "disputed",
]);

/** Whether a recorded builder approval exists. */
function hasBuilderApproval(record: Pick<VariationApprovalRecord, "approvedBy" | "approvedAt">): boolean {
  return record.approvedBy != null && record.approvedBy !== "" && record.approvedAt != null;
}

/**
 * Is this variation approved such that work may be released? True only when a
 * builder approval is recorded and the record is not closed out. A
 * `work_at_risk` record is NOT approved for work (that is the whole point of
 * the exception).
 */
export function isVariationApprovedForWork(
  record: Pick<VariationApprovalRecord, "status" | "approvedBy" | "approvedAt">,
): boolean {
  if (CLOSED_WITHOUT_WORK.has(record.status)) return false;
  return hasBuilderApproval(record);
}

/**
 * Does this variation still need a builder approval? True until one is
 * recorded; false once approved or once the record is closed without work.
 * Note a `work_at_risk` (or completed-at-risk) record still *requires*
 * approval — the risk is not cleared until the builder approves.
 */
export function requiresBuilderApproval(
  record: Pick<VariationApprovalRecord, "status" | "approvedBy" | "approvedAt">,
): boolean {
  if (CLOSED_WITHOUT_WORK.has(record.status)) return false;
  return !hasBuilderApproval(record);
}

/** Is work proceeding under the at-risk exception right now? */
export function isWorkAtRisk(record: Pick<VariationApprovalRecord, "status">): boolean {
  return record.status === "work_at_risk";
}

/**
 * Is this a claim risk — work done (completed/claimed/invoiced/disputed) with
 * no recorded builder approval? Such work may not be claimable; admin must
 * chase approval.
 */
export function isVariationClaimRisk(
  record: Pick<VariationApprovalRecord, "status" | "approvedBy" | "approvedAt">,
): boolean {
  return WORK_DONE.has(record.status) && !hasBuilderApproval(record);
}

/** Whether an at-risk authorisation carries the required fields: a reason, who
 *  authorised it, and when. `source` is optional. */
export function isWorkAtRiskAuthorisationComplete(
  auth: WorkAtRiskAuthorisation | null | undefined,
): auth is WorkAtRiskAuthorisation {
  if (!auth) return false;
  return (
    auth.reason.trim().length > 0 &&
    auth.authorisedBy.trim().length > 0 &&
    auth.authorisedAt.trim().length > 0
  );
}

// ── Blockers ──────────────────────────────────────────────────────────────---

/** Reasons a variation is not cleanly releasable or claimable, for admin
 *  follow-up. Empty array = nothing blocking. */
export function getVariationApprovalBlockers(
  record: Pick<VariationApprovalRecord, "status" | "approvedBy" | "approvedAt" | "workAtRisk">,
): VariationApprovalBlocker[] {
  const blockers: VariationApprovalBlocker[] = [];

  if (isWorkAtRisk(record)) {
    blockers.push({
      code: "work_at_risk",
      message: "WORK AT RISK — approval not received. Chase builder approval.",
    });
    if (!isWorkAtRiskAuthorisationComplete(record.workAtRisk)) {
      blockers.push({
        code: "missing_authorisation",
        message:
          "Work-at-risk authorisation incomplete — a reason, who authorised it and when are required.",
      });
    }
  }

  if (isVariationClaimRisk(record)) {
    blockers.push({
      code: "claim_risk_unapproved",
      message: "CLAIM RISK — work completed without recorded builder approval. May not be claimable.",
    });
  }

  return blockers;
}

// ── Factory ───────────────────────────────────────────────────────────────---

/**
 * Build a fresh approval record in `draft`. Pure — it returns a record, it does
 * not persist anything. The caller (an API layer, later) owns id minting and
 * storage; here we only stamp the lifecycle defaults.
 */
export function createVariationApprovalRecord(
  input: CreateVariationApprovalInput,
  at: string,
): VariationApprovalRecord {
  return {
    id: input.id,
    jobId: input.jobId,
    variationId: input.variationId ?? null,
    kind: input.kind ?? "variation",
    title: input.title,
    description: input.description ?? null,
    status: "draft",
    requestedBy: input.requestedBy,
    requestedByName: input.requestedByName ?? null,
    builderContactId: input.builderContactId ?? null,
    quoteRef: input.quoteRef ?? null,
    sentToBuilderAt: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    decisionNote: null,
    workAtRisk: null,
    completedAt: null,
    claimedAt: null,
    invoiceRef: null,
    invoicedAt: null,
    createdAt: at,
    updatedAt: at,
    auditLogIds: [],
  };
}

// ── Transition ──────────────────────────────────────────────────────────────

function fail(
  record: VariationApprovalRecord,
  code: VariationApprovalTransitionErrorCode,
  error: string,
): VariationApprovalTransitionResult {
  return { ok: false, code, error, record, blockers: getVariationApprovalBlockers(record) };
}

/**
 * Apply an event to a record. Validates the structural transition AND the
 * event-specific requirements (an approval needs an approver; at-risk needs a
 * complete authorisation), then returns a NEW record with the relevant audit
 * fields stamped. The input record is never mutated.
 *
 * On any violation it returns `{ ok: false }` with the original record intact —
 * so the model can never silently release unapproved work.
 */
export function transitionVariationApproval(
  record: VariationApprovalRecord,
  event: VariationApprovalEvent,
): VariationApprovalTransitionResult {
  const target = EVENT_TARGET[event.type];

  if (!canTransitionVariationStatus(record.status, target)) {
    return fail(
      record,
      "invalid_transition",
      `Cannot move a ${record.status} variation to ${target}.`,
    );
  }

  // Event-specific guards.
  if (event.type === "approve" && (event.approvedBy == null || event.approvedBy.trim() === "")) {
    return fail(record, "missing_approver", "Approval requires the approving party.");
  }
  if (event.type === "start_work_at_risk" && !isWorkAtRiskAuthorisationComplete(event.authorisation)) {
    return fail(
      record,
      "missing_authorisation",
      "Work at risk requires a reason, who authorised it and when.",
    );
  }

  // Build the next record immutably, stamping the fields this event sets.
  const next: VariationApprovalRecord = { ...record, status: target, updatedAt: event.at };

  switch (event.type) {
    case "send_to_builder":
      next.sentToBuilderAt = event.at;
      if (event.quoteRef !== undefined) next.quoteRef = event.quoteRef;
      if (event.builderContactId !== undefined) next.builderContactId = event.builderContactId;
      break;
    case "approve":
      next.approvedBy = event.approvedBy;
      next.approvedByName = event.approvedByName ?? null;
      next.approvedAt = event.at;
      break;
    case "reject":
    case "cancel":
    case "dispute":
      if (event.note !== undefined) next.decisionNote = event.note;
      break;
    case "start_work_at_risk":
      next.workAtRisk = event.authorisation;
      break;
    case "complete":
      next.completedAt = event.at;
      break;
    case "claim":
      next.claimedAt = event.at;
      break;
    case "invoice":
      next.invoicedAt = event.at;
      if (event.invoiceRef !== undefined) next.invoiceRef = event.invoiceRef;
      break;
    case "expire":
    case "release_for_work":
      break;
  }

  return { ok: true, record: next, blockers: getVariationApprovalBlockers(next) };
}
