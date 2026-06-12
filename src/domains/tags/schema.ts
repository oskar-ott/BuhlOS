import { z } from "zod";

/**
 * Zod schemas for the per-job Test & Tag register — match api/tags.js wire
 * shape verbatim (#388 rebuilds the surface the legacy cutover deleted; the
 * endpoint is reused untouched).
 *
 * Storage is jobs/<jobId>/tags.json; dates are dd/mm/yyyy strings (the
 * register's canonical format — see src/domains/tags/expiry.ts for parsing).
 * Legacy rows may carry `name` (mirror of applianceType) and miss newer
 * fields, so everything beyond `id` is optional + passthrough.
 */

export const TAG_RETEST_INTERVALS = ["1mo", "3mo", "6mo", "12mo", ""] as const;
export const TAG_RESULTS = ["pass", "fail", ""] as const;

export const TagItemSchema = z
  .object({
    id: z.string(),
    applianceType: z.string().optional(),
    /** Legacy mirror of applianceType — some old rows only carry this. */
    name: z.string().optional(),
    tagNumber: z.string().optional(),
    owner: z.string().optional(),
    testedBy: z.string().optional(),
    testDate: z.string().optional(),
    expiryDate: z.string().optional(),
    retestInterval: z.string().optional(),
    result: z.string().optional(),
    notes: z.string().optional(),
    photoUrl: z.string().optional(),
    ocrConfidence: z.record(z.string(), z.number()).optional(),
    createdBy: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const TagListResponseSchema = z.object({
  tags: z.array(TagItemSchema),
});

export const TagMutationResponseSchema = z.object({
  tag: TagItemSchema,
});

/** POST ?action=photo response — the uploaded tag photo's public URL. */
export const TagPhotoResponseSchema = z.object({
  url: z.string(),
});

/**
 * POST ?action=ocr response. `confidence` is per-field 0..1; the server
 * returns 200 WITH an `error` field when the model reply couldn't be parsed
 * (fields empty, confidence zeroed) — callers branch on `error`, not status.
 */
export const TagOcrResponseSchema = z
  .object({
    fields: z.object({
      tagNumber: z.string(),
      applianceType: z.string(),
      testedBy: z.string(),
      testDate: z.string(),
      expiryDate: z.string(),
      result: z.string(),
    }),
    confidence: z.record(z.string(), z.number()),
    raw: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** The editable field set shared by the create/edit forms and payloads. */
export const TagDraftSchema = z.object({
  applianceType: z.string(),
  tagNumber: z.string(),
  owner: z.string(),
  testedBy: z.string(),
  testDate: z.string(),
  expiryDate: z.string(),
  retestInterval: z.string(),
  result: z.string(),
  notes: z.string(),
  photoUrl: z.string(),
  ocrConfidence: z.record(z.string(), z.number()).optional(),
});

export type TagItem = z.infer<typeof TagItemSchema>;
export type TagDraft = z.infer<typeof TagDraftSchema>;
export type TagOcrResponse = z.infer<typeof TagOcrResponseSchema>;
