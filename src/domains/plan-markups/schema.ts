import { z } from "zod";

/**
 * DrawingMarkup — Plans Phase 2 overlay model.
 *
 * Overlays are stored SEPARATELY from the original drawing (never written into
 * the PDF/image). One record = one mark on one page of one plan revision:
 *
 *   storage: jobs/<jobId>/drawing-markups.json  → { markups: DrawingMarkup[] }
 *
 * Anchoring (audit §8): `planId` is the documents-register row id, and because
 * every plan REVISION is a separate register row with its own id, a markup is
 * inherently revision-specific — it can never bleed onto a different revision.
 * `pageIndex` pins it to one page. `drawingNumber`/`revision` are denormalised
 * context for display only; the id is the anchor.
 *
 * Coordinates are NORMALISED 0..1 (origin top-left), matching
 * src/domains/plans/coords.ts, so a mark stays attached through zoom/pan/rotate
 * and across raster resolutions.
 *
 * The original drawing remains immutable — this model adds an overlay layer,
 * nothing more. No AI, no takeoff, no as-built export.
 */

/**
 * The markup shapes. pin/note/text use an {x,y} anchor; line/arrow use exactly
 * two `points`; area uses 3..MAX `points`. `arrow` + `text` are the Phase 3
 * annotation-slice additions (#651) — this enum is the lockstep partner of
 * api/plan-markups.js's `MARKUP_TYPES`; the two MUST agree or the client
 * safeParse and the server validator disagree.
 */
export const MARKUP_TYPES = ["pin", "note", "line", "area", "arrow", "text"] as const;
export const MarkupTypeSchema = z.enum(MARKUP_TYPES);

/** A small, fixed tone palette (no free-form colour — keeps the overlay calm). */
export const MARKUP_TONES = ["navy", "yellow", "red", "green", "grey"] as const;
export const MarkupToneSchema = z.enum(MARKUP_TONES);

/** Text caps — render-safe ceilings so a runaway note can't break layout. */
export const MARKUP_TEXT_MAX = 2000;
export const MARKUP_LABEL_MAX = 120;
/** Polyline/area point bounds. line = exactly 2; area = 3..MAX. */
export const MARKUP_AREA_POINTS_MAX = 24;

/** A normalised 0..1 page coordinate (reject anything off-page). */
const Coord = z.number().min(0).max(1);
export const MarkupPointSchema = z.object({ x: Coord, y: Coord });

/**
 * Per-type coordinate-shape guard shared by the stored record and the create
 * payload: pin/note/text need an {x,y} anchor; line/arrow need exactly two
 * points; area needs 3..MAX. Keeps "invalid coordinates" rejection in one place.
 * `text` shares the {x,y} anchor branch (a callout at a point), `arrow` shares
 * the exactly-2-points branch (a directed segment) — see #651.
 */
function refineShape(
  val: { type: string; x?: number; y?: number; points?: Array<{ x: number; y: number }> },
  ctx: z.RefinementCtx,
) {
  if (val.type === "pin" || val.type === "note" || val.type === "text") {
    if (typeof val.x !== "number" || typeof val.y !== "number") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["x"], message: `${val.type} requires x,y` });
    }
  } else if (val.type === "line" || val.type === "arrow") {
    if (!val.points || val.points.length !== 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["points"], message: `${val.type} requires exactly 2 points` });
    }
  } else if (val.type === "area") {
    const n = val.points?.length ?? 0;
    if (n < 3 || n > MARKUP_AREA_POINTS_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points"],
        message: `area requires 3..${MARKUP_AREA_POINTS_MAX} points`,
      });
    }
  }
}

/** The stored record (what lives in drawing-markups.json). */
export const DrawingMarkupSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    planId: z.string(),
    pageIndex: z.number().int().min(0),
    type: MarkupTypeSchema,

    x: Coord.optional(),
    y: Coord.optional(),
    points: z.array(MarkupPointSchema).max(MARKUP_AREA_POINTS_MAX).optional(),

    text: z.string().max(MARKUP_TEXT_MAX).optional(),
    label: z.string().max(MARKUP_LABEL_MAX).optional(),
    tone: MarkupToneSchema.optional(),

    /** Office-only by default; only true overlays reach the field. */
    visibleToPhil: z.boolean(),
    archived: z.boolean(),

    /**
     * #233 — as-built designation. The IDENTICAL field name as the evidence
     * record (src/domains/evidence/schema.ts) so a future as-built export
     * reads both stores with no per-store translation. ABSENCE = not-as-built
     * (never inferred). Set via PATCH in the admin viewer, not at create —
     * optional so every pre-#233 markup stays valid with no migration.
     */
    asBuilt: z.boolean().optional(),

    /** Denormalised display context (the anchor is planId, not these). */
    drawingNumber: z.string().optional(),
    revision: z.string().optional(),

    createdBy: z.string().optional(),
    createdAt: z.string().optional(),
    updatedBy: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .superRefine(refineShape);

/** POST body — the server assigns id/timestamps/createdBy and defaults flags. */
export const CreateMarkupPayloadSchema = z
  .object({
    jobId: z.string().min(1),
    planId: z.string().min(1),
    pageIndex: z.number().int().min(0),
    type: MarkupTypeSchema,
    x: Coord.optional(),
    y: Coord.optional(),
    points: z.array(MarkupPointSchema).max(MARKUP_AREA_POINTS_MAX).optional(),
    text: z.string().max(MARKUP_TEXT_MAX).optional(),
    label: z.string().max(MARKUP_LABEL_MAX).optional(),
    tone: MarkupToneSchema.optional(),
    /** Defaults to false (office-only) server-side when omitted. */
    visibleToPhil: z.boolean().optional(),
    drawingNumber: z.string().max(120).optional(),
    revision: z.string().max(40).optional(),
  })
  .superRefine(refineShape);

/**
 * PATCH body — partial edit. All optional; the server ignores unknown keys
 * (no broad body spreading). `points`/`x`/`y` are re-validated as 0..1 but the
 * per-type shape isn't re-refined here (an edit can't change `type`).
 */
export const UpdateMarkupPayloadSchema = z
  .object({
    x: Coord.optional(),
    y: Coord.optional(),
    points: z.array(MarkupPointSchema).max(MARKUP_AREA_POINTS_MAX).optional(),
    text: z.string().max(MARKUP_TEXT_MAX).nullable().optional(),
    label: z.string().max(MARKUP_LABEL_MAX).nullable().optional(),
    tone: MarkupToneSchema.optional(),
    visibleToPhil: z.boolean().optional(),
    archived: z.boolean().optional(),
    // #233 — set the as-built designation from the admin viewer. Required in
    // this .strict() schema or updateMarkup() would reject the patch.
    asBuilt: z.boolean().optional(),
  })
  .strict();

export const MarkupListResponseSchema = z.object({
  markups: z.array(DrawingMarkupSchema),
});
export const MarkupMutationResponseSchema = z.object({
  markup: DrawingMarkupSchema,
});
export const ApiErrorBodySchema = z.object({ error: z.string() });
