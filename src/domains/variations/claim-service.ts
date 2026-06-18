import { VARIATION_CLAIM_STATUSES } from "./claim-schema";
import type {
  CreateVariationClaimInput,
  VariationApprovalEvidence,
  VariationClaimEvent,
  VariationClaimEventType,
  VariationClaimRecord,
  VariationClaimRollup,
  VariationClaimStatus,
  VariationClaimTransitionErrorCode,
  VariationClaimTransitionResult,
} from "./claim-types";

/**
 * Pure variation-claim logic (#280): no I/O, no UI, no persistence. The one
 * rule that drives everything: **a claim cannot reach `approved` without
 * complete approval evidence** (who, when, method, reference). Every
 * time-dependent value (`at`) is injected so the domain stays deterministic
 * and unit-testable (the dayworks/exceptions convention).
 */

// ── Transition table ─────────────────────────────────────────────────────────

/**
 * Allowed status moves for the claim pipeline. `quoted` is optional (a draft
 * can go straight to submitted). A rejected claim can be revised back to draft
 * to amend and re-submit. `approved`/`invoiced` are forward-only.
 */
const TRANSITIONS: ReadonlyArray<readonly [VariationClaimStatus, VariationClaimStatus]> = [
  // Forward pipeline.
  ["draft", "quoted"],
  ["draft", "submitted"], // skip the quote step
  ["quoted", "submitted"],
  ["submitted", "approved"],
  ["submitted", "rejected"],
  ["approved", "invoiced"],

  // Re-work paths — pull a not-yet-decided or rejected claim back to draft.
  ["quoted", "draft"],
  ["submitted", "draft"],
  ["rejected", "draft"],
];

/** Whether a status change is structurally allowed. Pure shape check — does NOT
 *  verify the payload (use {@link transitionVariationClaim} for the full guard,
 *  including the approval-evidence gate). */
export function canTransitionClaimStatus(
  from: VariationClaimStatus,
  to: VariationClaimStatus,
): boolean {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function allowedClaimTransitions(): ReadonlyArray<
  readonly [VariationClaimStatus, VariationClaimStatus]
> {
  return TRANSITIONS;
}

/** Target status each event drives the claim toward. */
const EVENT_TARGET: Record<VariationClaimEventType, VariationClaimStatus> = {
  quote: "quoted",
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  invoice: "invoiced",
  revise: "draft",
};

// ── Approval-evidence gate ─────────────────────────────────────────────────--

/** Whether approval evidence carries the four required fields: approvedBy,
 *  approvedAt, method and a reference. The `approved` status is unreachable
 *  without this returning true. */
export function isApprovalEvidenceComplete(
  evidence: VariationApprovalEvidence | null | undefined,
): evidence is VariationApprovalEvidence {
  if (!evidence) return false;
  return (
    typeof evidence.approvedBy === "string" &&
    evidence.approvedBy.trim().length > 0 &&
    typeof evidence.approvedAt === "string" &&
    evidence.approvedAt.trim().length > 0 &&
    typeof evidence.reference === "string" &&
    evidence.reference.trim().length > 0 &&
    (evidence.method === "email" ||
      evidence.method === "verbal" ||
      evidence.method === "signed" ||
      evidence.method === "portal")
  );
}

// ── Ref minting ─────────────────────────────────────────────────────────────

const REF_PREFIX = "VO-";
const REF_PAD = 3;

/** Parse the numeric part of a "VO-007" ref; null if it isn't one. */
function parseRefNumber(ref: string | null | undefined): number | null {
  if (typeof ref !== "string") return null;
  const m = /^VO-(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/**
 * Mint the next sequential per-job ref from the existing claims. Collision-safe:
 * takes max(existing) + 1 rather than count + 1, so a deleted/soft-archived
 * claim can never re-mint a live ref. Zero-padded to "VO-001".
 */
export function nextClaimRef(existing: ReadonlyArray<{ ref?: string | null }>): string {
  let max = 0;
  for (const c of existing) {
    const n = parseRefNumber(c.ref ?? null);
    if (n != null && n > max) max = n;
  }
  const next = max + 1;
  return REF_PREFIX + String(next).padStart(REF_PAD, "0");
}

// ── Factory ───────────────────────────────────────────────────────────────---

/**
 * Build a fresh claim in `draft`. Pure — returns a record, persists nothing.
 * The caller (the API layer) owns id + ref minting and storage; here we stamp
 * the lifecycle defaults.
 */
export function createVariationClaim(
  input: CreateVariationClaimInput,
  at: string,
): VariationClaimRecord {
  return {
    id: input.id,
    jobId: input.jobId,
    ref: input.ref,
    scope: input.scope,
    description: input.description ?? null,
    status: "draft",
    valueCents: input.valueCents ?? null,
    links: {
      observationId: input.links?.observationId ?? null,
      evidenceIds: input.links?.evidenceIds ?? [],
      documentIds: input.links?.documentIds ?? [],
    },
    approval: null,
    decisionNote: null,
    invoiceRef: null,
    invoicedAt: null,
    createdAt: at,
    createdById: input.createdById ?? null,
    createdByName: input.createdByName ?? null,
    updatedAt: at,
    auditLogIds: [],
  };
}

// ── Transition ──────────────────────────────────────────────────────────────

function fail(
  record: VariationClaimRecord,
  code: VariationClaimTransitionErrorCode,
  error: string,
): VariationClaimTransitionResult {
  return { ok: false, code, error, record };
}

/**
 * Apply an event to a claim. Validates the structural transition AND the
 * event-specific requirements (an approval needs complete evidence; an invoice
 * needs a reference), then returns a NEW record with the relevant fields
 * stamped. The input record is never mutated. On any violation it returns
 * `{ ok: false }` with the original record intact — so a claim can never
 * silently reach `approved` without its evidence.
 */
export function transitionVariationClaim(
  record: VariationClaimRecord,
  event: VariationClaimEvent,
): VariationClaimTransitionResult {
  const target = EVENT_TARGET[event.type];

  if (!canTransitionClaimStatus(record.status, target)) {
    return fail(
      record,
      "invalid_transition",
      `Cannot move a ${record.status} claim to ${target}.`,
    );
  }

  // Event-specific guards.
  if (event.type === "approve" && !isApprovalEvidenceComplete(event.approval)) {
    return fail(
      record,
      "missing_approval_evidence",
      "Approval requires who approved it, when, the method and a reference.",
    );
  }
  if (event.type === "invoice") {
    const ref = typeof event.invoiceRef === "string" ? event.invoiceRef.trim() : "";
    if (!ref) {
      return fail(record, "missing_invoice_ref", "Marking invoiced requires an invoice reference.");
    }
  }

  const next: VariationClaimRecord = { ...record, status: target, updatedAt: event.at };

  switch (event.type) {
    case "approve":
      next.approval = event.approval;
      next.decisionNote = null;
      break;
    case "reject":
      next.decisionNote = event.note ?? null;
      break;
    case "invoice":
      next.invoiceRef = event.invoiceRef.trim();
      next.invoicedAt = event.at;
      break;
    case "revise":
      // Pulling back to draft clears the prior decision so a re-submit starts
      // clean — but never invents new state.
      next.decisionNote = null;
      break;
    case "quote":
    case "submit":
      break;
  }

  return { ok: true, record: next };
}

// ── Rollup ────────────────────────────────────────────────────────────────---

const OPEN_STATUSES: ReadonlySet<VariationClaimStatus> = new Set([
  "draft",
  "quoted",
  "submitted",
]);

function safeCents(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
}

function zeroCounts(): Record<VariationClaimStatus, number> {
  const counts = {} as Record<VariationClaimStatus, number>;
  for (const s of VARIATION_CLAIM_STATUSES) counts[s] = 0;
  return counts;
}

/**
 * Sum a list of claims into the money rollup. PURE — integer cents only, so the
 * total can never float-drift. This is the data foundation for the deferred
 * cross-job open-value rollup UI.
 *
 *   openCents      value in flight (draft/quoted/submitted) — at stake, unsettled
 *   approvedCents  approved but not yet invoiced
 *   invoicedCents  billed
 *   lostCents      rejected — money missed
 */
export function summariseVariationClaims(
  claims: ReadonlyArray<Pick<VariationClaimRecord, "status" | "valueCents">>,
): VariationClaimRollup {
  const counts = zeroCounts();
  let openCents = 0;
  let approvedCents = 0;
  let invoicedCents = 0;
  let lostCents = 0;

  for (const c of claims) {
    counts[c.status] = (counts[c.status] ?? 0) + 1;
    const cents = safeCents(c.valueCents);
    if (OPEN_STATUSES.has(c.status)) openCents += cents;
    else if (c.status === "approved") approvedCents += cents;
    else if (c.status === "invoiced") invoicedCents += cents;
    else if (c.status === "rejected") lostCents += cents;
  }

  return {
    openCents,
    approvedCents,
    invoicedCents,
    lostCents,
    totalCents: openCents + approvedCents + invoicedCents,
    counts,
    total: claims.length,
  };
}
