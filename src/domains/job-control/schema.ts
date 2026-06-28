import { z } from "zod";

/**
 * Job-control data spine (#364) — the typed links that turn BuhlOS's
 * disconnected records into one chain:
 *
 *   scope clause → BOQ line → work package → task → evidence → claim → closeout
 *
 * Grounded in the 100 Arthur St reference job. See
 * `docs/architecture/job-control-spine.md` for the entity model, the
 * mapping table of what already exists vs what's new, the per-job blob
 * homes, the future Supabase table sketches, and a worked clause→claim
 * trace. This module is the SHARED TYPE layer that doc describes; it adds
 * NO UI and NO API.
 *
 * Design rules (enforced by review on the sibling issues #366/#367/#372/#374):
 *   - Existing domains are REFERENCED by id, never duplicated. Scope clauses
 *     stay `Job.scopeOfWork[]` (#200); BOQ lines stay quote lines in the
 *     quotes-v2 blob; tasks stay area/stage/task in jobs.json with state in
 *     `dwellings` (canonical progress.ts #198); evidence/observations/
 *     documents/ITP/material-requests keep their own stores.
 *   - A WorkPackage is a PROVENANCE OVERLAY on existing areas/stages/tasks —
 *     explicitly NOT a parallel task system. It groups task coordinates and
 *     ties them to scope + price + claim; it never carries task state.
 *   - Numbers are never invented. A ClaimLine carries the amount the office
 *     entered; helpers SUM claim lines, they never derive a claim from work.
 *
 * House pattern: `.passthrough()` everywhere so the calculator/claims/
 * closeout children (#372/#374/#193/#214) can add fields without breaking
 * older parsers (mirrors jobs/schema.ts and quoting/schema.ts).
 */

// ── Id conventions ─────────────────────────────────────────────────────────
// New spine entities carry a typed prefix so they're greppable and never
// collide across stores. Referenced entities keep their own ids (scope
// clauses are `sw_…` per #200; quote lines, evidence, documents, ITP
// instances use their domain's existing ids).

export const ID_PREFIXES = {
  workPackage: "wp_",
  claimLine: "cl_",
  closeoutRequirement: "cr_",
  evidenceLink: "el_",
  proofReview: "pr_",
} as const;

// ── Stage (shared with the jobs domain) ──────────────────────────────────────
// jobs/types.ts exposes `JobStage` as a literal union with no Zod schema, so
// we mint the matching enum here. types.ts adds a compile-time assertion that
// this stays aligned with the jobs domain — do not edit one without the other.

export const JOB_CONTROL_STAGES = ["roughIn", "fitOff"] as const;
export const JobControlStageSchema = z.enum(JOB_CONTROL_STAGES);

// ── References into existing domains ─────────────────────────────────────────

/**
 * A coordinate into the existing area/stage/task structure (jobs domain).
 * Mirrors the `{ areaId, stage, taskId }` shape evidence and observations
 * already use to point at a task. The spine NEVER owns task state — completion
 * lives in `dwellings[areaId][stage].tasks[taskId]` (progress.ts #198).
 */
export const TaskRefSchema = z
  .object({
    areaId: z.string(),
    stage: JobControlStageSchema,
    taskId: z.string(),
  })
  .passthrough();

/**
 * A reference to a priced quote line — the BOQ line of the spine. A quote
 * line lives nested as `Quote.sections[].lines[]` in the quotes-v2 blob, so
 * the reference is the (quoteId, sectionId, lineId) coordinate. There is no
 * standalone BOQ entity today; #365 (workbook import) may promote external
 * BOQ rows into quote lines, at which point this reference still holds.
 */
export const BoqLineRefSchema = z
  .object({
    quoteId: z.string(),
    sectionId: z.string(),
    lineId: z.string(),
  })
  .passthrough();

// ── Work-package provenance (#367 compile output, #368 field render) ─────────
// The office-compiled context the field needs on a task. Populated by the
// compile child (#367) from the reconciliation; read by Phil scope-context
// (#368). All values are real compiled values or an honest absence — never
// invented (P7).

/** What proof the office wants for a piece of work. */
export const REQUIRED_EVIDENCE_KINDS = ["photo", "test_result", "as_built", "certificate"] as const;
export const RequiredEvidenceKindSchema = z.enum(REQUIRED_EVIDENCE_KINDS);
export const RequiredEvidenceSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: RequiredEvidenceKindSchema,
    note: z.string().nullable().optional(),
    /**
     * OPTIONAL per-task-instance authoring scope (#506 keystone / per-task proof
     * authoring). When present, this requirement applies to ONLY that task
     * instance `(areaId, stage, taskId)` — the canonical identity in tuple/bridge
     * form (#480/#483). When ABSENT — every requirement today — it is
     * PACKAGE-LEVEL and applies to every task the package delivers, preserving the
     * current area/package-granular behaviour. Additive + back-compatible; the
     * stored shape stays the tuple (no storage migration). The consumer
     * (`requiredEvidenceForTask`) filters by it; the compile step does not author
     * it yet (the admin authoring UI is the next slice).
     */
    taskRef: TaskRefSchema.nullable().optional(),
  })
  .passthrough();

/** The three site traps a clause classification can warn the field about. */
export const WARNING_KINDS = ["by_others", "reuse_existing", "variation_trigger"] as const;
export const WarningKindSchema = z.enum(WARNING_KINDS);
export const WorkPackageWarningSchema = z
  .object({
    id: z.string(),
    kind: WarningKindSchema,
    text: z.string(),
    /** The clause that raised it → `Job.scopeOfWork[].id`. */
    scopeClauseId: z.string().nullable().optional(),
  })
  .passthrough();

/** Id-only reference into the existing documents/plans register (no bytes). */
export const GoverningDocRefSchema = z
  .object({
    documentId: z.string(), // → Document.id
    label: z.string().nullable().optional(),
  })
  .passthrough();

export const WorkPackageMaterialSchema = z
  .object({
    label: z.string(),
    qty: z.number().nullable().optional(),
    unit: z.string().nullable().optional(),
    boqLineRef: BoqLineRefSchema.nullable().optional(),
  })
  .passthrough();

// ── New entity: WorkPackage ──────────────────────────────────────────────────

/**
 * A unit of work the job is managed and claimed by. It ties agreed scope to
 * the priced lines that fund it and to the existing tasks that deliver it.
 * Provenance only — it references tasks, it does not replace them, and it
 * never carries task state (that stays in `dwellings`, progress.ts #198).
 */
export const WorkPackageSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    /** Human label, e.g. "East Gym — ZIP tap & dedicated 20A circuit". */
    title: z.string(),
    /** Agreed scope this package delivers → `Job.scopeOfWork[].id` (#200). */
    scopeClauseIds: z.array(z.string()).default([]),
    /** Priced lines that fund this package → quote lines (quotes-v2 blob). */
    boqLineRefs: z.array(BoqLineRefSchema).default([]),
    /** Existing tasks that deliver it → area/stage/task coordinates. */
    taskRefs: z.array(TaskRefSchema).default([]),
    // Provenance the field sees (#367 compiles, #368 renders). Optional so
    // older / un-compiled packages parse unchanged (zero regression).
    scopeNote: z.string().nullable().optional(),
    governingDocRefs: z.array(GoverningDocRefSchema).optional(),
    materials: z.array(WorkPackageMaterialSchema).optional(),
    requiredEvidence: z.array(RequiredEvidenceSchema).optional(),
    warnings: z.array(WorkPackageWarningSchema).optional(),
    order: z.number().default(0),
    notes: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
  })
  .passthrough();

// ── New entity: ClaimLine ────────────────────────────────────────────────────
// Today the job carries only the hand-set scalar `claimedToDate` (api/jobs.js).
// A ClaimLine is one line of a progress claim. The claim HEADER (the monthly
// claim document, its submission/approval lifecycle and the Payapps-ready
// export) is #372 — this defines the LINE shape #372 builds on.

export const CLAIM_LINE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "paid",
  "rejected",
] as const;
export const ClaimLineStatusSchema = z.enum(CLAIM_LINE_STATUSES);

export const ClaimLineSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    /** Free-text claim grouping until #372 mints a claim header, e.g. "Claim 3". */
    claimRef: z.string().nullable().optional(),
    periodLabel: z.string().nullable().optional(),
    description: z.string(),
    /** What work this line claims → `wp_…`. */
    workPackageId: z.string().nullable().optional(),
    /** The priced lines this claim draws against (subset of the package's). */
    boqLineRefs: z.array(BoqLineRefSchema).default([]),
    /** Amount claimed this line, ex GST. The office's number — never derived. */
    claimedAmount: z.number(),
    status: ClaimLineStatusSchema,
    order: z.number().default(0),
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
  })
  .passthrough();

// ── New entity: EvidenceLink ─────────────────────────────────────────────────
// Evidence and observations already link to job/area/task. The NEW link the
// spine adds is proof → spine node: an evidence item (or a variation/defect
// observation) cited as support for a work package or a claim line. This is
// what makes claim support and closeout proof a lookup instead of archaeology.

export const EVIDENCE_LINK_ROLES = [
  "progress",
  "closeout",
  "variation",
  "defect_rectification",
] as const;
export const EvidenceLinkRoleSchema = z.enum(EVIDENCE_LINK_ROLES);

export const EvidenceLinkSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    /** Proof side — at least one required (validated in spine.ts). */
    evidenceId: z.string().nullable().optional(), // → EvidenceItem.id
    observationId: z.string().nullable().optional(), // → ObservationItem.id
    /** Spine-node side — at least one required (validated in spine.ts). */
    workPackageId: z.string().nullable().optional(), // → wp_…
    claimLineId: z.string().nullable().optional(), // → cl_…
    closeoutRequirementId: z.string().nullable().optional(), // → cr_…
    /** The specific required-evidence item this link satisfies (#368) →
     *  `WorkPackage.requiredEvidence[].id`. A requirement is "met" ONLY when a
     *  link names it — never derived from a photo count. */
    requiredEvidenceId: z.string().nullable().optional(),
    /**
     * OPTIONAL per-task-instance scope (#502). When present, this link satisfies
     * the requirement for ONLY this task instance `(areaId, stage, taskId)` — the
     * canonical task identity expressed in bridge/tuple form (#480/#483; resolve
     * to `ct_…` via the #501 bridge). When ABSENT — every link today — the link is
     * PACKAGE-LEVEL and satisfies the requirement for every task the package
     * delivers, preserving the current area/package-granular behaviour. Additive
     * and back-compatible: the stored shape stays the tuple (no storage
     * migration), and existing links/readers are unaffected. The task-aware met
     * rule (`isRequiredEvidenceMetForTask`) reads this; the package-level
     * `isRequiredEvidenceMet` ignores it.
     */
    taskRef: TaskRefSchema.nullable().optional(),
    role: EvidenceLinkRoleSchema,
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
  })
  .passthrough();

// ── New entity: CloseoutRequirement ──────────────────────────────────────────
// An obligation that must be discharged to close the job (as-builts issued,
// every ZIP circuit tested + ITP signed, O&M manual delivered…). None exists
// today. The closeout MATRIX that GENERATES these from job obligations is
// #374; this defines the requirement shape #374 produces.

export const CLOSEOUT_REQUIREMENT_KINDS = [
  "document",
  "itp",
  "evidence",
  "certificate",
  "other",
] as const;
export const CloseoutRequirementKindSchema = z.enum(CLOSEOUT_REQUIREMENT_KINDS);

export const CLOSEOUT_REQUIREMENT_STATUSES = [
  "outstanding",
  "in_progress",
  "satisfied",
  "waived",
] as const;
export const CloseoutRequirementStatusSchema = z.enum(CLOSEOUT_REQUIREMENT_STATUSES);

// ── Closeout fulfilment link (#374) ──────────────────────────────────────────
// A TYPED reference from a closeout requirement to the real record that
// discharges it. The legacy single-id fields below (`documentId` / `itpInstanceId`
// / `evidenceLinkId`) are kept for back-compat; #374's matrix uses this richer
// link array so one requirement can resolve against multiple records and so the
// read-shaper can re-check each against the live id sets (a deleted record
// reverts the requirement — never trust a stored "satisfied" flag alone).

export const CLOSEOUT_FULFILMENT_TYPES = [
  "certificate",
  "document",
  "evidence",
  "itp-instance",
  "as-built",
] as const;
export const CloseoutFulfilmentTypeSchema = z.enum(CLOSEOUT_FULFILMENT_TYPES);

export const CloseoutFulfilmentLinkSchema = z
  .object({
    type: CloseoutFulfilmentTypeSchema,
    /** The real record id this link points at (Certificate.id, Document.id,
     *  EvidenceItem.id, ITPInstance.id; an as-built is a Document). The
     *  read-shaper re-checks it against the live id set so a deleted record
     *  shows the requirement reverted, never orphaned-green. */
    id: z.string(),
  })
  .passthrough();

/** Where in the job a closeout requirement applies. `job_wide` is the default
 *  (a job-level obligation like the certificate of electrical safety); an
 *  `{ areaId }` scope narrows it to one area (e.g. per-board as-builts). */
export const CloseoutAreaScopeSchema = z.union([
  z.literal("job_wide"),
  z.object({ areaId: z.string() }).passthrough(),
]);

/** Where a requirement came from: `clause` = seeded from a recon closeout
 *  clause; `manual` = a default electrical obligation (or an admin add). */
export const CLOSEOUT_REQUIREMENT_SOURCES = ["clause", "manual"] as const;
export const CloseoutRequirementSourceSchema = z.enum(CLOSEOUT_REQUIREMENT_SOURCES);

export const CloseoutRequirementSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    title: z.string(),
    kind: CloseoutRequirementKindSchema,
    /** Scope obligations this requirement discharges → `Job.scopeOfWork[].id`. */
    scopeClauseIds: z.array(z.string()).default([]),
    workPackageId: z.string().nullable().optional(),
    // Satisfied-by references — point at the artefact that discharges it.
    documentId: z.string().nullable().optional(), // → Document.id
    itpInstanceId: z.string().nullable().optional(), // → ITPInstance.id
    evidenceLinkId: z.string().nullable().optional(), // → el_…
    /** #374: typed fulfilment links — the real records cited as discharging this
     *  requirement. A requirement is `satisfied` ONLY when ≥1 link RESOLVES and
     *  an admin has CONFIRMED (see confirmedAt/By); a dangling link reverts it. */
    fulfilmentLinks: z.array(CloseoutFulfilmentLinkSchema).default([]),
    /** #374: where the requirement applies (job-wide default, or one area). */
    areaScope: CloseoutAreaScopeSchema.default("job_wide"),
    /** #374: provenance — seeded from a recon clause or a manual/default add. */
    source: CloseoutRequirementSourceSchema.default("manual"),
    /** #374: admin confirmation — the second half of "satisfied". Set on confirm,
     *  cleared on un-confirm / a reverting change. A resolving link without a
     *  confirmation is `in_progress`, never `satisfied`. */
    confirmedAt: z.string().nullable().optional(),
    confirmedBy: z.string().nullable().optional(),
    status: CloseoutRequirementStatusSchema,
    order: z.number().default(0),
    createdAt: z.string().optional(),
    createdBy: z.string().optional(),
  })
  .passthrough();

// ── Container blob ───────────────────────────────────────────────────────────
// Per-job home: `jobs/<jobId>/job-control.json`. Holds ONLY the new entities
// and links. Scope clauses stay on jobs.json (#200); BOQ lines stay in the
// quotes-v2 blob; tasks/evidence/observations/documents/ITP keep their stores.

// ── New entity: ProofReview (#503 task-instance proof review/approval) ─────────
// The submit → approve/reject lifecycle for a TASK INSTANCE's required proof.
// Keyed by the task coordinate (canonical identity in tuple/bridge form, #480/#483)
// — NOT by work package — so review granularity matches the per-task proof model
// (#502). Submit is server-verified against captured proof (never a client gate);
// submit never approves; approve/reject are a separate admin action.

export const PROOF_REVIEW_STATUSES = ["submitted", "approved", "rejected"] as const;
export const ProofReviewStatusSchema = z.enum(PROOF_REVIEW_STATUSES);

export const ProofReviewSchema = z
  .object({
    id: z.string(), // pr_…
    jobId: z.string(),
    /** The task instance under review (areaId, stage, taskId). */
    taskRef: TaskRefSchema,
    status: ProofReviewStatusSchema,
    submittedBy: z.string().nullable().optional(),
    submittedAt: z.string().optional(),
    /** Set when an admin approves/rejects (separate from submit). */
    reviewedBy: z.string().nullable().optional(),
    reviewedAt: z.string().nullable().optional(),
    /** Required on reject — why it was sent back. Cleared on resubmit. */
    reason: z.string().nullable().optional(),
  })
  .passthrough();

export const JobControlSpineSchema = z
  .object({
    jobId: z.string(),
    workPackages: z.array(WorkPackageSchema).default([]),
    claimLines: z.array(ClaimLineSchema).default([]),
    closeoutRequirements: z.array(CloseoutRequirementSchema).default([]),
    evidenceLinks: z.array(EvidenceLinkSchema).default([]),
    /** Per-task proof review/approval records (#503). */
    proofReviews: z.array(ProofReviewSchema).default([]),
    updatedAt: z.string().optional(),
  })
  .passthrough();
