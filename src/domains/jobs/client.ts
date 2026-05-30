import { httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  JobCreateInputSchema,
  JobDetailResponseSchema,
  JobListResponseSchema,
  JobUpdateInputSchema,
} from "./schema";
import type {
  JobCreateInput,
  JobDetailResponse,
  JobListResponse,
  JobUpdateInput,
} from "./types";

/**
 * Typed wrapper around /api/jobs (legacy endpoint).
 *
 * Reads (Phase D1):
 *   GET /api/jobs          → list (server filters to assignedJobIds for non-admin)
 *   GET /api/jobs?id=<id>  → single (server enforces visibility per row)
 *
 * Writes (Job Builder — modern write path over the EXISTING handlers):
 *   POST /api/jobs         → create (admin only, server-side)
 *   PUT  /api/jobs         → update/patch (admin or LH-on-job, server-side)
 *   publishJob()           → PUT status:'active' — the draft→published flip
 *
 * Permissions + business rules are enforced server-side in api/jobs.js
 * (role gates, type-exists, id-uniqueness, field validation). The client
 * `.safeParse()`s the outgoing body first so a malformed request fails
 * fast and locally with a useful message instead of a 400 round-trip.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §3 + §5
 *   src/domains/jobs/builder.ts — payload builders + publish validation
 *   api/jobs.js — GET / POST / PUT handlers
 */

export function listJobs(): Promise<HttpResult<JobListResponse>> {
  return httpGet<JobListResponse>("/api/jobs", {
    schema: JobListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function getJobDetail(jobId: string): Promise<HttpResult<JobDetailResponse>> {
  return httpGet<JobDetailResponse>(
    `/api/jobs?id=${encodeURIComponent(jobId)}`,
    {
      schema: JobDetailResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

/**
 * Admin-editor read: include archived structural items so the Builder can
 * show (and un-archive) rooms/tasks the admin previously retired.
 * Mirrors api/jobs.js `?includeArchived=1`.
 */
export function getJobForEdit(jobId: string): Promise<HttpResult<JobDetailResponse>> {
  return httpGet<JobDetailResponse>(
    `/api/jobs?id=${encodeURIComponent(jobId)}&includeArchived=1`,
    {
      schema: JobDetailResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

/** Local schema-mismatch failure shaped like an HttpError so callers have
 *  one error channel to handle. status 0 = never left the client. */
function invalidPayload<T>(message: string, body: unknown): HttpResult<T> {
  return { ok: false, error: { status: 0, body, message } };
}

export function createJob(
  input: JobCreateInput
): Promise<HttpResult<JobDetailResponse>> {
  const parsed = JobCreateInputSchema.safeParse(input);
  if (!parsed.success) {
    return Promise.resolve(
      invalidPayload(`invalid create payload: ${parsed.error.message}`, input)
    );
  }
  return httpPost<JobDetailResponse>("/api/jobs", parsed.data, {
    schema: JobDetailResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function updateJob(
  input: JobUpdateInput
): Promise<HttpResult<JobDetailResponse>> {
  const parsed = JobUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    return Promise.resolve(
      invalidPayload(`invalid update payload: ${parsed.error.message}`, input)
    );
  }
  return httpPut<JobDetailResponse>("/api/jobs", parsed.data, {
    schema: JobDetailResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Publish a job to the field: flip status to 'active'. With the api/jobs.js
 * GET gate, a draft job is office-only (invisible to assigned field
 * workers) until this runs. Re-publishing an already-active job is a no-op
 * status write — safe to call on republish. Who/when is captured by the
 * existing job audit trail (api/jobs.js logs the status change).
 */
export function publishJob(jobId: string): Promise<HttpResult<JobDetailResponse>> {
  return updateJob({ id: jobId, status: "active" });
}

/** Send a published job back to draft (office-only) — pulls it from the
 *  field without archiving. */
export function unpublishJob(jobId: string): Promise<HttpResult<JobDetailResponse>> {
  return updateJob({ id: jobId, status: "draft" });
}

export const jobsClient = {
  listJobs,
  getJobDetail,
  getJobForEdit,
  createJob,
  updateJob,
  publishJob,
  unpublishJob,
} as const;
