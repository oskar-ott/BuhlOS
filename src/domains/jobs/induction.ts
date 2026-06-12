import { z } from "zod";
import { httpGet, httpPost, type HttpResult } from "@/lib/http";

/**
 * Per-job site induction register (#332) — contracts, pure state helper and
 * client verbs for /api/job-inductions.
 *
 * The flag (`job.inductionRequired`) stays the trigger; this module adds the
 * completion side: who confirmed, when, recorded by whom. Records are
 * append-only — the API returns the LATEST record per worker.
 */

export const InductionRecordSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    workerId: z.string(),
    workerName: z.string(),
    completedAt: z.string(),
    recordedBy: z.string(),
    recordedByName: z.string().optional(),
    note: z.string().nullable().optional(),
    backfill: z.boolean().optional(),
    /** Present on ?mine=1 history rows only. */
    jobName: z.string().optional(),
  })
  .passthrough();

export type InductionRecord = z.infer<typeof InductionRecordSchema>;

export const MyInductionResponseSchema = z.object({
  record: InductionRecordSchema.nullable(),
});

export const MyInductionHistoryResponseSchema = z.object({
  records: z.array(InductionRecordSchema),
});

export const CrewInductionStatusSchema = z.object({
  workerId: z.string(),
  workerName: z.string(),
  inducted: z.boolean(),
  completedAt: z.string().nullable(),
  backfill: z.boolean(),
  recordedByName: z.string().nullable().optional(),
});

export type CrewInductionStatus = z.infer<typeof CrewInductionStatusSchema>;

export const JobInductionsResponseSchema = z.object({
  records: z.array(InductionRecordSchema),
  crew: z.array(CrewInductionStatusSchema),
  inductionRequired: z.boolean(),
});

export const InductionMutationResponseSchema = z.object({
  record: InductionRecordSchema,
  already: z.boolean().optional(),
});

/**
 * The three-state truth for ONE worker on ONE job. Pure — feeds the site
 * card, the attention strip and the command model so they can never
 * disagree. `null` and `false` inductionRequired both mean not-required.
 */
export type InductionState = "not-required" | "required" | "done";

export function inductionStateFor(
  inductionRequired: boolean | null | undefined,
  myRecord: { completedAt: string } | null
): InductionState {
  if (!inductionRequired) return "not-required";
  return myRecord ? "done" : "required";
}

// ── Client verbs ──────────────────────────────────────────────────────────

export async function myInductionFor(
  jobId: string
): Promise<HttpResult<{ record: InductionRecord | null }>> {
  return httpGet(`/api/job-inductions?jobId=${encodeURIComponent(jobId)}&mine=1`, {
    schema: MyInductionResponseSchema,
  });
}

export async function myInductionHistory(): Promise<
  HttpResult<{ records: InductionRecord[] }>
> {
  return httpGet("/api/job-inductions?mine=1", {
    schema: MyInductionHistoryResponseSchema,
  });
}

export async function jobInductions(
  jobId: string
): Promise<HttpResult<z.infer<typeof JobInductionsResponseSchema>>> {
  return httpGet(`/api/job-inductions?jobId=${encodeURIComponent(jobId)}`, {
    schema: JobInductionsResponseSchema,
  });
}

/** Worker self-confirm — the session is the identity; double-tap idempotent. */
export async function confirmInduction(
  jobId: string,
  note?: string
): Promise<HttpResult<{ record: InductionRecord; already?: boolean }>> {
  return httpPost(
    "/api/job-inductions",
    { jobId, note },
    { schema: InductionMutationResponseSchema }
  );
}

/** Office backfill (admin tier) — paper/verbal reality, recordedBy retained. */
export async function recordInductionFor(
  jobId: string,
  workerId: string,
  note?: string
): Promise<HttpResult<{ record: InductionRecord }>> {
  return httpPost(
    "/api/job-inductions",
    { jobId, workerId, note },
    { schema: InductionMutationResponseSchema }
  );
}
