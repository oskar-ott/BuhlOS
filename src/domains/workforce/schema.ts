import { z } from "zod";

/**
 * Worker licences & tickets (#331) — zod contracts for /api/licences.
 *
 * The store is kind-discriminated (`workforce/credentials.json`): v1 only
 * writes `kind: "licence"`, the training-records child (#336) adds
 * `kind: "training"` later — schemas stay passthrough so new kinds never
 * break old clients. `status`/`daysToExpiry` are COMPUTED server-side by
 * the one shared engine (api/_lib/licence-compliance.js); clients render
 * them, never re-derive.
 */

export const CredentialStatusSchema = z.enum([
  "current",
  "expiring",
  "expired",
  "no-expiry",
]);

export const CredentialSchema = z
  .object({
    id: z.string(),
    kind: z.string().optional(),
    userId: z.string(),
    userName: z.string().optional(),
    typeId: z.string(),
    label: z.string(),
    number: z.string().nullable().optional(),
    licenceClass: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    issueDate: z.string().nullable().optional(),
    expiryDate: z.string().nullable().optional(),
    status: CredentialStatusSchema,
    daysToExpiry: z.number().nullable(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const LicenceTypeSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export const CredentialListResponseSchema = z.object({
  credentials: z.array(CredentialSchema),
  types: z.array(LicenceTypeSchema),
  withinDays: z.number(),
  /** Admin list only: worst status per worker (renewal-aware, server-computed). */
  worstByUser: z.record(z.enum(["expired", "expiring", "ok"])).optional(),
});

export const CredentialMutationResponseSchema = z.object({
  credential: CredentialSchema,
});

export const CredentialRemoveResponseSchema = z.object({
  ok: z.boolean(),
  removedId: z.string(),
});

/** Add/update payloads (office tier). Dates are strict ISO; the API rejects
 *  anything unparseable at write. */
export const AddCredentialPayloadSchema = z.object({
  userId: z.string().min(1),
  typeId: z.string().min(1),
  label: z.string().optional(),
  number: z.string().nullable().optional(),
  licenceClass: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  issueDate: z.string().nullable().optional(),
  expiryDate: z.string().nullable().optional(),
});

export const UpdateCredentialPayloadSchema = AddCredentialPayloadSchema.partial().extend({
  id: z.string().min(1),
});
