import { z } from "zod";

/**
 * Zod schemas for the evidence domain.
 *
 * Phase D2 ships the foundation: domain model + storage strategy + REST
 * endpoint (GET list / POST create / POST review stub) + AuditLog
 * bootstrap that future D3 (Phil capture UI) and D4 (admin evidence
 * review) consume.
 *
 * Wire shape mirrors what api/evidence.js writes into
 * jobs/{jobId}/data.json under the new `evidence: []` array (matches
 * doc 24 §15.0 Decision 2 — same per-job blob as snags/tasks).
 *
 * Schemas use .passthrough() so future fields (review notes, mobile
 * sync metadata, EXIF, signoff IDs) don't break parsing for clients
 * compiled against an older schema. Mirrors the pattern in
 * src/domains/timesheets/schema.ts and src/domains/jobs/schema.ts.
 *
 * Status enum is the doc-28 §A.1 superset — `uploading` and
 * `pending_sync` are CLIENT-ONLY states that exist in the capture
 * sheet's local component state. The server never writes them; if a
 * GET response carries either, that's a server bug. `draft` lives only
 * in the client and is not even in the enum. See doc 24 §6 state
 * machine + doc 28 §A.1 / §B.3.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §5.5 + §6 + §15
 *   docs/rebuild-audit/27-interface-usability-pass.md §6.1 / §6.2
 *   docs/rebuild-audit/28-d2-d3-d4-evidence-qa-checklist.md §A
 *   api/_lib/job-tasks.js — effectiveRoughInTasks / effectiveFitOffTasks
 *   src/domains/timesheets/schema.ts — precedent (.passthrough + superRefine)
 */

export const EVIDENCE_KINDS = ["photo", "note"] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const EVIDENCE_STAGES = ["roughIn", "fitOff"] as const;
export const EvidenceStageSchema = z.enum(EVIDENCE_STAGES);

/**
 * Full status enum (doc 28 §A.1 superset). The server only ever WRITES
 * `submitted | reviewed | rejected`; `uploading` and `pending_sync`
 * live in the client capture sheet and never serialise.
 */
export const EVIDENCE_STATUSES = [
  "uploading",
  "pending_sync",
  "submitted",
  "reviewed",
  "rejected",
] as const;
export const EvidenceStatusSchema = z.enum(EVIDENCE_STATUSES);

/** Subset the server actually persists. Use this when you want a
 *  type-safe guarantee that a value came from the server. */
export const SERVER_EVIDENCE_STATUSES = ["submitted", "reviewed", "rejected"] as const;
export const ServerEvidenceStatusSchema = z.enum(SERVER_EVIDENCE_STATUSES);

export const EVIDENCE_SOURCES = ["phil", "admin", "system"] as const;
export const EvidenceSourceSchema = z.enum(EVIDENCE_SOURCES);

/** Cap matches doc 27 §6.1 / doc 28 §A.1 and mirrors snag note length
 *  to keep the capture sheet's character counter calibrated. */
export const EVIDENCE_NOTE_MAX = 280;

/** Cap for the admin rejection reason (doc 28 §A.4 review POST). */
export const REJECTION_REASON_MAX = 500;

/**
 * Full EvidenceItem as stored on jobs/{jobId}/data.json and as returned
 * by GET / POST /api/evidence.
 *
 * Server fills: id, capturedBy{Id,Name,Role}, capturedAt, status,
 * source, auditLogIds, createdAt, updatedAt. Reviewer fields land in D4.
 *
 * Refinements:
 *   - kind=photo requires both photoId AND photoUrl (doc 28 §A.1)
 *   - status=rejected requires non-empty rejectionReason (doc 28 §A.1)
 */
export const EvidenceItemSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),

    // Optional attachment context — present when capture is associated
    // with a specific area / stage / task. All three are independent;
    // a worker can capture against the job as a whole.
    areaId: z.string().nullable().optional(),
    stage: EvidenceStageSchema.nullable().optional(),
    taskId: z.string().nullable().optional(),

    // Discriminator + payload. `note` evidence ships in D2; `photo`
    // evidence requires the caller to have already uploaded the binary
    // via api/photos.js?action=upload-evidence-photo, then pass the
    // returned { id, url } pair as photoId + photoUrl.
    kind: EvidenceKindSchema,
    photoId: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    thumbnailUrl: z.string().nullable().optional(),
    note: z.string().nullable().optional(),

    // Capture metadata — server-set from session. clientCapturedAt is
    // optional client-supplied; used for idempotency / offline sync
    // reconciliation in later phases. exifLocation is preserved as-is
    // (no stripping) per doc 24 §6.
    capturedById: z.string(),
    capturedByName: z.string(),
    capturedByRole: z.string().nullable().optional(),
    capturedAt: z.string(),
    clientCapturedAt: z.string().nullable().optional(),
    exifLocation: z
      .object({
        lat: z.number(),
        lng: z.number(),
      })
      .nullable()
      .optional(),

    // Lifecycle.
    status: EvidenceStatusSchema,
    source: EvidenceSourceSchema,

    // Review state (D4). Persisted nullable so the wire shape stays
    // stable between phases — D4 just flips them from null.
    reviewedById: z.string().nullable().optional(),
    reviewedByName: z.string().nullable().optional(),
    reviewedAt: z.string().nullable().optional(),
    rejectionReason: z.string().nullable().optional(),

    // Audit trail pointers (doc 28 §A.1 + §A.5). The full audit rows
    // live in audit/{yyyy-mm}.json blobs — this array is just the IDs
    // an admin drawer can resolve.
    auditLogIds: z.array(z.string()),

    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (data.kind === "photo") {
      if (!data.photoId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "photoId is required when kind=photo",
          path: ["photoId"],
        });
      }
      if (!data.photoUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "photoUrl is required when kind=photo",
          path: ["photoUrl"],
        });
      }
    }
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
 * Payload the client POSTs to /api/evidence?jobId=<id>. Server fills
 * everything else from the session + storage.
 *
 * Validation rules (mirrored server-side in api/evidence.js):
 *   - kind required
 *   - kind=note  → note is required, ≤ EVIDENCE_NOTE_MAX
 *   - kind=photo → photoId AND photoUrl required
 *   - if taskId present → stage required, taskId must resolve via
 *     effectiveRoughInTasks/effectiveFitOffTasks against the job + area
 *   - note never exceeds EVIDENCE_NOTE_MAX even on photo evidence
 *     (workers can attach a caption with a photo)
 *
 * Client cannot set status on create — server always writes 'submitted'.
 */
export const CreateEvidencePayloadSchema = z
  .object({
    kind: EvidenceKindSchema,
    areaId: z.string().nullable().optional(),
    stage: EvidenceStageSchema.nullable().optional(),
    taskId: z.string().nullable().optional(),

    photoId: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    thumbnailUrl: z.string().nullable().optional(),
    note: z
      .string()
      .max(EVIDENCE_NOTE_MAX, `Note must be ${EVIDENCE_NOTE_MAX} characters or fewer`)
      .nullable()
      .optional(),

    clientCapturedAt: z.string().nullable().optional(),
    exifLocation: z
      .object({
        lat: z.number(),
        lng: z.number(),
      })
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "note") {
      const note = data.note?.trim() ?? "";
      if (!note) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "note is required for kind=note",
          path: ["note"],
        });
      }
    }
    if (data.kind === "photo") {
      if (!data.photoId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "photoId is required for kind=photo",
          path: ["photoId"],
        });
      }
      if (!data.photoUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "photoUrl is required for kind=photo",
          path: ["photoUrl"],
        });
      }
    }
    if (data.taskId && !data.stage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stage is required when taskId is provided",
        path: ["stage"],
      });
    }
  });

/**
 * Admin review payload (D4 wires the UI; D2 stubs the endpoint so the
 * shape is locked in early). Either marks an item reviewed or rejects
 * with a required reason.
 */
export const ReviewEvidencePayloadSchema = z
  .object({
    evidenceId: z.string().min(1, "evidenceId required"),
    status: z.enum(["reviewed", "rejected"]),
    rejectionReason: z
      .string()
      .max(REJECTION_REASON_MAX, `Reason must be ${REJECTION_REASON_MAX} characters or fewer`)
      .nullable()
      .optional(),
  })
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

/** GET /api/evidence?jobId=X response. */
export const EvidenceListResponseSchema = z.object({
  evidence: z.array(EvidenceItemSchema),
});

/** POST /api/evidence?jobId=X response. Server returns the canonical
 *  written item so the client never needs to round-trip read-after-write
 *  through Blob (which has ~5s cache TTL — see api/_lib/blob.js).
 *  This avoids the Phase C BUG-C-004 read-after-write lag pattern. */
export const EvidenceCreateResponseSchema = z.object({
  evidenceItem: EvidenceItemSchema,
});

/** POST review response — same shape, returns the canonical item. */
export const EvidenceReviewResponseSchema = EvidenceCreateResponseSchema;

/** Shared error shape across the legacy + new APIs. */
export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
