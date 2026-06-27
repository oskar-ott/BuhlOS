import { z } from "zod";
import { httpGet, httpPost, type HttpResult } from "@/lib/http";

/**
 * Client for /api/job-closeout (#349). Admin-tier only on the server. Money is
 * integer cents (use formatMoneyCents from profitability-client to render).
 */

export const CloseoutSnapshotSchema = z.object({
  version: z.number(),
  closedAt: z.string().optional().nullable(),
  closedBy: z.string().optional().nullable(),
  closedByName: z.string().optional().nullable(),
  backfilled: z.boolean(),
  fromStatus: z.string().optional().nullable(),
  revenue: z.object({
    contractValueCents: z.number().nullable(),
    claimedToDateCents: z.number().nullable(),
  }),
  labour: z.object({
    hoursTotal: z.number(),
    costCents: z.number(),
    estimateCents: z.number().nullable(),
    varianceCents: z.number().nullable(),
    unratedWorkers: z.array(z.string()),
  }),
  material: z.object({ costCents: z.number(), source: z.string() }),
  margin: z.object({ cents: z.number().nullable(), pct: z.number().nullable() }),
  duration: z.object({
    startDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    firstActivity: z.string().nullable(),
    lastActivity: z.string().nullable(),
    plannedDays: z.number().nullable(),
    actualDays: z.number().nullable(),
  }),
  snags: z.object({
    opened: z.number(),
    closed: z.number(),
    openNow: z.number(),
    meanDaysToClose: z.number().nullable(),
  }),
  badges: z.array(z.string()),
});
export type CloseoutSnapshot = z.infer<typeof CloseoutSnapshotSchema>;

export const CloseoutStatusResponseSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  latest: CloseoutSnapshotSchema.nullable(),
  versionCount: z.number(),
});
export type CloseoutStatusResponse = z.infer<typeof CloseoutStatusResponseSchema>;

const CloseResponseSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  snapshot: CloseoutSnapshotSchema.optional(),
});

export async function closeoutStatus(jobId: string): Promise<HttpResult<CloseoutStatusResponse>> {
  return httpGet(`/api/job-closeout?jobId=${encodeURIComponent(jobId)}`, {
    schema: CloseoutStatusResponseSchema,
  });
}

export async function closeOutJob(jobId: string): Promise<HttpResult<z.infer<typeof CloseResponseSchema>>> {
  return httpPost(`/api/job-closeout?jobId=${encodeURIComponent(jobId)}&action=close`, {}, {
    schema: CloseResponseSchema,
    timeoutMs: 20000,
  });
}

export async function reopenJob(jobId: string): Promise<HttpResult<z.infer<typeof CloseResponseSchema>>> {
  return httpPost(`/api/job-closeout?jobId=${encodeURIComponent(jobId)}&action=reopen`, {}, {
    schema: CloseResponseSchema,
    timeoutMs: 15000,
  });
}
