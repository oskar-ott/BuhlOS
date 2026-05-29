import { httpGet, httpPatch, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateObservationPayloadSchema,
  ObservationConvertToSnagResponseSchema,
  ObservationListResponseSchema,
  ObservationMutationResponseSchema,
  UpdateObservationPayloadSchema,
} from "./schema";
import type {
  CreateObservationPayload,
  ObservationConvertToSnagResponse,
  ObservationListResponse,
  ObservationMutationResponse,
  ObservationPriority,
  ObservationStatus,
  ObservationType,
  UpdateObservationPayload,
} from "./types";

/**
 * Typed wrapper around /api/observations (PR 3).
 *
 *   GET   /api/observations                       → cross-job inbox (staff)
 *   GET   /api/observations?jobId=<id>            → one job's observations
 *   POST  /api/observations?jobId=<id>            → create one (canWrite)
 *   PATCH /api/observations  (id in body)         → triage/update (staff;
 *                                                    conversion = admin)
 *
 * Permissions are enforced server-side in api/observations.js — the client
 * validates the payload against the matching schema before fetch (invalid
 * bodies never hit the network), same pattern as snags/evidence clients.
 *
 * Cross-ref: src/domains/snags/client.ts, src/lib/http.ts, api/observations.js
 */

export interface ObservationListFilters {
  jobId?: string;
  status?: ObservationStatus;
  type?: ObservationType;
  priority?: ObservationPriority;
  /** Only observations still flagged as needing office action. */
  requiresAction?: boolean;
}

function observationsUrl(filters: ObservationListFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.jobId) params.set("jobId", filters.jobId);
  if (filters.status) params.set("status", filters.status);
  if (filters.type) params.set("type", filters.type);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.requiresAction) params.set("requiresAction", "true");
  const qs = params.toString();
  return qs ? `/api/observations?${qs}` : "/api/observations";
}

export function listObservations(
  filters: ObservationListFilters = {}
): Promise<HttpResult<ObservationListResponse>> {
  return httpGet<ObservationListResponse>(observationsUrl(filters), {
    schema: ObservationListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function listJobObservations(
  jobId: string
): Promise<HttpResult<ObservationListResponse>> {
  return listObservations({ jobId });
}

export function createObservation(
  jobId: string,
  payload: CreateObservationPayload
): Promise<HttpResult<ObservationMutationResponse>> {
  const parsed = CreateObservationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid observation payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<ObservationMutationResponse>(
    observationsUrl({ jobId }),
    parsed.data,
    {
      schema: ObservationMutationResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

export function updateObservation(
  payload: UpdateObservationPayload
): Promise<HttpResult<ObservationMutationResponse>> {
  const parsed = UpdateObservationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid observation update: ${parsed.error.message}`,
      },
    });
  }
  return httpPatch<ObservationMutationResponse>("/api/observations", parsed.data, {
    schema: ObservationMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * PR 6: convert an eligible observation into a real Snag.
 *
 *   POST /api/observations?action=convert-to-snag  (admin-tier)
 *
 * Eligible types by default: defect, safety, blocker. Other types can be
 * promoted with `force: true` (the office acknowledges they're stretching
 * the Snag workflow — RFI/Variation/Material-Request modules will own
 * those types when they exist).
 *
 * 201 → { observation, snag }; the observation now has linkedSnagId,
 * convertedTo='snag', convertedTargetId=snag.id, status='converted'.
 * 409 → already converted (idempotent).
 * 400 → invalid type + no force flag.
 * 404 → observation not found / 403 → not admin tier.
 */
export function convertObservationToSnag(
  payload: { id: string; force?: boolean }
): Promise<HttpResult<ObservationConvertToSnagResponse>> {
  if (!payload.id) {
    return Promise.resolve({
      ok: false,
      error: { status: 0, body: null, message: "id is required" },
    });
  }
  return httpPost<ObservationConvertToSnagResponse>(
    "/api/observations?action=convert-to-snag",
    { id: payload.id, ...(payload.force ? { force: true } : {}) },
    {
      schema: ObservationConvertToSnagResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

export const observationsClient = {
  listObservations,
  listJobObservations,
  createObservation,
  updateObservation,
  convertObservationToSnag,
} as const;
