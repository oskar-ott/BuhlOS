import { httpGet, httpPost, type HttpResult, type HttpError } from "@/lib/http";
import {
  ResolveInviteResponseSchema,
  AcceptInviteResponseSchema,
  AcceptInvitePayloadSchema,
} from "./schema";
import type {
  ResolveInviteResponse,
  AcceptInviteResponse,
  AcceptInvitePayload,
} from "./types";

/**
 * Typed client for the worker invite flow (O3, api/invites.js). The landing
 * page resolves the token server-side (no flicker, bible P1); this client is
 * used by the client-side setup flow to accept. Every call returns an
 * HttpResult — no throws.
 *
 *   GET  /api/invites?action=resolve&token=…   → safe landing payload + state
 *   POST /api/invites?action=accept            → confirm + create 4-digit PIN
 *
 * The plaintext token lives only in the URL the worker already holds; it is
 * never returned by these calls, never stored, never logged.
 */

const sameOrigin = { cache: "no-store", credentials: "same-origin" } as const;

export function resolveInvite(token: string): Promise<HttpResult<ResolveInviteResponse>> {
  return httpGet<ResolveInviteResponse>(
    `/api/invites?action=resolve&token=${encodeURIComponent(token)}`,
    { schema: ResolveInviteResponseSchema, init: { ...sameOrigin } }
  );
}

export function acceptInvite(
  payload: AcceptInvitePayload
): Promise<HttpResult<AcceptInviteResponse>> {
  const parsed = AcceptInvitePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.format(),
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }
  return httpPost<AcceptInviteResponse>("/api/invites?action=accept", parsed.data, {
    schema: AcceptInviteResponseSchema,
    init: { ...sameOrigin },
  });
}

/** Friendly error text from a failed accept (server returns { error }). */
export function acceptErrorText(err: HttpError): string {
  if (err.body && typeof err.body === "object" && "error" in err.body) {
    const e = (err.body as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return err.message || "Something went wrong";
}

export const inviteClient = { resolveInvite, acceptInvite } as const;
