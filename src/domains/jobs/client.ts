import { httpGet, type HttpResult } from "@/lib/http";
import {
  JobDetailResponseSchema,
  JobListResponseSchema,
} from "./schema";
import type { JobDetailResponse, JobListResponse } from "./types";

/**
 * Typed wrapper around /api/jobs (legacy endpoint). Phase D1 is read-only:
 *
 *   GET /api/jobs          → list (server filters to assignedJobIds for non-admin)
 *   GET /api/jobs?id=<id>  → single (server enforces visibility per row)
 *
 * Permissions are enforced server-side in api/jobs.js:174-195. The client
 * does not re-filter; the worker simply gets back what they're allowed to see.
 *
 * Cross-ref:
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §3 + §5
 *   src/domains/gear/client.ts (precedent — same shape, same HttpResult flow)
 *   api/jobs.js
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

export const jobsClient = {
  listJobs,
  getJobDetail,
} as const;
