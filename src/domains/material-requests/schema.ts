import { z } from "zod";

/**
 * Zod schemas for the Material Requests domain (PR 11).
 *
 * A material request is a real, tracked procurement-side record: "we need
 * 20m of 25mm conduit on 100 Arthur by Friday." Mirrors snags/observations
 * conventions (top-level blob, .passthrough() on items, denormalised
 * area/task labels, server-owned status + actor stamps).
 *
 * Why a top-level `material-requests.json` blob (same shape as
 * `observations.json` and `employees.json`):
 *   - The inbox is cross-job by design — a single doc beats fan-out.
 *   - A brand-new blob can't corrupt existing job / evidence / snag /
 *     observation data.
 *   - Whole-doc rewrite race is bounded at SME-procurement volume; per-
 *     record split is Phase F+.
 *
 * Relationship to the legacy `/admin/materials` (takeoff + PO + invoice
 * match) is intentional and documented in
 * `docs/architecture/material-requests.md` — the legacy module owns
 * structured takeoff procurement; this module owns the **field-to-office
 * request** loop (worker raised a "Need material" observation → office
 * converted it to a tracked request → procurement marks it ordered /
 * delivered). The two don't overlap and neither replaces the other yet.
 *
 * Cross-ref:
 *   src/domains/snags/schema.ts — direct precedent (status workflow + actor
 *     stamps + audit dual-emit)
 *   src/domains/observations/schema.ts — sibling field-to-office record
 *   docs/architecture/material-requests.md — module overview
 */

export const MATERIAL_REQUEST_STATUSES = [
  "requested",
  "approved",
  "ordered",
  "delivered",
  "cancelled",
] as const;
export const MaterialRequestStatusSchema = z.enum(MATERIAL_REQUEST_STATUSES);

export const MATERIAL_REQUEST_URGENCIES = ["low", "normal", "high", "urgent"] as const;
export const MaterialRequestUrgencySchema = z.enum(MATERIAL_REQUEST_URGENCIES);

export const MATERIAL_REQUEST_SOURCES = ["observation", "buhlos", "system"] as const;
export const MaterialRequestSourceSchema = z.enum(MATERIAL_REQUEST_SOURCES);

export const MATERIAL_REQUEST_STAGES = ["roughIn", "fitOff"] as const;
export const MaterialRequestStageSchema = z.enum(MATERIAL_REQUEST_STAGES);

export const MATERIAL_REQUEST_ITEM_MAX = 200;
export const MATERIAL_REQUEST_DESCRIPTION_MAX = 2000;
export const MATERIAL_REQUEST_NOTE_MAX = 1000;
export const MATERIAL_REQUEST_QUANTITY_MAX = 10_000_000;
export const MATERIAL_REQUEST_UNIT_MAX = 24;
export const MATERIAL_REQUEST_SUPPLIER_MAX = 120;
export const MATERIAL_REQUEST_ORDER_REF_MAX = 60;

/**
 * Full MaterialRequestItem as persisted in material-requests.json. Server
 * owns: id, status (defaults 'requested' on create), source, requestedBy{Id,
 * Name,Role}, requestedAt, createdAt, updatedAt. Lifecycle timestamps
 * (approvedAt, orderedAt, deliveredAt, cancelledAt) and the matching
 * *ById/*ByName flip as the status advances.
 */
export const MaterialRequestItemSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    /** Denormalised job name stamped on create (like observation.jobName). */
    jobName: z.string().nullable().optional(),

    // Body.
    item: z.string(),
    quantity: z.number(),
    unit: z.string(),
    description: z.string().nullable().optional(),

    // Lifecycle.
    status: MaterialRequestStatusSchema,
    urgency: MaterialRequestUrgencySchema,
    source: MaterialRequestSourceSchema,

    // Optional job context (denormalised display labels mirror snags).
    stage: MaterialRequestStageSchema.nullable().optional(),
    areaId: z.string().nullable().optional(),
    areaName: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    taskName: z.string().nullable().optional(),

    // Links to existing job rows (the legacy /admin/materials surface is
    // unrelated — those PO/invoice records live elsewhere).
    linkedObservationId: z.string().nullable().optional(),
    linkedEvidenceId: z.string().nullable().optional(),

    // Actor stamps.
    requestedById: z.string(),
    requestedByName: z.string(),
    requestedByRole: z.string().nullable().optional(),
    requestedAt: z.string(),

    approvedById: z.string().nullable().optional(),
    approvedByName: z.string().nullable().optional(),
    approvedAt: z.string().nullable().optional(),

    orderedById: z.string().nullable().optional(),
    orderedByName: z.string().nullable().optional(),
    orderedAt: z.string().nullable().optional(),
    supplier: z.string().nullable().optional(),
    supplierNote: z.string().nullable().optional(),
    orderRef: z.string().nullable().optional(),

    deliveredById: z.string().nullable().optional(),
    deliveredByName: z.string().nullable().optional(),
    deliveredAt: z.string().nullable().optional(),
    deliveryNote: z.string().nullable().optional(),

    cancelledById: z.string().nullable().optional(),
    cancelledByName: z.string().nullable().optional(),
    cancelledAt: z.string().nullable().optional(),
    cancelReason: z.string().nullable().optional(),

    auditLogIds: z.array(z.string()),

    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (data.status === "cancelled") {
      const reason = (data.cancelReason ?? "").trim();
      if (!reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cancelReason is required when status=cancelled",
          path: ["cancelReason"],
        });
      }
    }
  });

/**
 * Payload POSTed to /api/material-requests?jobId=<id> to create one
 * (admin-tier only — field workers raise the request via the
 * observation→material-request conversion path).
 */
export const CreateMaterialRequestPayloadSchema = z
  .object({
    item: z
      .string()
      .trim()
      .min(1, "item is required")
      .max(MATERIAL_REQUEST_ITEM_MAX, `Item must be ${MATERIAL_REQUEST_ITEM_MAX} characters or fewer`),
    quantity: z
      .number()
      .positive("quantity must be > 0")
      .max(MATERIAL_REQUEST_QUANTITY_MAX, `Quantity must be ≤ ${MATERIAL_REQUEST_QUANTITY_MAX}`),
    unit: z
      .string()
      .trim()
      .min(1, "unit is required")
      .max(MATERIAL_REQUEST_UNIT_MAX, `Unit must be ${MATERIAL_REQUEST_UNIT_MAX} characters or fewer`),
    description: z
      .string()
      .max(
        MATERIAL_REQUEST_DESCRIPTION_MAX,
        `Description must be ${MATERIAL_REQUEST_DESCRIPTION_MAX} characters or fewer`
      )
      .nullable()
      .optional(),

    urgency: MaterialRequestUrgencySchema.optional(),

    stage: MaterialRequestStageSchema.nullable().optional(),
    areaId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),

    linkedObservationId: z.string().nullable().optional(),
    linkedEvidenceId: z.string().nullable().optional(),
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
 * Payload PATCHed to /api/material-requests to update one (admin-tier only).
 * One coarse update endpoint covers all status transitions + supplier /
 * orderRef / cancelReason data — much simpler than a per-verb route, and
 * the audit-log captures the diff for free.
 */
export const UpdateMaterialRequestPayloadSchema = z
  .object({
    id: z.string().min(1, "id is required"),
    status: MaterialRequestStatusSchema.optional(),
    urgency: MaterialRequestUrgencySchema.optional(),
    supplier: z
      .string()
      .max(
        MATERIAL_REQUEST_SUPPLIER_MAX,
        `Supplier must be ${MATERIAL_REQUEST_SUPPLIER_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
    supplierNote: z
      .string()
      .max(
        MATERIAL_REQUEST_NOTE_MAX,
        `Supplier note must be ${MATERIAL_REQUEST_NOTE_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
    orderRef: z
      .string()
      .max(
        MATERIAL_REQUEST_ORDER_REF_MAX,
        `Order ref must be ${MATERIAL_REQUEST_ORDER_REF_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
    deliveryNote: z
      .string()
      .max(
        MATERIAL_REQUEST_NOTE_MAX,
        `Delivery note must be ${MATERIAL_REQUEST_NOTE_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
    cancelReason: z
      .string()
      .max(
        MATERIAL_REQUEST_NOTE_MAX,
        `Cancel reason must be ${MATERIAL_REQUEST_NOTE_MAX} characters or fewer`
      )
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    const touchesSomething =
      data.status !== undefined ||
      data.urgency !== undefined ||
      data.supplier !== undefined ||
      data.supplierNote !== undefined ||
      data.orderRef !== undefined ||
      data.deliveryNote !== undefined ||
      data.cancelReason !== undefined;
    if (!touchesSomething) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "update must change at least one field",
        path: ["id"],
      });
    }
    if (data.status === "cancelled") {
      const reason = (data.cancelReason ?? "").trim();
      if (!reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cancelReason is required when transitioning to cancelled",
          path: ["cancelReason"],
        });
      }
    }
  });

export const MaterialRequestListResponseSchema = z.object({
  requests: z.array(MaterialRequestItemSchema),
});

export const MaterialRequestMutationResponseSchema = z.object({
  request: MaterialRequestItemSchema,
});
