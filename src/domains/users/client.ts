import { httpGet, httpPut, type HttpResult, type HttpError } from "@/lib/http";
import { UsersListResponseSchema, UserMutationResponseSchema } from "./schema";
import type { UsersListResponse, UserMutationResponse } from "./types";

/**
 * Typed wrapper around the legacy `/api/users` endpoint for job assignment.
 *
 * Both calls are admin-tier-gated server-side (api/users.js: GET + PUT run
 * behind `requireAuth(..., { roles: ['admin'] })`, which PR #63 made
 * tier-aware so office/boss/pm also pass). A field worker hitting either is
 * 403'd by the API — the panel is additionally only reachable from the
 * admin-only /v2/jobs/[jobId]/builder route.
 *
 *   GET /api/users  → every account, passwordHash stripped (we filter to
 *                     assignable field/LH workers client-side).
 *   PUT /api/users  → REPLACES one user's assignedJobIds. Callers must send the
 *                     full toggled array (see domains/users/assignment.ts) so a
 *                     worker's other jobs are preserved.
 */

const sameOrigin = { cache: "no-store", credentials: "same-origin" } as const;

export function listUserAccounts(): Promise<HttpResult<UsersListResponse>> {
  return httpGet<UsersListResponse>("/api/users", {
    schema: UsersListResponseSchema,
    init: { ...sameOrigin },
  });
}

/**
 * Replace one user's assignedJobIds. `assignedJobIds` must already be the full
 * intended array for that user (other jobs preserved) — compute it with
 * computeAssignedJobIds() rather than passing a single id.
 */
export function setAssignedJobIds(
  id: string,
  assignedJobIds: ReadonlyArray<string>
): Promise<HttpResult<UserMutationResponse>> {
  return httpPut<UserMutationResponse>(
    "/api/users",
    { id, assignedJobIds: [...assignedJobIds] },
    { schema: UserMutationResponseSchema, init: { ...sameOrigin } }
  );
}

/** Friendly text from a failed HttpResult — prefer the API's `{ error }` body. */
export function errorText(err: HttpError): string {
  if (err.body && typeof err.body === "object" && "error" in err.body) {
    const e = (err.body as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return err.message || "Something went wrong";
}

export const usersClient = {
  listUserAccounts,
  setAssignedJobIds,
} as const;
