import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  ArchiveITPPayloadSchema,
  AttachITPPayloadSchema,
  ITPArchiveResponseSchema,
  ITPAttachResponseSchema,
  ITPListResponseSchema,
  ITPTransitionResponseSchema,
  RecordITPPointPayloadSchema,
  ReopenITPPayloadSchema,
  SignOffITPPayloadSchema,
} from "./schema";
import type {
  ArchiveITPPayload,
  AttachITPPayload,
  ITPArchiveResponse,
  ITPAttachResponse,
  ITPListResponse,
  ITPTransitionResponse,
  RecordITPPointPayload,
  ReopenITPPayload,
  SignOffITPPayload,
} from "./types";

/**
 * Typed wrapper around /api/job-itps (legacy ITP endpoint extended in E1).
 *
 *   GET    /api/job-itps?jobId=<id>                       → list instances
 *   POST   /api/job-itps?jobId=<id>&action=attach         → admin attaches a template
 *   POST   /api/job-itps?jobId=<id>&action=record         → worker records a point
 *   POST   /api/job-itps?jobId=<id>&action=signoff        → admin signs off
 *   POST   /api/job-itps?jobId=<id>&action=reopen         → admin reopens
 *   DELETE /api/job-itps?jobId=<id>&id=<instanceId>       → admin/LH archives
 *
 * Permissions are enforced server-side in api/job-itps.js:
 *   - unauthenticated    → 401 JSON
 *   - role=client        → 403 (unless viewing own job for GET — server-side)
 *   - non-admin worker   → only assigned jobs (canWrite gate on record;
 *                          canManageJob gate on attach / signoff / reopen /
 *                          archive)
 *   - sign-off           → admin only AND server-side independence rule
 *                          (server returns 409 if ratio > threshold and no
 *                           overrideJustification is supplied)
 *
 * Each client method validates the payload against the matching schema
 * before issuing fetch, so invalid bodies never hit the network — same
 * pattern as src/domains/snags/client.ts.
 *
 * Cross-ref:
 *   src/domains/snags/client.ts — precedent
 *   src/lib/http.ts — schema-validating fetch helper
 *   api/job-itps.js
 */

function itpsUrl(jobId: string, action?: string, id?: string): string {
  let url = `/api/job-itps?jobId=${encodeURIComponent(jobId)}`;
  if (action) url += `&action=${encodeURIComponent(action)}`;
  if (id) url += `&id=${encodeURIComponent(id)}`;
  return url;
}

export function listItps(
  jobId: string,
): Promise<HttpResult<ITPListResponse>> {
  return httpGet<ITPListResponse>(itpsUrl(jobId), {
    schema: ITPListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function attachItp(
  jobId: string,
  payload: AttachITPPayload,
): Promise<HttpResult<ITPAttachResponse>> {
  const parsed = AttachITPPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid attach payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<ITPAttachResponse>(itpsUrl(jobId, "attach"), parsed.data, {
    schema: ITPAttachResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function recordItpPoint(
  jobId: string,
  payload: RecordITPPointPayload,
): Promise<HttpResult<ITPTransitionResponse>> {
  const parsed = RecordITPPointPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid record payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<ITPTransitionResponse>(itpsUrl(jobId, "record"), parsed.data, {
    schema: ITPTransitionResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function signOffItp(
  jobId: string,
  payload: SignOffITPPayload,
): Promise<HttpResult<ITPTransitionResponse>> {
  const parsed = SignOffITPPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid signoff payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<ITPTransitionResponse>(itpsUrl(jobId, "signoff"), parsed.data, {
    schema: ITPTransitionResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function reopenItp(
  jobId: string,
  payload: ReopenITPPayload,
): Promise<HttpResult<ITPTransitionResponse>> {
  const parsed = ReopenITPPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid reopen payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<ITPTransitionResponse>(itpsUrl(jobId, "reopen"), parsed.data, {
    schema: ITPTransitionResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Soft-archive an instance via DELETE /api/job-itps?jobId=X&id=Y.
 *
 * Even though the wire shape uses DELETE + query params (no body), the
 * client takes a typed payload so the call site looks the same as the
 * other actions — easier to compose in the admin drawer.
 */
export function archiveItp(
  jobId: string,
  payload: ArchiveITPPayload,
): Promise<HttpResult<ITPArchiveResponse>> {
  const parsed = ArchiveITPPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid archive payload: ${parsed.error.message}`,
      },
    });
  }
  const url = itpsUrl(jobId, undefined, parsed.data.instanceId);
  return new Promise<HttpResult<ITPArchiveResponse>>((resolve) => {
    void fetch(url, {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (res) => {
        const text = await res.text();
        let body: unknown = null;
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        if (!res.ok) {
          resolve({
            ok: false,
            error: {
              status: res.status,
              body,
              message: res.statusText || "archive failed",
            },
          });
          return;
        }
        const validated = ITPArchiveResponseSchema.safeParse(body);
        if (!validated.success) {
          resolve({
            ok: false,
            error: {
              status: res.status,
              body,
              message: `response schema mismatch: ${validated.error.message}`,
            },
          });
          return;
        }
        resolve({ ok: true, data: validated.data });
      })
      .catch((err: unknown) => {
        resolve({
          ok: false,
          error: {
            status: 0,
            body: null,
            message: err instanceof Error ? err.message : "network error",
          },
        });
      });
  });
}

export const itpClient = {
  listItps,
  attachItp,
  recordItpPoint,
  signOffItp,
  reopenItp,
  archiveItp,
} as const;
