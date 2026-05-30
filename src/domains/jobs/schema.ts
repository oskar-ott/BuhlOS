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

    // Optional `?withStats=1` enrichment — only present when the list
    // endpoint is called with `?withStats=1` (used by the admin jobs
    // index). All fields are best-effort: if the data.json read fails
    // the server returns zeroes rather than dropping the row.
    statsPct: z.number().nullable().optional(),
    statsOpenSnags: z.number().optional(),
    statsCrewCount: z.number().optional(),
    statsAreaCount: z.number().optional(),
    statsExpiredTags: z.number().optional(),
    statsExpiringTags: z.number().optional(),
    /** Phase D6: count of rebuild evidence rows still in submitted /
     *  pending_upload state (i.e. waiting for admin review). */
    statsEvidenceV2Pending: z.number().optional(),
    /** Phase D6: count of rebuild snags (snagsV2) in active states —
     *  open / in_progress / resolved. */
    statsSnagsV2Active: z.number().optional(),
    /** Phase E1a: count of ITP instances in active (non-terminal,
     *  non-archived) states — pending / in-progress / witnessed.
     *  Drives the "ITPs N" chip on /v2/jobs (admin jobs index). */
    statsItpsActive: z.number().optional(),
    /** Post-E1 hardening: subset of statsItpsActive that are in the
     *  `witnessed` state — i.e. ready for admin sign-off. Drives the
     *  Command Centre "ITPs needing sign-off" queue card. */
    statsItpsNeedsReview: z.number().optional(),
    /** Phase E2: count of plan/spec rows in `current` status (and
     *  legacy rows without a status field, which default to current).
     *  Drives the "Documents N" chip on /v2/jobs and the section nav
     *  on /v2/jobs/[jobId]. */
    statsDocumentsCurrent: z.number().optional(),
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

/* ---------------------------------------------------------------------
 * Write / request payloads — Job Builder (modern write path).
 *
 * Phase D1 shipped read-only. These schemas describe the request bodies
 * the modern Builder/Editor sends to the EXISTING api/jobs.js POST
 * (create) + PUT (update) handlers — they are not a new storage model.
 *
 * They are deliberately permissive **wire-shape** guards: the client
 * `.safeParse()`s an outgoing body to catch a malformed payload before
 * the network call, but the authoritative business rules (required name,
 * date ordering, type-exists, id-uniqueness, role gates) live in
 * api/jobs.js and re-run server-side. Publish-readiness rules live in
 * the pure builder.ts (validateForPublish) so they can be unit-tested
 * without a server.
 *
 * `.passthrough()` so a field the UI doesn't model yet (e.g. money
 * fields the legacy editor writes) survives if a caller includes it.
 *
 * Cross-ref:
 *   api/jobs.js POST (create, ~374) + PUT (update, ~465)
 *   src/domains/jobs/builder.ts — payload builders + publish validation
 * -------------------------------------------------------------------*/

/** Task template as written by the builder. `id` optional — the server
 *  preserves an existing id by name or mints a new one. */
export const JobTaskTemplateInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
  })
  .passthrough();

export const JobAreaInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    spaceType: z.string().nullable().optional(),
    roughInTasks: z.array(JobTaskTemplateInputSchema).optional(),
    fitOffTasks: z.array(JobTaskTemplateInputSchema).optional(),
  })
  .passthrough();

export const JobAreaGroupInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().min(1),
    areas: z.array(JobAreaInputSchema).optional(),
  })
  .passthrough();

/**
 * The fields the modern Builder may write. All optional here; required-ness
 * is enforced per-verb (create requires `name`, update requires `id`) and
 * by validateForPublish before publish. Money fields are intentionally
 * omitted — the modern Builder doesn't edit them; leaving them out of the
 * PUT body means the server leaves the stored values untouched.
 */
const JobWritableFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  status: JobStatusSchema.optional(),
  ref: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  clientUserId: z.string().nullable().optional(),

  siteAddress: z.string().nullable().optional(),
  siteContactName: z.string().nullable().optional(),
  siteContactPhone: z.string().nullable().optional(),
  accessNotes: z.string().nullable().optional(),
  parkingNotes: z.string().nullable().optional(),
  safetyNotes: z.string().nullable().optional(),
  inductionRequired: z.boolean().optional(),

  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  programmedDurationDays: z.number().nullable().optional(),

  areaGroups: z.array(JobAreaGroupInputSchema).optional(),
  roughInTasks: z.array(JobTaskTemplateInputSchema).optional(),
  fitOffTasks: z.array(JobTaskTemplateInputSchema).optional(),

  modules: JobModulesSchema.optional(),
});

/** POST /api/jobs body. `name` required; `id` optional (server slugifies
 *  from name when omitted). */
export const JobCreateInputSchema = JobWritableFieldsSchema.extend({
  name: z.string().min(1),
  id: z.string().optional(),
}).passthrough();

/** PUT /api/jobs body. `id` required; every other field is an optional
 *  patch — only the keys present are touched server-side. */
export const JobUpdateInputSchema = JobWritableFieldsSchema.extend({
  id: z.string().min(1),
}).passthrough();
