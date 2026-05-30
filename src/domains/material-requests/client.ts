import { httpGet, httpPatch, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateMaterialRequestPayloadSchema,
  MaterialRequestListResponseSchema,
  MaterialRequestMutationResponseSchema,
  UpdateMaterialRequestPayloadSchema,
} from "./schema";
import type {
  CreateMaterialRequestPayload,
  MaterialRequestListResponse,
  MaterialRequestMutationResponse,
  MaterialRequestStatus,
  MaterialRequestUrgency,
  UpdateMaterialRequestPayload,
} from "./types";

/**
 * Typed wrapper around /api/material-requests (PR 11).
 *
 *   GET   /api/material-requests                       → cross-job inbox (admin)
 *   GET   /api/material-requests?jobId=<id>            → one job's requests
 *   POST  /api/material-requests?jobId=<id>            → create (admin)
 *   PATCH /api/material-requests   (id in body)        → triage/update (admin)
 *
 * Permissions enforced server-side. Client validates the payload against
 * the schema before fetch (same pattern as observations/snags clients).
 */

export interface MaterialRequestFilters {
  jobId?: string;
  status?: MaterialRequestStatus;
  urgency?: MaterialRequestUrgency;
}

function url(filters: MaterialRequestFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.jobId) params.set("jobId", filters.jobId);
  if (filters.status) params.set("status", filters.status);
  if (filters.urgency) params.set("urgency", filters.urgency);
  const qs = params.toString();
  return qs ? `/api/material-requests?${qs}` : "/api/material-requests";
}

export function listMaterialRequests(
  filters: MaterialRequestFilters = {}
): Promise<HttpResult<MaterialRequestListResponse>> {
  return httpGet<MaterialRequestListResponse>(url(filters), {
    schema: MaterialRequestListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function listJobMaterialRequests(
  jobId: string
): Promise<HttpResult<MaterialRequestListResponse>> {
  return listMaterialRequests({ jobId });
}

export function createMaterialRequest(
  jobId: string,
  payload: CreateMaterialRequestPayload
): Promise<HttpResult<MaterialRequestMutationResponse>> {
  const parsed = CreateMaterialRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid material request payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<MaterialRequestMutationResponse>(url({ jobId }), parsed.data, {
    schema: MaterialRequestMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function updateMaterialRequest(
  payload: UpdateMaterialRequestPayload
): Promise<HttpResult<MaterialRequestMutationResponse>> {
  const parsed = UpdateMaterialRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid material request update: ${parsed.error.message}`,
      },
    });
  }
  return httpPatch<MaterialRequestMutationResponse>("/api/material-requests", parsed.data, {
    schema: MaterialRequestMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export const materialRequestsClient = {
  listMaterialRequests,
  listJobMaterialRequests,
  createMaterialRequest,
  updateMaterialRequest,
} as const;
