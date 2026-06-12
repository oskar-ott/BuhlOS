import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateSnagPayloadSchema,
  SnagCreateResponseSchema,
  SnagListResponseSchema,
  SnagTransitionResponseSchema,
  TransitionSnagPayloadSchema,
} from "./schema";
import { BulkCloseSnagsResponseSchema, type BulkCloseSnagsResponse } from "./register";
import type {
  CreateSnagPayload,
  SnagCreateResponse,
  SnagListResponse,
  SnagTransitionResponse,
  TransitionSnagPayload,
} from "./types";

/**
 * Typed wrapper around /api/snags (D.5 endpoint).
 *
 *   GET  /api/snags?jobId=<id>                       → list snags for a job
 *   POST /api/snags?jobId=<id>                       → create one snag
 *   POST /api/snags?jobId=<id>&action=transition     → move to a new status
 *
 * Permissions are enforced server-side in api/snags.js:
 *   - unauthenticated         → 401 JSON
 *   - role=client             → 403 JSON
 *   - non-admin worker        → only assigned jobs (per assignedJobIds)
 *   - admin                   → any job
 *   - transition action       → role-based (see canRoleTransition)
 *
 * The client validates the payload against the matching schema before
 * issuing fetch, so invalid bodies never hit the network — same
 * pattern as src/domains/evidence/client.ts.
 *
 * Cross-ref:
 *   src/domains/evidence/client.ts — precedent
 *   src/lib/http.ts — schema-validating fetch helper
 *   api/snags.js
 */

function snagsUrl(jobId: string, action?: string): string {
  const base = `/api/snags?jobId=${encodeURIComponent(jobId)}`;
  return action ? `${base}&action=${encodeURIComponent(action)}` : base;
}

export function listSnags(
  jobId: string
): Promise<HttpResult<SnagListResponse>> {
  return httpGet<SnagListResponse>(snagsUrl(jobId), {
    schema: SnagListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function createSnag(
  jobId: string,
  payload: CreateSnagPayload
): Promise<HttpResult<SnagCreateResponse>> {
  const parsed = CreateSnagPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid snag payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<SnagCreateResponse>(snagsUrl(jobId), parsed.data, {
    schema: SnagCreateResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function transitionSnag(
  jobId: string,
  payload: TransitionSnagPayload
): Promise<HttpResult<SnagTransitionResponse>> {
  const parsed = TransitionSnagPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid transition payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<SnagTransitionResponse>(snagsUrl(jobId, "transition"), parsed.data, {
    schema: SnagTransitionResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Bulk close snags on ONE job — backs the /defects register's bulk
 * action (#414). The endpoint is per-job by design (one atomic
 * read-modify-write of that job's data.json), so the register groups
 * its cross-job selection BY JOB and issues one call per job.
 *
 * Server enforces: staff only, canManageJob (admin any job / LH
 * assigned jobs), ≤100 ids, per-snag results (unknown ids reported in
 * failed[], never fatal). Both stores are closed with their own
 * semantics — see api/snags-bulk-close.js.
 */
export function bulkCloseSnags(
  jobId: string,
  snagIds: ReadonlyArray<string>
): Promise<HttpResult<BulkCloseSnagsResponse>> {
  return httpPost<BulkCloseSnagsResponse>(
    `/api/snags-bulk-close?jobId=${encodeURIComponent(jobId)}`,
    { snagIds: [...snagIds] },
    {
      schema: BulkCloseSnagsResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

export const snagsClient = {
  listSnags,
  createSnag,
  transitionSnag,
  bulkCloseSnags,
} as const;
