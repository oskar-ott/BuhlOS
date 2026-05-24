import { z } from "zod";

/**
 * Zod schemas for the jobs domain — match the api/jobs.js GET wire shape
 * verbatim so the typed client can consume the existing legacy endpoint
 * without re-modelling the storage layer.
 *
 * Phase D1 is read-only: list (GET /api/jobs) and single (GET /api/jobs?id=X).
 * Server-side filtering by assignedJobIds happens in api/jobs.js:188-195 for
 * non-admin roles; the client does no permission logic.
 *
 * Schemas use .passthrough() so admin-only legacy fields (contractValue,
 * labourEstimate, paidToDate, ...) and any future fields don't break parsing
 * when the worker happens to receive them in a response.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §5 Data model
 *   docs/rebuild-audit/12-domain-model-deep-dive.md §Jobs
 *   api/jobs.js — projectJobStructure() + GET handler
 */

export const JOB_STATUSES = [
  "active",
  "complete",
  "archived",
  "on_hold",
  "draft",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);

/**
 * Per-job feature flags from api/jobs.js sanitizeModules(). Sent on every
 * GET response. Phase D1 doesn't gate UI on these yet but parses them so
 * later phases (snags, materials, ITPs) can.
 */
export const JobModulesSchema = z
  .object({
    areas: z.boolean().optional(),
    snags: z.boolean().optional(),
    photos: z.boolean().optional(),
    hours: z.boolean().optional(),
    materials: z.boolean().optional(),
    tags: z.boolean().optional(),
    temps: z.boolean().optional(),
    plans: z.boolean().optional(),
    contacts: z.boolean().optional(),
    switchboards: z.boolean().optional(),
    circuits: z.boolean().optional(),
    itps: z.boolean().optional(),
    levels: z.boolean().optional(),
  })
  .passthrough();

/**
 * A single rough-in or fit-off task template. Lives at the job level and is
 * inherited by each area unless the area provides its own override (the
 * `roughInTasks` / `fitOffTasks` on an area). Phase D1 only renders the
 * job-level template list read-only.
 */
export const JobTaskTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    archived: z.boolean().optional(),
    order: z.number().optional(),
  })
  .passthrough();

/**
 * A custom-field row (per [12] §Universal field set). Used both on the Job
 * itself (Job.customFields) and on areas. Display read-only in Phase D1;
 * editing lives in legacy Job Builder.
 */
export const CustomFieldSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    value: z.unknown().optional(),
  })
  .passthrough();

export const JobAreaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    spaceType: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    order: z.number().optional(),
    // Per-area task overrides. When absent, the area inherits job-level
    // roughInTasks / fitOffTasks. Phase D1 doesn't render overrides yet —
    // task lists are job-level until D3.
    roughInTasks: z.array(JobTaskTemplateSchema).optional(),
    fitOffTasks: z.array(JobTaskTemplateSchema).optional(),
    customFields: z.array(CustomFieldSchema).optional(),
  })
  .passthrough();

export const JobAreaGroupSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    areas: z.array(JobAreaSchema).optional(),
    archived: z.boolean().optional(),
    order: z.number().optional(),
  })
  .passthrough();

/**
 * Job row as returned by api/jobs.js GET (list + single).
 *
 * Required: id, name. Everything else is optional or nullable — legacy
 * data shape is inconsistent across the jobs.json blob, and the server
 * projection does not normalise missing fields.
 *
 * `status` is optional because a handful of legacy rows pre-date the
 * status enum and have no field at all. We display "Active" as the
 * fallback in format.ts.
 */
export const JobSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: JobStatusSchema.optional(),
    ref: z.string().nullable().optional(),

    clientUserId: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    typeName: z.string().nullable().optional(),
    serviceM8JobId: z.string().nullable().optional(),

    // Site context — surfaced on the Phil job detail block per doc 27 §8.5.
    siteAddress: z.string().nullable().optional(),
    siteContactName: z.string().nullable().optional(),
    siteContactPhone: z.string().nullable().optional(),
    accessNotes: z.string().nullable().optional(),
    parkingNotes: z.string().nullable().optional(),
    safetyNotes: z.string().nullable().optional(),
    inductionRequired: z.boolean().nullable().optional(),

    // Schedule.
    startDate: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    programmedDurationDays: z.number().nullable().optional(),

    // Structure.
    areaGroups: z.array(JobAreaGroupSchema).optional(),
    roughInTasks: z.array(JobTaskTemplateSchema).optional(),
    fitOffTasks: z.array(JobTaskTemplateSchema).optional(),
    customFields: z.array(CustomFieldSchema).optional(),

    // Feature flags.
    modules: JobModulesSchema.optional(),

    // Timestamps — createdAt is always present; updatedAt is added by some
    // legacy writes but not all. We treat them as best-effort for display.
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

/**
 * List response — api/jobs.js GET (no `id` query) returns `{ jobs: [...] }`.
 * Server already filters to assignedJobIds for non-admin roles.
 */
export const JobListResponseSchema = z.object({
  jobs: z.array(JobSchema),
});

/**
 * Single-job response — api/jobs.js GET `?id=X` returns `{ job: {...} }`.
 */
export const JobDetailResponseSchema = z.object({
  job: JobSchema,
});

/**
 * Shared error shape from api/jobs.js. Used for typed failure branches.
 */
export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
