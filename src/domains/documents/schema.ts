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

export const DocumentListResponseSchema = z.object({
  plans: z.array(DocumentSchema),
});

export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
