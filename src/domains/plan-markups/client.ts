import { httpGet, httpPost, httpPatch, httpDelete, type HttpResult, type HttpError } from "@/lib/http";
import {
  CreateMarkupPayloadSchema,
  MarkupListResponseSchema,
  MarkupMutationResponseSchema,
  UpdateMarkupPayloadSchema,
} from "./schema";
import type {
  CreateMarkupPayload,
  MarkupListResponse,
  MarkupMutationResponse,
  UpdateMarkupPayload,
} from "./types";

/**
 * Typed wrapper around the legacy-style serverless endpoint /api/plan-markups.
 *
 *   GET    /api/plan-markups?jobId=&planId=&page=  → list (server scopes by role)
 *   POST   /api/plan-markups?jobId=                → create  (manage only)
 *   PATCH  /api/plan-markups?jobId=&id=            → update  (manage only)
 *   DELETE /api/plan-markups?jobId=&id=            → archive (manage only, soft)
 *
 * Permissions + validation are enforced server-side (api/plan-markups.js):
 * field workers get only visibleToPhil non-archived records and cannot write;
 * the client `.safeParse()`s outgoing bodies so a malformed request fails fast
 * and locally instead of as a 400 round-trip.
 */

const sameOrigin = { cache: "no-store", credentials: "same-origin" } as const;

function badPayload<T>(message: string, body: unknown): HttpResult<T> {
  return { ok: false, error: { status: 0, body, message } };
}

export function errorText(err: HttpError): string {
  if (err.body && typeof err.body === "object" && "error" in err.body) {
    const e = (err.body as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return err.message || "Something went wrong";
}

/**
 * List markups for a plan. `pageIndex` omitted → every page of the plan (the
 * viewer fetches once per plan and filters per page client-side); provided →
 * that page only. The server still scopes by role (field = visibleToPhil only).
 */
export function listMarkups(
  jobId: string,
  planId: string,
  pageIndex?: number,
): Promise<HttpResult<MarkupListResponse>> {
  const params: Record<string, string> = { jobId, planId };
  if (typeof pageIndex === "number") params.page = String(pageIndex);
  const qs = new URLSearchParams(params).toString();
  return httpGet<MarkupListResponse>(`/api/plan-markups?${qs}`, {
    schema: MarkupListResponseSchema,
    init: { ...sameOrigin },
  });
}

export function createMarkup(
  payload: CreateMarkupPayload,
): Promise<HttpResult<MarkupMutationResponse>> {
  const parsed = CreateMarkupPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve(badPayload(parsed.error.issues.map((i) => i.message).join("; "), payload));
  }
  return httpPost<MarkupMutationResponse>(
    `/api/plan-markups?jobId=${encodeURIComponent(payload.jobId)}`,
    parsed.data,
    { schema: MarkupMutationResponseSchema, init: { ...sameOrigin } },
  );
}

export function updateMarkup(
  jobId: string,
  id: string,
  patch: UpdateMarkupPayload,
): Promise<HttpResult<MarkupMutationResponse>> {
  const parsed = UpdateMarkupPayloadSchema.safeParse(patch);
  if (!parsed.success) {
    return Promise.resolve(badPayload(parsed.error.issues.map((i) => i.message).join("; "), patch));
  }
  const qs = new URLSearchParams({ jobId, id }).toString();
  return httpPatch<MarkupMutationResponse>(`/api/plan-markups?${qs}`, parsed.data, {
    schema: MarkupMutationResponseSchema,
    init: { ...sameOrigin },
  });
}

/** Soft-archive (DELETE = archived:true server-side; the record is preserved). */
export function archiveMarkup(
  jobId: string,
  id: string,
): Promise<HttpResult<MarkupMutationResponse>> {
  const qs = new URLSearchParams({ jobId, id }).toString();
  return httpDelete<MarkupMutationResponse>(`/api/plan-markups?${qs}`, {
    schema: MarkupMutationResponseSchema,
    init: { ...sameOrigin },
  });
}

export const planMarkupsClient = {
  listMarkups,
  createMarkup,
  updateMarkup,
  archiveMarkup,
} as const;
