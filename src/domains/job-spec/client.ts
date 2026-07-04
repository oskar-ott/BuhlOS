import { httpGet, httpPut, type HttpResult } from "@/lib/http";
import {
  JobSpecResponseSchema,
  type JobSpecResponse,
  type ProductSpecSystem,
} from "./schema";

/**
 * Typed client for /api/job-spec — the product-spec register on a job
 * (Job Builder redesign · Wave 3). GET is job-visible; PUT is canManageJob
 * (server-enforced). The PUT replaces the systems wholesale; the server
 * preserves ids for systems/lines it still receives by id-match and mints
 * ids for new ones (the job-circuits contract).
 */

function url(jobId: string): string {
  return `/api/job-spec?jobId=${encodeURIComponent(jobId)}`;
}

export function getJobSpec(jobId: string): Promise<HttpResult<JobSpecResponse>> {
  return httpGet<JobSpecResponse>(url(jobId), {
    schema: JobSpecResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function saveJobSpec(
  jobId: string,
  systems: ProductSpecSystem[],
): Promise<HttpResult<JobSpecResponse>> {
  return httpPut<JobSpecResponse>(url(jobId), { systems }, {
    schema: JobSpecResponseSchema,
    init: { credentials: "same-origin" },
    timeoutMs: 15000,
  });
}
