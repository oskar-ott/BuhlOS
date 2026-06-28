import { z } from "zod";
import { httpDelete, httpGet, httpPatch, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateServiceLocationPayloadSchema,
  ServiceLocationListResponseSchema,
  ServiceLocationResponseSchema,
  UpdateServiceLocationPayloadSchema,
} from "./schema";
import type {
  CreateServiceLocationPayload,
  ServiceLocationListResponse,
  ServiceLocationResponse,
  UpdateServiceLocationPayload,
} from "./types";

/**
 * Typed wrapper around /api/services-locations (#230).
 *
 *   GET    /api/services-locations?jobId=<id>            → list
 *   POST   /api/services-locations?jobId=<id>            → add
 *   PATCH  /api/services-locations?jobId=<id>&id=<rid>   → edit
 *   DELETE /api/services-locations?jobId=<id>&id=<rid>   → remove
 *
 * Permissions are enforced server-side in api/services-locations.js:
 *   - client                       → 403 (always)
 *   - GET                          → any reader with job access
 *   - POST  (admin + assigned LH/field)
 *   - PATCH/DELETE (admin + assigned LH)
 *
 * The client validates the payload against the matching schema before issuing
 * fetch, so invalid bodies never hit the network — same pattern as
 * src/domains/snags/client.ts.
 */

const OkResponseSchema = z.object({ ok: z.boolean() }).passthrough();

function baseUrl(jobId: string): string {
  return `/api/services-locations?jobId=${encodeURIComponent(jobId)}`;
}

export function listServiceLocations(
  jobId: string,
): Promise<HttpResult<ServiceLocationListResponse>> {
  return httpGet<ServiceLocationListResponse>(baseUrl(jobId), {
    schema: ServiceLocationListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function createServiceLocation(
  jobId: string,
  payload: CreateServiceLocationPayload,
): Promise<HttpResult<ServiceLocationResponse>> {
  const parsed = CreateServiceLocationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid service-location payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<ServiceLocationResponse>(baseUrl(jobId), parsed.data, {
    schema: ServiceLocationResponseSchema,
    init: { credentials: "same-origin" },
    timeoutMs: 15000,
  });
}

export function updateServiceLocation(
  jobId: string,
  id: string,
  payload: UpdateServiceLocationPayload,
): Promise<HttpResult<ServiceLocationResponse>> {
  const parsed = UpdateServiceLocationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid service-location payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPatch<ServiceLocationResponse>(
    `${baseUrl(jobId)}&id=${encodeURIComponent(id)}`,
    { ...parsed.data, id },
    {
      schema: ServiceLocationResponseSchema,
      init: { credentials: "same-origin" },
      timeoutMs: 15000,
    },
  );
}

export function deleteServiceLocation(
  jobId: string,
  id: string,
): Promise<HttpResult<{ ok: boolean }>> {
  return httpDelete<{ ok: boolean }>(`${baseUrl(jobId)}&id=${encodeURIComponent(id)}`, {
    schema: OkResponseSchema,
    init: { credentials: "same-origin" },
    timeoutMs: 15000,
  });
}
