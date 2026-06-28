import { z } from "zod";

/**
 * Zod schemas for the documents (plans + specs) domain — Phase E2.
 *
 * Wraps the legacy `api/plans.js` GET shape verbatim so the rebuild
 * Phil panel + admin queue can consume the existing endpoint without
 * re-modelling storage. Storage shape mirrors api/plans.js:
 *
 *   jobs/<jobId>/plans-index.json
 *     { plans: [{
 *         id, jobId,
 *         fileName, blobPath, url, mimeType, sizeBytes,
 *         drawingNumber, revision, title, level, category,
 *         status: 'current' | 'superseded' | 'archived',
 *         notes,
 *         supersedes, supersededBy,
 *         uploadedAt, uploadedBy, uploadedByUserId,
 *     }] }
 *
 * `.passthrough()` everywhere — legacy fields the viewer doesn't render
 * (Phase 9 AI takeoff `pages[]`, etc.) flow through untouched; future
 * additions don't break parsing. Same precedent as evidence + snags +
 * itp.
 *
 * E2 is **read-only**. There is no PlanRecordCreate / Patch payload
 * schema — uploads keep happening on the legacy /admin/plans SPA.
 *
 * Cross-ref:
 *   docs/rebuild-audit/36-documents-specs-readiness-note.md
 *   api/plans.js — GET source of truth
 *   src/domains/itp/schema.ts — precedent
 */

/* ---------------------------------------------------------------------
 * Status enum (mirrors api/plans.js VALID_STATUSES)
 * -------------------------------------------------------------------*/

export const DOCUMENT_STATUSES = [
  "current",
  "superseded",
  "archived",
] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);

/* ---------------------------------------------------------------------
 * Category enum (from legacy /admin/plans.html upload UI)
 *
 * Legacy stores `category` as free text — we keep it loose at the
 * schema layer and let format.ts collapse anything unknown into 'other'.
 * Surfacing the closed-set list here lets the admin queue render
 * filter chips without re-deriving the union of in-use values.
 * -------------------------------------------------------------------*/

export const DOCUMENT_CATEGORIES = [
  "plan",
  "spec",
  "schedule",
  "photo",
  "certificate",
  "other",
] as const;
export const DocumentCategorySchema = z.enum(DOCUMENT_CATEGORIES);

/** #194: closed discipline set for drawing-type rows (additive — legacy
 *  rows without one group under "other" in the UI). */
export const DOCUMENT_DISCIPLINES = [
  "architectural",
  "electrical",
  "services",
  "structural",
  "other",
] as const;
export const DocumentDisciplineSchema = z.enum(DOCUMENT_DISCIPLINES);

/** #196: the two work-tree stages a spec can govern. Mirrors the
 *  job's roughIn/fitOff stages (api/evidence.js VALID_STAGES). A spec
 *  link MAY name a stage; omitting it means "governs both stages". */
export const DOCUMENT_STAGES = ["roughIn", "fitOff"] as const;
export const DocumentStageSchema = z.enum(DOCUMENT_STAGES);

/* ---------------------------------------------------------------------
 * Field caps (defensive — mirror api/plans.js upload validation)
 * -------------------------------------------------------------------*/

/** File name cap — api/plans.js stores body.fileName.slice(0, 200). */
export const DOCUMENT_FILENAME_MAX = 200;

/** Notes cap — not enforced on api/plans.js, but render-safe ceiling
 *  for the viewer surface so a runaway note doesn't break layout. */
export const DOCUMENT_NOTES_DISPLAY_MAX = 1000;

/* ---------------------------------------------------------------------
 * PlanRecord (single document row)
 *
 * Required: id + url (the viewer can't render a row without a link to
 * open the file). Everything else is `.optional()` because the legacy
 * shape is inconsistent: pre-Phase-9 rows may lack title/category;
 * rows uploaded before the revision lineage work may lack
 * supersedes/supersededBy.
 * -------------------------------------------------------------------*/

export const DocumentSchema = z
  .object({
    id: z.string(),
    jobId: z.string().optional(),

    fileName: z.string().optional(),
    blobPath: z.string().optional(),
    /** Public Vercel Blob URL — what the viewer opens in a new tab. */
    url: z.string(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),

    discipline: z.string().optional(),
    drawingNumber: z.string().optional(),
    revision: z.string().optional(),
    title: z.string().optional(),
    level: z.string().optional(),
    /** Free text on disk; the viewer collapses unknown values into
     *  "other" via format.ts#categoryLabel. */
    category: z.string().optional(),
    /** Free-text status guard — see DocumentStatusSchema for the
     *  closed set. `.optional()` because legacy rows without `status`
     *  default to 'current' on the server side. */
    status: DocumentStatusSchema.optional(),
    notes: z.string().optional(),

    /** Revision lineage. Both empty on the first revision of a
     *  drawing; `supersedes` points back, `supersededBy` points
     *  forward. */
    supersedes: z.string().optional(),
    supersededBy: z.string().optional(),
    /** #299: what changed in this revision — free text captured at
     *  registration, shown in admin and Phil. Empty on first issues. */
    changeSummary: z.string().optional(),

    /** #196: spec → work-tree linkage (additive). A spec document can be
     *  linked to the areas it governs (validated against the job's work
     *  tree at link time) and, optionally, the stage it applies to. Empty
     *  / absent on every drawing and on un-linked specs.
     *
     *  `areaLinks` denormalises the area name at link time — the read
     *  surfaces (admin chips + Phil area block) render the name without a
     *  live job-tree join per render. `areaIds` stays the source of truth
     *  for filtering; `areaLinks` is a display cache that can go stale if
     *  an area is renamed, so the UI prefers the live name when it has the
     *  job in hand and falls back to the denormalised name otherwise. A
     *  link whose areaId no longer exists on the job is shown honestly as
     *  "linked area no longer on this job" (P7), never silently dropped. */
    areaIds: z.array(z.string()).optional(),
    areaLinks: z
      .array(z.object({ areaId: z.string(), areaName: z.string() }))
      .optional(),
    stage: DocumentStageSchema.optional(),

    uploadedAt: z.string().optional(),
    uploadedBy: z.string().optional(),
    uploadedByUserId: z.string().optional(),
  })
  .passthrough();

/* ---------------------------------------------------------------------
 * List response — GET /api/plans?jobId=X returns { plans: [...] }.
 *
 * The legacy endpoint server-side filters archived rows for non-admin
 * callers, so the client typically sees only `current | superseded`.
 * Admins with ?includeArchived=1 see everything. The schema accepts
 * any of the three.
 * -------------------------------------------------------------------*/

/** POST /api/plans?jobId= upload payload (#379) — dataUrl carries the file. */
export const UploadDocumentPayloadSchema = z.object({
  dataUrl: z.string().min(1),
  fileName: z.string().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
  drawingNumber: z.string().optional(),
  revision: z.string().optional(),
  discipline: z.string().optional(),
  /** #299: explicit one-step revision — the predecessor's plan id. The
   *  server inherits identity fields and supersedes it atomically. */
  revisesPlanId: z.string().optional(),
  changeSummary: z.string().optional(),
});

export const UploadDocumentResponseSchema = z.object({
  plan: DocumentSchema,
  /** Non-null when the upload auto-superseded a same-number current revision. */
  revisionWarning: z.string().nullable(),
  /** #299: how many assigned field workers were pushed about the revision. */
  notified: z.number().optional(),
});

/** #196: PATCH ?id= link payload — set the areas + (optional) stage a
 *  spec governs. `areaIds` is the full set on each call (PUT-replace
 *  semantics — passing `[]` clears the link). `stage` is optional;
 *  passing `null` / "" clears it. The server validates every areaId
 *  against the job's work tree and denormalises the names. */
export const LinkDocumentAreasPayloadSchema = z.object({
  areaIds: z.array(z.string()),
  stage: DocumentStageSchema.nullable().optional(),
});

export const LinkDocumentAreasResponseSchema = z.object({
  plan: DocumentSchema,
});

/* #299: revision acknowledgements. */
export const PlanAckSchema = z.object({
  planId: z.string(),
  userId: z.string(),
  userName: z.string(),
  ackAt: z.string(),
});
export const AckMutationResponseSchema = z.object({
  ack: PlanAckSchema,
  already: z.boolean().optional(),
});
export const MyAcksResponseSchema = z.object({
  planIds: z.array(z.string()),
});
export const PlanAcksRollupResponseSchema = z.object({
  acked: z.array(z.object({ userId: z.string(), userName: z.string(), ackAt: z.string() })),
  outstanding: z.array(z.object({ userId: z.string(), userName: z.string() })),
});

/** POST ?action=set-pages — one rendered page per call (serverless body cap). */
export const SetPagesResponseSchema = z
  .object({ plan: DocumentSchema.optional(), pages: z.unknown().optional() })
  .passthrough();

export const DocumentListResponseSchema = z.object({
  plans: z.array(DocumentSchema),
});

export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
