import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateSnagPayloadSchema,
  SnagCreateResponseSchema,
  SnagListResponseSchema,
  SnagTransitionResponseSchema,
  TransitionSnagPayloadSchema,
} from "./schema";
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

export const snagsClient = {
  listSnags,
  createSnag,
  transitionSnag,
} as const;
