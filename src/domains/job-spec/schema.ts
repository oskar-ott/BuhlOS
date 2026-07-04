import { z } from "zod";

/**
 * Product spec (Job Builder redesign · Wave 3 — the missing half of the
 * prototype's "Spec & circuits" step; the Power/circuits half is the shipped
 * circuit schedule, src/domains/circuit-schedule).
 *
 * Per-system product lines — what exactly gets installed and who supplies it:
 *   system  e.g. "Power / GPOs", "Lighting", "Data & comms", "Smoke"
 *   line    qty · product (brand/model/cut-out/temp, free text) · supplier
 *           ("" = we supply; else e.g. "joiner supplies carcass")
 *   edgeNote per-system edge-case rule (e.g. "Anything not on E-201 rev C is
 *           a variation — flag it before you rough it in.")
 *
 * Storage: `job.productSpec` on the job record (rides JobSchema's passthrough,
 * exactly like switchboards/circuits — one GET /api/jobs?id=X carries it).
 * api/job-spec.js is the only writer. Office-only for now: Phil does not
 * consume this yet (the field sees tasks/materials, not the spec register).
 */

export const PRODUCT_SPEC_LIMITS = {
  systems: 40,
  linesPerSystem: 200,
  name: 80,
  product: 200,
  supplier: 120,
  edgeNote: 300,
} as const;

export const ProductSpecLineSchema = z.object({
  id: z.string(),
  /** Count of this item; null = not counted yet (honest absence, never 0-faked). */
  qty: z.number().int().min(0).max(100000).nullable(),
  /** Brand / model / cut-out / temp — free text, the sparky's language. */
  product: z.string().min(1).max(PRODUCT_SPEC_LIMITS.product),
  /** Who supplies. Empty string = we supply (the default). */
  supplier: z.string().max(PRODUCT_SPEC_LIMITS.supplier).default(""),
});
export type ProductSpecLine = z.infer<typeof ProductSpecLineSchema>;

export const ProductSpecSystemSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(PRODUCT_SPEC_LIMITS.name),
  /** Per-system edge-case rule shown with the lines. "" = none. */
  edgeNote: z.string().max(PRODUCT_SPEC_LIMITS.edgeNote).default(""),
  lines: z.array(ProductSpecLineSchema).max(PRODUCT_SPEC_LIMITS.linesPerSystem),
});
export type ProductSpecSystem = z.infer<typeof ProductSpecSystemSchema>;

export const ProductSpecSchema = z.array(ProductSpecSystemSchema).max(PRODUCT_SPEC_LIMITS.systems);
export type ProductSpec = z.infer<typeof ProductSpecSchema>;

/** GET/PUT /api/job-spec response — the persisted systems. */
export const JobSpecResponseSchema = z.object({
  systems: ProductSpecSchema,
});
export type JobSpecResponse = z.infer<typeof JobSpecResponseSchema>;
