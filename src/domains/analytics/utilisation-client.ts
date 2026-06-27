import { z } from "zod";
import { httpGet, type HttpResult } from "@/lib/http";

/** Client for GET /api/utilisation (#342). Admin-tier only on the server. */

const WorkerWeekSchema = z.object({
  weekStart: z.string(),
  approvedHours: z.number(),
  submittedHours: z.number(),
  expectedHours: z.number().nullable(),
  pct: z.number().nullable(),
  excluded: z.boolean(),
});

export const UtilisationResponseSchema = z.object({
  weeks: z.array(z.string()),
  workers: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      weeks: z.array(WorkerWeekSchema),
      avgPct: z.number().nullable(),
    }),
  ),
  crew: z.object({
    weekStart: z.string().nullable(),
    expectedHours: z.number(),
    approvedHours: z.number(),
    submittedHours: z.number(),
    spareHours: z.number(),
    workers: z.number(),
  }),
  asOf: z.string(),
});
export type UtilisationResponse = z.infer<typeof UtilisationResponseSchema>;

export async function fetchUtilisation(weeks = 8): Promise<HttpResult<UtilisationResponse>> {
  return httpGet(`/api/utilisation?weeks=${encodeURIComponent(String(weeks))}`, {
    schema: UtilisationResponseSchema,
  });
}
