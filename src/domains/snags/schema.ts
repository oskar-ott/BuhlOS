import { z } from "zod";

/**
 * Zod schemas for the snags / defects domain (Phase D.5).
 *
 * A "snag" is any issue on a job that requires action: bad work,
 * missing materials, unsafe condition, damage, builder rework
 * request — anything the field/admin team needs to track until it's
 * resolved and verified.
 *
 * Why the V2 namespace? The legacy `snags: []` array on
 * jobs/<jobId>/data.json has a different shape:
 *   { id, dwelling, desc, priority: 'High'|'Medium'|'Low',
 *     status: 'Open'|'Closed', ... }
 * Reused by api/snag-quick-raise.js, api/snags-all.js, api/snags-mine.js
 * — all of which Phase D.5 leaves untouched. The new loop writes to
 * `snagsV2: []` on the same data.json so the two coexist with zero
 * legacy-route risk. Migration is a later phase if it ever happens.
 *
 * Wire shape mirrors what api/snags.js writes:
 *   - status lifecycle: open → in_progress → resolved → verified → closed
 *   - rejected branch from open / in_progress / resolved (reason required)
 *   - priority enum: low / normal / high / urgent
 *   - optional attachment to area / stage / task
 *   - optional evidenceIds linking to existing EvidenceItem rows on the job
 *
 * Schemas use .passthrough() so future fields (linked plan refs, ITP
 * pointers, materials links) don't break parsing for clients compiled
 * against an older schema. Same convention as evidence + jobs +
 * timesheets schemas.
 *
 * Cross-ref:
 *   docs/rebuild-audit/phase-d5-runbook.md
 *   docs/rebuild-audit/phase-d55-snags-runbook.md (D.5 runbook)
 *   src/domains/evidence/schema.ts — precedent
 */

export const SNAG_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "verified",
  "closed",
  "rejected",
] as const;
export const SnagStatusSchema = z.enum(SNAG_STATUSES);

export const SNAG_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const SnagPrioritySchema = z.enum(SNAG_PRIORITIES);

export const SNAG_SOURCES = ["phil", "admin", "system"] as const;
export const SnagSourceSchema = z.enum(SNAG_SOURCES);

export const SNAG_STAGES = ["roughIn", "fitOff"] as const;
export const SnagStageSchema = z.enum(SNAG_STAGES);

/** Field length caps. The title goes in row/list views and admin
 *  drawer headers, so it stays short. The description is the body
 *  copy the worker types on a phone — same 1000 cap as the legacy
 *  snag desc so the legacy + new API behave consistently. */
export const SNAG_TITLE_MAX = 120;
export const SNAG_DESCRIPTION_MAX = 1000;
export const SNAG_REJECTION_REASON_MAX = 500;

/** Cap how many evidence rows one snag can link. 10 covers the
 *  worst-case "photo set" without letting a runaway client point at
 *  every evidence row on the job. */
export const SNAG_EVIDENCE_LINK_MAX = 10;

/**
 * Full SnagItem as persisted on jobs/<jobId>/data.json snagsV2[] and
 * as returned by GET / POST /api/snags.
 *
 * Server fills: id, createdBy{Id,Name,Role}, createdAt, updatedAt,
 * status (defaults to 'open' on create), source. Lifecycle timestamps
 * (acknowledgedAt, resolvedAt, verifiedAt, closedAt, rejectedAt) land
 * as the status flips; the matching *ById field stamps the actor.
 *
 * Refinements:
 *   - status='rejected' requires non-empty rejectionReason
 */
export const SnagItemSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),

    // Body. title is required + short for list views; description is
    // the longer worker-typed body. summary is an optional rolled-up
    // line for the admin queue (server may pre-render on create).
    title: z.string(),
    description: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),

    // Context. Every field is independent — a snag can be raised
    // against the whole job, an area, an area+stage, or a specific
    // task. stageName / areaName / taskName are denormalised display
    // labels the server stamps on create so the queue doesn't need
    // a re-resolve every read.
    stage: SnagStageSchema.nullable().optional(),
    areaId: z.string().nullable().optional(),
    areaName: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    taskName: z.string().nullable().optional(),

    // Links to existing evidence rows on the same job. Server
    // validates each ID resolves to a real evidence row on this
    // jobId on create. Always an array (possibly empty) — never null
    // or absent on a server-returned snag.
    evidenceIds: z.array(z.string()),

    // Lifecycle.
    status: SnagStatusSchema,
    priority: SnagPrioritySchema,
    source: SnagSourceSchema,

    // Actor stamps. Worker creates → admin verifies/closes.
    createdById: z.string(),
    createdByName: z.string(),
    createdByRole: z.string().nullable().optional(),
    assignedToId: z.string().nullable().optional(),
    assignedToName: z.string().nullable().optional(),

    // Per-transition stamps. All nullable; flip as the lifecycle
    // advances. Append-only — we don't reset on reverse transitions
    // (a rejected snag that's re-opened still shows when it was
    // first resolved, for instance).
    acknowledgedAt: z.string().nullable().optional(),
    acknowledgedById: z.string().nullable().optional(),
    acknowledgedByName: z.string().nullable().optional(),
    resolvedAt: z.string().nullable().optional(),
    resolvedById: z.string().nullable().optional(),
    resolvedByName: z.string().nullable().optional(),
    verifiedAt: z.string().nullable().optional(),
    verifiedById: z.string().nullable().optional(),
    verifiedByName: z.string().nullable().optional(),
    closedAt: z.string().nullable().optional(),
    closedById: z.string().nullable().optional(),
    closedByName: z.string().nullable().optional(),
    rejectedAt: z.string().nullable().optional(),
    rejectedById: z.string().nullable().optional(),
    rejectedByName: z.string().nullable().optional(),
    rejectionReason: z.string().nullable().optional(),

    auditLogIds: z.array(z.string()),

    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (data.status === "rejected") {
      const reason = (data.rejectionReason ?? "").trim();
      if (!reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rejectionReason is required when status=rejected",
          path: ["rejectionReason"],
        });
      }
    }
  });

/**
 * Payload the client POSTs to /api/snags?jobId=<id> to create.
 *
 * Validation rules (mirrored server-side in api/snags.js):
 *   - title required, trimmed, ≤ SNAG_TITLE_MAX
 *   - description optional, ≤ SNAG_DESCRIPTION_MAX
 *   - priority enum (default: normal)
 *   - if taskId is present → stage is required
 *   - evidenceIds array ≤ SNAG_EVIDENCE_LINK_MAX, each ID must
 *     resolve to a real evidence row on this job (server enforces)
 *
 * Client cannot set status on create — server always writes 'open'.
 */
export const CreateSnagPayloadSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "title is required")
      .max(SNAG_TITLE_MAX, `Title must be ${SNAG_TITLE_MAX} characters or fewer`),
    description: z
      .string()
      .max(
        SNAG_DESCRIPTION_MAX,
        `Description must be ${SNAG_DESCRIPTION_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
    /** Optional on the wire; server defaults to 'normal' when absent. */
    priority: SnagPrioritySchema.optional(),

    stage: SnagStageSchema.nullable().optional(),
    areaId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),

    evidenceIds: z
      .array(z.string())
      .max(
        SNAG_EVIDENCE_LINK_MAX,
        `evidenceIds may not exceed ${SNAG_EVIDENCE_LINK_MAX} links`
      )
      .optional(),

    assignedToId: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.taskId && !data.stage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stage is required when taskId is provided",
        path: ["stage"],
      });
    }
  });

/**
 * Payload the client POSTs to /api/snags?jobId=<id>&action=transition
 * to move a snag to a new status.
 *
 *   - nextStatus must be in SNAG_STATUSES
 *   - reason required when nextStatus='rejected'
 *   - reason optional + audit-only for other transitions
 *
 * Server enforces the canTransition state-machine + per-role rules on
 * top of this — the schema only catches shape errors.
 */
export const TransitionSnagPayloadSchema = z
  .object({
    snagId: z.string().min(1, "snagId required"),
    nextStatus: SnagStatusSchema,
    reason: z
      .string()
      .max(
        SNAG_REJECTION_REASON_MAX,
        `Reason must be ${SNAG_REJECTION_REASON_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.nextStatus === "rejected") {
      const reason = (data.reason ?? "").trim();
      if (!reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "reason is required when nextStatus=rejected",
          path: ["reason"],
        });
      }
    }
  });

/** GET /api/snags?jobId=X response. */
export const SnagListResponseSchema = z.object({
  snags: z.array(SnagItemSchema),
});

/** POST /api/snags?jobId=X response. Returns the canonical written
 *  item so the client doesn't have to round-trip Blob read-after-write. */
export const SnagCreateResponseSchema = z.object({
  snagItem: SnagItemSchema,
});

/** POST /api/snags?action=transition response — same shape. */
export const SnagTransitionResponseSchema = SnagCreateResponseSchema;
