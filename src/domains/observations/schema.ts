import { z } from "zod";

/**
 * Zod schemas for the observations domain (PR 3).
 *
 * An "observation" is a piece of site truth captured in the field (Phil)
 * or the office (BuhlOS) that may or may not require action. It is the
 * GENERAL field-to-office item — broader than Evidence (a photo/compliance
 * record) and broader than a Snag (a specific quality defect with its own
 * verify/close lifecycle).
 *
 * An observation can LINK to an existing Evidence row (linkedEvidenceId) or
 * Snag (linkedSnagId) but does not replace either — Evidence review and the
 * Snag lifecycle stay intact. It can later be CONVERTED (intent recorded via
 * convertedTo) into an RFI / Variation / Defect / Material Request; those
 * downstream modules are not built yet, so conversion records intent only
 * (honest "coming next", never a faked record).
 *
 * Storage — a NEW top-level blob `observations.json`:
 *   { observations: [ObservationItem, ...] }
 * Chosen over per-job data.json (where snagsV2/evidence live) because the
 * BuhlOS Observations Inbox is inherently CROSS-JOB — a single-document read
 * is the right shape and avoids the every-job fan-out api/snags-all.js pays.
 * A brand-new blob also cannot corrupt existing job/evidence/snag data.
 * Whole-document rewrite race is bounded + acceptable at field-app volume
 * (same pattern as employees.json / invites.json); a store split is Phase F+.
 *
 * Schemas use .passthrough() so future fields don't break older clients —
 * same convention as evidence / snags / jobs / timesheets.
 *
 * Cross-ref:
 *   src/domains/snags/schema.ts — closest precedent (status/priority/source,
 *     evidence linkage, denormalised area/task names)
 *   docs/architecture/observations.md — model + relationships
 */

export const OBSERVATION_TYPES = [
  "note",
  "blocker",
  "rfi",
  "variation",
  "defect",
  "safety",
  "material_request",
  "plan_mismatch",
  "client_instruction",
  "evidence",
] as const;
export const ObservationTypeSchema = z.enum(OBSERVATION_TYPES);

export const OBSERVATION_STATUSES = [
  "new",
  "needs_action",
  "in_review",
  "converted",
  "resolved",
  "record_only",
] as const;
export const ObservationStatusSchema = z.enum(OBSERVATION_STATUSES);

export const OBSERVATION_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const ObservationPrioritySchema = z.enum(OBSERVATION_PRIORITIES);

export const OBSERVATION_SOURCES = ["phil", "buhlos", "system"] as const;
export const ObservationSourceSchema = z.enum(OBSERVATION_SOURCES);

export const OBSERVATION_STAGES = ["roughIn", "fitOff"] as const;
export const ObservationStageSchema = z.enum(OBSERVATION_STAGES);

/**
 * What an observation can be converted into. Recorded as INTENT only in v1
 * (the RFI / Variation / Material Request modules don't exist yet); 'snag'
 * and 'task' are placeholders for the same reason. The inbox shows an
 * honest "coming next" badge rather than pretending a target record exists.
 */
export const OBSERVATION_CONVERT_TARGETS = [
  "rfi",
  "variation",
  "defect",
  "snag",
  "material_request",
  "task",
] as const;
export const ObservationConvertTargetSchema = z.enum(OBSERVATION_CONVERT_TARGETS);

export const OBSERVATION_TITLE_MAX = 140;
export const OBSERVATION_DESCRIPTION_MAX = 2000;
export const OBSERVATION_RESOLUTION_NOTE_MAX = 1000;
/** Cap photos per observation. Field capture is one or two shots; the cap
 *  just stops a runaway client from attaching an unbounded array. */
export const OBSERVATION_PHOTO_MAX = 10;

/**
 * Full ObservationItem as persisted in observations.json and returned by
 * GET/POST/PATCH /api/observations.
 *
 * Server fills: id, status ('new' on create), source, createdBy{Id,Name,Role},
 * createdAt, updatedAt, requiresAction (inferred from type unless the client
 * sent an explicit override). Resolution / conversion stamps land as the
 * matching PATCH flips them.
 */
export const ObservationItemSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    /** Denormalised job name stamped on create (like areaName/taskName) so the
     *  cross-job inbox renders + filters without re-reading jobs.json. */
    jobName: z.string().nullable().optional(),

    type: ObservationTypeSchema,
    title: z.string(),
    description: z.string().nullable().optional(),

    status: ObservationStatusSchema,
    priority: ObservationPrioritySchema,
    source: ObservationSourceSchema,
    requiresAction: z.boolean(),

    // Optional job context. Denormalised *Name labels are stamped on create
    // so the inbox doesn't re-walk areaGroups every render (snags precedent).
    stage: ObservationStageSchema.nullable().optional(),
    areaId: z.string().nullable().optional(),
    areaName: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    taskName: z.string().nullable().optional(),

    // Links to existing field records on the same job (never replaces them).
    linkedEvidenceId: z.string().nullable().optional(),
    linkedSnagId: z.string().nullable().optional(),
    /** PR 11: set when the observation has been converted to a real Material
     *  Request via POST /api/observations?action=convert-to-material-request.
     *  The same observation cannot also be linked to a Snag (the API rejects
     *  a second convert with 409 if `convertedTo` is already set). */
    linkedMaterialRequestId: z.string().nullable().optional(),
    photoUrls: z.array(z.string()),

    // Actor stamps. Worker/admin creates → office triages/resolves.
    createdById: z.string(),
    createdByName: z.string(),
    createdByRole: z.string().nullable().optional(),
    assignedToId: z.string().nullable().optional(),
    assignedToName: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),

    // Resolution.
    resolutionNote: z.string().nullable().optional(),
    resolvedAt: z.string().nullable().optional(),
    resolvedById: z.string().nullable().optional(),
    resolvedByName: z.string().nullable().optional(),

    // Conversion INTENT (downstream modules not built — see convert targets).
    convertedTo: ObservationConvertTargetSchema.nullable().optional(),
    convertedTargetId: z.string().nullable().optional(),
    convertedAt: z.string().nullable().optional(),
    convertedById: z.string().nullable().optional(),
    convertedByName: z.string().nullable().optional(),

    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/**
 * Payload POSTed to /api/observations?jobId=<id> to create one.
 *
 * Validation (mirrored server-side in api/observations.js):
 *   - type required + valid
 *   - title required, trimmed, 1..OBSERVATION_TITLE_MAX
 *   - description optional, ≤ OBSERVATION_DESCRIPTION_MAX
 *   - priority optional (server defaults 'normal')
 *   - requiresAction optional (server infers from type when absent)
 *   - if taskId present → stage required
 * Client cannot set status on create — server always writes 'new'.
 */
export const CreateObservationPayloadSchema = z
  .object({
    type: ObservationTypeSchema,
    title: z
      .string()
      .trim()
      .min(1, "title is required")
      .max(OBSERVATION_TITLE_MAX, `Title must be ${OBSERVATION_TITLE_MAX} characters or fewer`),
    description: z
      .string()
      .max(
        OBSERVATION_DESCRIPTION_MAX,
        `Description must be ${OBSERVATION_DESCRIPTION_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
    priority: ObservationPrioritySchema.optional(),
    requiresAction: z.boolean().optional(),

    stage: ObservationStageSchema.nullable().optional(),
    areaId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),

    linkedEvidenceId: z.string().nullable().optional(),
    linkedSnagId: z.string().nullable().optional(),
    photoUrls: z
      .array(z.string())
      .max(OBSERVATION_PHOTO_MAX, `photoUrls may not exceed ${OBSERVATION_PHOTO_MAX} links`)
      .optional(),

    assignedToId: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
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
 * Payload PATCHed to /api/observations?jobId=<id> to triage / update one.
 * All fields optional except id; the server applies only what's present and
 * stamps the matching actor/timestamp. Office-tier (staff) gate enforced
 * server-side; conversion is admin-tier.
 */
export const UpdateObservationPayloadSchema = z
  .object({
    id: z.string().min(1, "id is required"),
    status: ObservationStatusSchema.optional(),
    priority: ObservationPrioritySchema.optional(),
    requiresAction: z.boolean().optional(),
    assignedToId: z.string().nullable().optional(),
    resolutionNote: z
      .string()
      .max(
        OBSERVATION_RESOLUTION_NOTE_MAX,
        `Resolution note must be ${OBSERVATION_RESOLUTION_NOTE_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
    convertedTo: ObservationConvertTargetSchema.nullable().optional(),
    convertedTargetId: z.string().nullable().optional(),
    linkedEvidenceId: z.string().nullable().optional(),
    linkedSnagId: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const touchesSomething =
      data.status !== undefined ||
      data.priority !== undefined ||
      data.requiresAction !== undefined ||
      data.assignedToId !== undefined ||
      data.resolutionNote !== undefined ||
      data.convertedTo !== undefined ||
      data.linkedEvidenceId !== undefined ||
      data.linkedSnagId !== undefined;
    if (!touchesSomething) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "update must change at least one field",
        path: ["id"],
      });
    }
  });

/** GET /api/observations[...] response. */
export const ObservationListResponseSchema = z.object({
  observations: z.array(ObservationItemSchema),
});

/** POST/PATCH /api/observations response — returns the canonical written
 *  item so the client skips a Blob read-after-write round-trip. */
export const ObservationMutationResponseSchema = z.object({
  observation: ObservationItemSchema,
});

/** PR 6: POST /api/observations?action=convert-to-snag response — returns the
 *  updated observation AND the newly-created Snag. The snag is left as a
 *  passthrough object so this schema doesn't couple to the snags domain (only
 *  `id` is contractually required for the inbox UI to link to /v2/jobs/<id>/snags). */
export const ObservationConvertToSnagResponseSchema = z.object({
  observation: ObservationItemSchema,
  snag: z.object({ id: z.string() }).passthrough(),
});

/** PR 11: POST /api/observations?action=convert-to-material-request response —
 *  returns the updated observation AND the newly-created Material Request. The
 *  material request is left as a passthrough object so this schema doesn't
 *  couple to the material-requests domain (only `id` is contractually required
 *  for the inbox UI to link to /material-requests). */
export const ObservationConvertToMaterialRequestResponseSchema = z.object({
  observation: ObservationItemSchema,
  materialRequest: z.object({ id: z.string() }).passthrough(),
});
