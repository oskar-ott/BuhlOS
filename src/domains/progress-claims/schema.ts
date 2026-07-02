import { z } from "zod";

/**
 * Progress claims (#372, Epic 7 — Quoting) — the monthly claim document built
 * from what's actually done, with proof attached, exportable ready to key into
 * Payapps.
 *
 * Relationship to the job-control spine (#364, src/domains/job-control):
 *   - The spine defined the claim LINE shape (`ClaimLine`, id prefix `cl_`) and
 *     said the claim HEADER + lifecycle is #372's. This module is that header.
 *   - Field names are COORDINATED with the spine: lines keep `cl_` ids, carry
 *     the same `boqLineRef` coordinate `{ quoteId, sectionId, lineId }` and the
 *     same `workPackageId` reference, so #341/#327 analytics can read either.
 *   - Storage is its own per-job blob `jobs/<jobId>/claims.json` (the issue's
 *     spine convention), NOT inside `jobs/<jobId>/job-control.json` — claims
 *     mutate on an office cadence and must never race the compile producer.
 *
 * Money convention: ALL money is INTEGER CENTS (`*Cents`, AUD ex GST) and all
 * percentages are INTEGER BASIS POINTS (`*PctBp`, 12.5% = 1250) — pure integer
 * math end to end, no floats stored (P7; the variations claim precedent).
 * Quote-line dollars are converted ONCE at seed time via the quoting domain's
 * own footing rule (see seed.ts).
 *
 * Number discipline (P7): the server derives `previously claimed` from prior
 * submitted claims and computes line values from the admin-entered percent —
 * it never invents a percent-complete. Task completion is shown ALONGSIDE as
 * a reference (suggestion discipline: computed reference, human decides).
 *
 * House pattern: `.passthrough()` everywhere so later children (retention,
 * Xero draft invoices #255, portal delivery) can add fields without breaking
 * older parsers.
 */

// ── Id conventions ───────────────────────────────────────────────────────────
// Lines reuse the spine's `cl_` prefix (ID_PREFIXES.claimLine); the claim
// header mints `pc_` (progress claim).

export const CLAIM_ID_PREFIXES = {
  claim: "pc_",
  claimLine: "cl_",
} as const;

// ── Lifecycle ────────────────────────────────────────────────────────────────
// draft → submitted → certified → paid. Submit FREEZES the claim (immutable
// lines + evidence manifest); certified/paid are manual statuses with
// references — no builder-platform integration in this issue. Amendments are a
// NEW claim (the to-date math self-corrects), never an edit of a submitted one.

export const PROGRESS_CLAIM_STATUSES = ["draft", "submitted", "certified", "paid"] as const;
export const ProgressClaimStatusSchema = z.enum(PROGRESS_CLAIM_STATUSES);

// ── References ───────────────────────────────────────────────────────────────

/** The spine's BOQ-line coordinate — a priced quote line in the quotes-v2 blob
 *  (imported workbook lines materialise into these; #365/#828). */
export const ClaimBoqLineRefSchema = z
  .object({
    quoteId: z.string(),
    sectionId: z.string(),
    lineId: z.string(),
  })
  .passthrough();

/** A REAL record cited as support for a claim line. Validated against the
 *  job's live records at link time — never a free-text claim of proof. */
export const CLAIM_EVIDENCE_KINDS = ["evidence", "itp"] as const;
export const ClaimEvidenceRefSchema = z
  .object({
    kind: z.enum(CLAIM_EVIDENCE_KINDS),
    /** EvidenceItem.id (jobs/<id>/data.json) or ITP instance id (jobs/<id>/itps.json). */
    id: z.string(),
    /** Human label snapshotted at link time (e.g. photo note, ITP name + status). */
    label: z.string().nullable().optional(),
  })
  .passthrough();

// ── Claim line ───────────────────────────────────────────────────────────────

/** Where a line's contract value comes from. `quote_line` values are locked to
 *  the priced source; `manual` values are office-entered (real data entry). */
export const CLAIM_LINE_VALUE_SOURCES = ["quote_line", "manual"] as const;

export const ProgressClaimLineSchema = z
  .object({
    id: z.string(), // cl_…
    /**
     * Stable identity ACROSS claims, so claim N+1 can derive "previously
     * claimed" for the same piece of scope:
     *   `boq:<quoteId>/<sectionId>/<lineId>` — seeded from a priced quote line
     *   `wp:<workPackageId>`                 — seeded from a work package
     *   `manual:<lineId>`                    — office-added line (carried forward)
     */
    sourceKey: z.string(),
    /** Payapps keying reference, e.g. "2.4" (section.line position). */
    lineRef: z.string(),
    /** Quote section / grouping label, when known. */
    sectionLabel: z.string().nullable().optional(),
    description: z.string(),
    /** Priced-line coordinate (spine shape) — null for package/manual lines. */
    boqLineRef: ClaimBoqLineRefSchema.nullable().optional(),
    /** Work package delivering this scope (#367) — enables the task-completion
     *  reference alongside the admin-entered percent. */
    workPackageId: z.string().nullable().optional(),
    /** Contract value ex GST, integer cents. Null = unpriced (honest absence —
     *  the line is flagged, its values stay null, it never counts as $0). */
    contractValueCents: z.number().int().nullable(),
    contractValueSource: z.enum(CLAIM_LINE_VALUE_SOURCES),
    /** Cumulative position BEFORE this claim — DERIVED from the latest prior
     *  non-draft claim carrying the same sourceKey (0 for claim 1). */
    previousPctBp: z.number().int(),
    previousValueCents: z.number().int(),
    /** ADMIN-ENTERED this-claim percent (basis points; may be negative for a
     *  credit — the to-date position can never go below zero). */
    thisPctBp: z.number().int(),
    /** Explicit, visible override allowing to-date past 100% (over-claim guard). */
    overClaimOverride: z.boolean().default(false),
    /** Real linked support. Empty = the line is visibly UNSUPPORTED (allowed,
     *  never hidden). */
    evidenceRefs: z.array(ClaimEvidenceRefSchema).default([]),
    // Server-computed from the fields above (math.ts) — stored so a submitted
    // claim is a self-contained, defensible snapshot. Null when unpriced.
    toDatePctBp: z.number().int(),
    toDateValueCents: z.number().int().nullable(),
    thisValueCents: z.number().int().nullable(),
    order: z.number().int().default(0),
  })
  .passthrough();

// ── Attachments (AC7) ────────────────────────────────────────────────────────
// Approved variations (#280) and signed daywork dockets attach as separate
// claim sections BY LINK — the money record stays in its own register, never
// duplicated. `valueCents` is a snapshot of the SOURCE record's real value
// (variation valueCents); dayworks are labour dockets with no priced value, so
// they attach as support with `valueCents: null` (never an invented number).

export const CLAIM_ATTACHMENT_KINDS = ["variation", "daywork"] as const;
export const ClaimAttachmentSchema = z
  .object({
    kind: z.enum(CLAIM_ATTACHMENT_KINDS),
    /** VariationClaimRecord.id (vc_…) or daywork docket id. */
    id: z.string(),
    /** The source register's human ref (e.g. "VO-003"). */
    ref: z.string().nullable().optional(),
    label: z.string(),
    /** Snapshot of the source record's value at attach/submit — integer cents,
     *  null when the source carries no priced value (dayworks). */
    valueCents: z.number().int().nullable(),
  })
  .passthrough();

// ── Claim totals (computed, stored on every server write) ────────────────────

export const ProgressClaimTotalsSchema = z
  .object({
    /** Sum of priced lines' contract values. */
    contractValueCents: z.number().int(),
    previousValueCents: z.number().int(),
    /** This claim's base-contract lines only. */
    thisLinesValueCents: z.number().int(),
    /** Attached variation sections (snapshot values). */
    attachmentsValueCents: z.number().int(),
    /** thisLinesValueCents + attachmentsValueCents. */
    thisClaimValueCents: z.number().int(),
    /** Cumulative base-contract position after this claim. */
    toDateValueCents: z.number().int(),
    /** Lines with no contract value (excluded from the money, never $0). */
    unpricedLineCount: z.number().int(),
  })
  .passthrough();

// ── Evidence manifest (frozen at submit) ─────────────────────────────────────

export const ClaimEvidenceManifestSchema = z
  .object({
    generatedAt: z.string(),
    entries: z.array(
      z
        .object({
          lineId: z.string(),
          sourceKey: z.string(),
          refs: z.array(ClaimEvidenceRefSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();

// ── Claim header ─────────────────────────────────────────────────────────────

export const CLAIM_SEED_SOURCES = ["quote", "packages", "blank"] as const;

export const ProgressClaimSchema = z
  .object({
    id: z.string(), // pc_…
    jobId: z.string(),
    /** Sequential per job: Claim 1, Claim 2 … */
    number: z.number().int(),
    /** Office label for the claim period, e.g. "July 2026". */
    periodLabel: z.string().nullable().optional(),
    status: ProgressClaimStatusSchema,
    /** Where the lines were seeded from (provenance, not behaviour). */
    seedSource: z.enum(CLAIM_SEED_SOURCES),
    /** The linked quote the lines draw against, when seeded from one. */
    quoteId: z.string().nullable().optional(),
    /** The prior claim this one's `previously claimed` derives from — later
     *  claims reference prior ones so the cumulative chain is always walkable. */
    previousClaimId: z.string().nullable().optional(),
    lines: z.array(ProgressClaimLineSchema).default([]),
    attachments: z.array(ClaimAttachmentSchema).default([]),
    totals: ProgressClaimTotalsSchema,
    /** Frozen at submit; null while draft. */
    evidenceManifest: ClaimEvidenceManifestSchema.nullable().default(null),
    createdAt: z.string(),
    createdBy: z.string().nullable().optional(),
    submittedAt: z.string().nullable().optional(),
    submittedBy: z.string().nullable().optional(),
    /** Manual certification (what the builder certified) — the variance vs
     *  claimed is computed, never stored as opinion. */
    certifiedValueCents: z.number().int().nullable().optional(),
    certifiedRef: z.string().nullable().optional(),
    certifiedAt: z.string().nullable().optional(),
    /** Manual payment reference. */
    paidRef: z.string().nullable().optional(),
    paidAt: z.string().nullable().optional(),
  })
  .passthrough();

// ── Per-job doc (jobs/<jobId>/claims.json) ───────────────────────────────────

export const ProgressClaimsDocSchema = z
  .object({
    jobId: z.string(),
    claims: z.array(ProgressClaimSchema).default([]),
    /** Content-hash revision — the stale-write precondition (the job-control
     *  revision-guard pattern). */
    revision: z.string().optional(),
  })
  .passthrough();
