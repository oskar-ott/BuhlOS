import type { z } from "zod";
import type {
  CreateVariationClaimInputSchema,
  VariationApprovalEvidenceSchema,
  VariationApprovalMethodSchema,
  VariationClaimLinksSchema,
  VariationClaimRecordSchema,
  VariationClaimStatusSchema,
} from "./claim-schema";

/** Inferred types for the variation CLAIM (#280). Consumers import these,
 *  never the Zod schemas (house pattern). */

export type VariationClaimStatus = z.infer<typeof VariationClaimStatusSchema>;
export type VariationApprovalMethod = z.infer<typeof VariationApprovalMethodSchema>;
export type VariationApprovalEvidence = z.infer<typeof VariationApprovalEvidenceSchema>;
export type VariationClaimLinks = z.infer<typeof VariationClaimLinksSchema>;
export type VariationClaimRecord = z.infer<typeof VariationClaimRecordSchema>;
export type CreateVariationClaimInput = z.infer<typeof CreateVariationClaimInputSchema>;

// ── Transition events ─────────────────────────────────────────────────────---

/**
 * An intent to move a claim to its next status. `approve` carries the approval
 * evidence the gate demands; `invoice` carries the manual invoice reference.
 * `at` is the injected ISO timestamp (the domain never reads a clock, so it
 * stays deterministic — the dayworks/exceptions convention).
 */
export type VariationClaimEvent =
  | { type: "quote"; at: string }
  | { type: "submit"; at: string }
  | { type: "approve"; at: string; approval: VariationApprovalEvidence }
  | { type: "reject"; at: string; note?: string | null }
  | { type: "invoice"; at: string; invoiceRef: string }
  // Re-work a rejected/submitted claim back to draft to amend scope/value.
  | { type: "revise"; at: string };

export type VariationClaimEventType = VariationClaimEvent["type"];

// ── Transition result ─────────────────────────────────────────────────────---

export type VariationClaimTransitionErrorCode =
  | "invalid_transition" // the from→to move is not allowed
  | "missing_approval_evidence" // approve event without complete evidence
  | "missing_invoice_ref"; // invoice event without a reference

/**
 * The result of attempting a transition. On success, `record` is a NEW record
 * (input never mutated). On failure, `record` is the unchanged input and
 * `error`/`code` explain why.
 */
export type VariationClaimTransitionResult =
  | { ok: true; record: VariationClaimRecord }
  | {
      ok: false;
      code: VariationClaimTransitionErrorCode;
      error: string;
      record: VariationClaimRecord;
    };

// ── Rollup ────────────────────────────────────────────────────────────────---

/**
 * The money rollup over a list of claims, all in integer cents. `openCents` is
 * value still in flight (draft/quoted/submitted) — what's at stake but not yet
 * settled. `approvedCents` is approved-but-not-yet-invoiced. `invoicedCents` is
 * billed. `lostCents` is the value of rejected claims — money the contractor
 * missed. Counts mirror the legacy KPI strip.
 */
export interface VariationClaimRollup {
  openCents: number;
  approvedCents: number;
  invoicedCents: number;
  lostCents: number;
  totalCents: number;
  counts: Record<VariationClaimStatus, number>;
  total: number;
}
