import type { z } from "zod";
import type {
  CreateVariationApprovalInputSchema,
  VariationApprovalRecordSchema,
  VariationApprovalStatusSchema,
  VariationKindSchema,
  WorkAtRiskAuthorisationSchema,
  WorkAtRiskReasonSchema,
} from "./schema";

/** Inferred types for the variations domain. Consumers import these, never the
 *  Zod schemas (house pattern, jobs/types.ts, dayworks/types.ts). */

export type VariationApprovalStatus = z.infer<typeof VariationApprovalStatusSchema>;
export type VariationKind = z.infer<typeof VariationKindSchema>;
export type WorkAtRiskReason = z.infer<typeof WorkAtRiskReasonSchema>;
export type WorkAtRiskAuthorisation = z.infer<typeof WorkAtRiskAuthorisationSchema>;
export type VariationApprovalRecord = z.infer<typeof VariationApprovalRecordSchema>;
export type CreateVariationApprovalInput = z.infer<typeof CreateVariationApprovalInputSchema>;

// ── Transition events (hand-written; these are intents, not stored data) ──────

/**
 * An event is an intent to move a record to its next status. Each variant
 * carries exactly the fields its transition needs — `approve` needs the
 * approver, `start_work_at_risk` needs the authorisation. `at` is the ISO
 * timestamp the event occurred (injected, never read from a clock here, so the
 * domain stays deterministic).
 */
export type VariationApprovalEvent =
  | { type: "send_to_builder"; at: string; quoteRef?: string | null; builderContactId?: string | null }
  | { type: "approve"; at: string; approvedBy: string; approvedByName?: string | null }
  | { type: "reject"; at: string; note?: string | null }
  | { type: "expire"; at: string }
  | { type: "release_for_work"; at: string }
  | { type: "start_work_at_risk"; at: string; authorisation: WorkAtRiskAuthorisation }
  | { type: "complete"; at: string }
  | { type: "cancel"; at: string; note?: string | null }
  | { type: "claim"; at: string }
  | { type: "invoice"; at: string; invoiceRef?: string | null }
  | { type: "dispute"; at: string; note?: string | null };

export type VariationApprovalEventType = VariationApprovalEvent["type"];

// ── Blockers ──────────────────────────────────────────────────────────────---

export type VariationApprovalBlockerCode =
  | "work_at_risk" // work proceeding without builder approval
  | "missing_authorisation" // at-risk record lacks required authorisation fields
  | "claim_risk_unapproved"; // work completed/claimed without recorded approval

/** A reason a variation is not cleanly releasable or claimable — surfaced for
 *  admin follow-up. `WORK AT RISK` is the headline of the first. */
export interface VariationApprovalBlocker {
  code: VariationApprovalBlockerCode;
  message: string;
}

// ── Transition result ─────────────────────────────────────────────────────---

export type VariationApprovalTransitionErrorCode =
  | "invalid_transition" // the from→to move is not allowed
  | "missing_approver" // approve event without an approver
  | "missing_authorisation"; // at-risk event without complete authorisation

/**
 * The result of attempting a transition. On success, `record` is a NEW record
 * (the input is never mutated) and `blockers` reflects the post-transition
 * state. On failure, `record` is the unchanged input and `error`/`code`
 * explain why.
 */
export type VariationApprovalTransitionResult =
  | { ok: true; record: VariationApprovalRecord; blockers: VariationApprovalBlocker[] }
  | {
      ok: false;
      code: VariationApprovalTransitionErrorCode;
      error: string;
      record: VariationApprovalRecord;
      blockers: VariationApprovalBlocker[];
    };
