import { z } from "zod";

/**
 * Variation / daywork APPROVAL workflow — the commercial lifecycle of a
 * builder-requested extra or change, from request through builder approval,
 * release to the field, completion, claim and invoice. Grounded in the real
 * site loop:
 *
 *   builder requests extra/change
 *     → BuhlOS raises a variation/daywork quote/request   (draft → sent_to_builder)
 *     → builder approves                                   (approved)
 *     → work is released to the crew                       (released_for_work)
 *     → worker completes it                                (completed)
 *     → evidence/hours/materials are attached              (link only, elsewhere)
 *     → admin claims / invoices it                         (claimed → invoiced)
 *
 * The defining rule: **work is not released without a recorded builder
 * approval.** When work starts anyway — verbal go-ahead, emergency, programme
 * pressure — that is the explicit `work_at_risk` exception, and it demands a
 * named authorisation. It is never the happy path; it always raises a blocker.
 *
 * This module is the DOMAIN FOUNDATION ONLY: schema + types + pure transition
 * logic. There is NO UI, NO API, NO persistence and NO Phil wiring here. The
 * admin request flow, builder-approval tracking, release-to-Phil, evidence
 * completion and claim/invoice surfaces are follow-on slices.
 *
 * Sits beside the daywork register (`src/domains/dayworks/`, #370), which owns
 * the per-job docket + signature; this domain owns the *approval state* a
 * variation or daywork passes through. House pattern: `.passthrough()` so later
 * fields never break older parsers; types are inferred (consumers import types,
 * never the Zod schemas).
 */

// ── Status ───────────────────────────────────────────────────────────────────

export const VARIATION_APPROVAL_STATUSES = [
  "draft", // raised internally, not yet sent to the builder
  "sent_to_builder", // quote/request issued, awaiting the builder's decision
  "approved", // builder approved — work may now be released
  "released_for_work", // released to the crew (only reachable from approved)
  "work_at_risk", // EXCEPTION: work started without builder approval
  "completed", // work finished on the ground
  "claimed", // included in a progress claim
  "invoiced", // invoiced to the builder
  "rejected", // builder declined
  "expired", // offer lapsed with no decision
  "cancelled", // withdrawn before work
  "disputed", // contested after completion/claim
] as const;

export const VariationApprovalStatusSchema = z.enum(VARIATION_APPROVAL_STATUSES);
export type VariationApprovalStatus = z.infer<typeof VariationApprovalStatusSchema>;

// ── Work-at-risk authorisation ────────────────────────────────────────────────

/**
 * Source of instruction for at-risk work, "if known". This is the categorised
 * *why we started without approval*, distinct from the free-text `reason`.
 */
export const WORK_AT_RISK_REASONS = [
  "builder_verbal_instruction",
  "boss_internal_approval",
  "emergency_safety",
  "programme_delay_risk",
  "other",
] as const;

export const WorkAtRiskReasonSchema = z.enum(WORK_AT_RISK_REASONS);
export type WorkAtRiskReason = z.infer<typeof WorkAtRiskReasonSchema>;

/**
 * The named authorisation that the at-risk exception demands. `reason`,
 * `authorisedBy` and `authorisedAt` are REQUIRED — at-risk work is never
 * anonymous. `source` is the optional categorisation.
 */
export const WorkAtRiskAuthorisationSchema = z
  .object({
    /** Free-text justification — what was instructed and by whom on the ground. */
    reason: z.string(),
    /** Categorised source of instruction, if known. */
    source: WorkAtRiskReasonSchema.nullable().optional(),
    /** The internal person who authorised proceeding at risk (user id). */
    authorisedBy: z.string(),
    /** Display name of the authoriser. */
    authorisedByName: z.string().nullable().optional(),
    /** ISO timestamp the at-risk call was made. */
    authorisedAt: z.string(),
  })
  .passthrough();

// ── Record ─────────────────────────────────────────────────────────────────--

export const VARIATION_KINDS = ["variation", "daywork"] as const;
export const VariationKindSchema = z.enum(VARIATION_KINDS);
export type VariationKind = z.infer<typeof VariationKindSchema>;

/**
 * The approval record for one variation or daywork request. Carries the audit
 * trail the commercial loop needs: who requested, the builder contact, the
 * approval stamps, the quote reference, and the at-risk authorisation when it
 * applies. Money calculation lives elsewhere — this is the *approval state*.
 */
export const VariationApprovalRecordSchema = z
  .object({
    id: z.string(), // var_…
    jobId: z.string(),
    /** Cross-reference to the variation/daywork entity this approval governs. */
    variationId: z.string().nullable().optional(),
    kind: VariationKindSchema.default("variation"),
    /** Short title a builder and an admin both read. */
    title: z.string(),
    description: z.string().nullable().optional(),
    status: VariationApprovalStatusSchema,

    // Request / origination.
    requestedBy: z.string(), // internal user id who raised it
    requestedByName: z.string().nullable().optional(),
    /** The builder-side contact the request is sent to, if known. */
    builderContactId: z.string().nullable().optional(),
    /** Quote/request reference, if one has been minted. */
    quoteRef: z.string().nullable().optional(),
    sentToBuilderAt: z.string().nullable().optional(),

    // Builder decision.
    approvedBy: z.string().nullable().optional(),
    approvedByName: z.string().nullable().optional(),
    approvedAt: z.string().nullable().optional(),
    /** Free-text outcome note for reject / cancel / dispute. */
    decisionNote: z.string().nullable().optional(),

    // Exception.
    workAtRisk: WorkAtRiskAuthorisationSchema.nullable().default(null),

    // Downstream stamps (link only — evidence/hours/materials live elsewhere).
    completedAt: z.string().nullable().optional(),
    claimedAt: z.string().nullable().optional(),
    invoiceRef: z.string().nullable().optional(),
    invoicedAt: z.string().nullable().optional(),

    // Audit.
    createdAt: z.string(),
    updatedAt: z.string().nullable().optional(),
    auditLogIds: z.array(z.string()).default([]),
  })
  .passthrough();

// ── Create input ───────────────────────────────────────────────────────────--

export const VARIATION_APPROVAL_LIMITS = {
  maxTitle: 200,
  maxDescription: 4000,
  maxReason: 2000,
} as const;

/**
 * The shape a caller supplies to raise a fresh request. The factory stamps
 * `status: "draft"`, `createdAt`/`updatedAt` and the empty audit array.
 */
export const CreateVariationApprovalInputSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  variationId: z.string().nullable().optional(),
  kind: VariationKindSchema.optional(),
  title: z.string().trim().min(1).max(VARIATION_APPROVAL_LIMITS.maxTitle),
  description: z.string().max(VARIATION_APPROVAL_LIMITS.maxDescription).nullable().optional(),
  requestedBy: z.string().trim().min(1),
  requestedByName: z.string().nullable().optional(),
  builderContactId: z.string().nullable().optional(),
  quoteRef: z.string().nullable().optional(),
});
