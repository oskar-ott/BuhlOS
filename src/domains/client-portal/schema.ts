import { z } from "zod";

/**
 * Response schemas for the sanitised client portal endpoints (#271 / Epic 16).
 *
 * These mirror the allowlist enforced server-side in
 * api/_lib/portal-projection.js. Parsing the portal responses through these
 * schemas gives the /portal pages a typed, defensive contract: an unexpected
 * shape degrades to an error state rather than rendering garbage, and the
 * allowlist is documented in exactly two places that must agree (the JS
 * projection + this schema).
 */

export const PortalJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  siteAddress: z.string().nullable(),
  status: z.string(),
  // Overall completion %, or null when the job has no checklist yet
  // (render "not started", never a fake 0%).
  progressPct: z.number().nullable(),
  stageLabel: z.string(),
});

export type PortalJob = z.infer<typeof PortalJobSchema>;

export const PortalJobsResponseSchema = z.object({
  count: z.number(),
  jobs: z.array(PortalJobSchema),
});

export const PortalJobResponseSchema = z.object({
  job: PortalJobSchema,
});
