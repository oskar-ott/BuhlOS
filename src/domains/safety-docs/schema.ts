import { z } from "zod";

/**
 * #219 — safety documents on the job, with acknowledge-read in Phil.
 *
 * SWMS / SDS / other-safety documents live on the job, typed and versioned.
 * Phil shows them to assigned workers who acknowledge-read; the office sees who
 * has and hasn't acknowledged the CURRENT version. Acknowledgement identity is
 * always server-attributed from the session — never client-supplied.
 *
 * Storage (isolated, NOT the shared documents register):
 *   jobs/<jobId>/safety-docs.json   { documents: SafetyDoc[] }
 *   jobs/<jobId>/safety-acks.json   { acks: SafetyAck[] }
 *
 * Versioning: a new version of a doc is a NEW row (new id, version+1) that
 * supersedes the prior; acknowledgements key off the version-specific id, so a
 * new version starts with zero acks — "uploading a new version resets the
 * acknowledgement state" falls out for free.
 */

export const SAFETY_DOC_TYPES = ["swms", "sds", "other-safety"] as const;
export type SafetyDocType = (typeof SAFETY_DOC_TYPES)[number];

export const SAFETY_DOC_TYPE_LABEL: Record<SafetyDocType, string> = {
  swms: "SWMS",
  sds: "SDS",
  "other-safety": "Other safety",
};

export const SafetyDocSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  type: z.enum(SAFETY_DOC_TYPES),
  title: z.string(),
  version: z.number().int().positive(),
  fileName: z.string(),
  blobPath: z.string(),
  url: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  status: z.enum(["current", "superseded"]),
  supersedesId: z.string().nullable(),
  supersededById: z.string().nullable(),
  uploadedAt: z.string(),
  uploadedBy: z.string(),
});
export type SafetyDoc = z.infer<typeof SafetyDocSchema>;

export const SafetyAckSchema = z.object({
  docId: z.string(),
  version: z.number().int().positive(),
  userId: z.string(),
  userName: z.string(),
  at: z.string(),
});
export type SafetyAck = z.infer<typeof SafetyAckSchema>;

/** Office rollup: per current doc, who (of assigned workers) has acknowledged. */
export const SafetyDocRollupSchema = z.object({
  doc: SafetyDocSchema,
  acknowledged: z.array(z.object({ userId: z.string(), name: z.string(), at: z.string() })),
  outstanding: z.array(z.object({ userId: z.string(), name: z.string() })),
});
export type SafetyDocRollup = z.infer<typeof SafetyDocRollupSchema>;

/**
 * GET response (role-shaped by the server): current docs always; `rollup` for
 * the office (who's acknowledged), `acknowledgedDocIds` for a field viewer
 * (which they personally have acknowledged).
 */
export const SafetyDocsResponseSchema = z.object({
  documents: z.array(SafetyDocSchema),
  rollup: z.array(SafetyDocRollupSchema).optional(),
  acknowledgedDocIds: z.array(z.string()).optional(),
});
export type SafetyDocsResponse = z.infer<typeof SafetyDocsResponseSchema>;
