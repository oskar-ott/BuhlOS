import { httpGet, httpPost, httpPatch, type HttpResult, type HttpError } from "@/lib/http";
import {
  EmployeeListResponseSchema,
  EmployeeDetailResponseSchema,
  EmployeeMutationResponseSchema,
  CreateEmployeePayloadSchema,
  UpdateEmployeePayloadSchema,
  IssueInvitePayloadSchema,
  DisableEmployeePayloadSchema,
} from "./schema";
import type {
  EmployeeListResponse,
  EmployeeDetailResponse,
  EmployeeMutationResponse,
  CreateEmployeePayload,
  UpdateEmployeePayload,
  IssueInvitePayload,
  DisableEmployeePayload,
} from "./types";

/**
 * Typed wrapper around the legacy /api/employees endpoint (added in O1,
 * api/employees.js). Every call returns an HttpResult so callers branch on
 * success vs typed failure without throws — same shape as the gear client.
 *
 * Endpoints consumed (all admin-gated server-side):
 *   GET   /api/employees                          → register list
 *   GET   /api/employees?id=<id>                  → one employee + invite
 *   POST  /api/employees                          → create (+ optional invite)
 *   PATCH /api/employees?id=<id>                  → update role/details/jobs/gear
 *   POST  /api/employees?action=invite&id=<id>    → issue / resend invite
 *   POST  /api/employees?action=disable&id=<id>   → soft-disable (reversible)
 *
 * The plaintext invite link is returned ONLY on create / invite, once, for the
 * copy-link fallback — never persisted, never returned by any GET.
 */

const sameOrigin = { cache: "no-store", credentials: "same-origin" } as const;

function badPayload<T>(message: string, body: unknown): HttpResult<T> {
  return { ok: false, error: { status: 0, body, message } };
}

/**
 * Friendly error text from a failed HttpResult. The legacy API returns
 * `{ error: "..." }`; httpGet/httpPost surface the HTTP status text in
 * `message` and the JSON body in `body`, so prefer the body's `error` field
 * (e.g. the duplicate-email message) over the bare "Conflict"/"Bad Request".
 */
export function errorText(err: HttpError): string {
  if (err.body && typeof err.body === "object" && "error" in err.body) {
    const e = (err.body as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return err.message || "Something went wrong";
}

/** The existing employee id carried on a duplicate-email 409, if present. */
export function existingEmployeeIdFrom(err: HttpError): string | null {
  if (err.body && typeof err.body === "object" && "existingEmployeeId" in err.body) {
    const v = (err.body as { existingEmployeeId?: unknown }).existingEmployeeId;
    if (typeof v === "string") return v;
  }
  return null;
}

export function listEmployees(): Promise<HttpResult<EmployeeListResponse>> {
  return httpGet<EmployeeListResponse>("/api/employees", {
    schema: EmployeeListResponseSchema,
    init: { ...sameOrigin },
  });
}

export function getEmployee(id: string): Promise<HttpResult<EmployeeDetailResponse>> {
  return httpGet<EmployeeDetailResponse>(
    `/api/employees?id=${encodeURIComponent(id)}`,
    { schema: EmployeeDetailResponseSchema, init: { ...sameOrigin } }
  );
}

export function createEmployee(
  payload: CreateEmployeePayload
): Promise<HttpResult<EmployeeMutationResponse>> {
  const parsed = CreateEmployeePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve(
      badPayload(parsed.error.issues.map((i) => i.message).join("; "), parsed.error.format())
    );
  }
  return httpPost<EmployeeMutationResponse>("/api/employees", parsed.data, {
    schema: EmployeeMutationResponseSchema,
    init: { ...sameOrigin },
  });
}

export function updateEmployee(
  payload: UpdateEmployeePayload
): Promise<HttpResult<EmployeeMutationResponse>> {
  const parsed = UpdateEmployeePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve(
      badPayload(parsed.error.issues.map((i) => i.message).join("; "), parsed.error.format())
    );
  }
  return httpPatch<EmployeeMutationResponse>(
    `/api/employees?id=${encodeURIComponent(parsed.data.id)}`,
    parsed.data,
    { schema: EmployeeMutationResponseSchema, init: { ...sameOrigin } }
  );
}

export function issueInvite(
  payload: IssueInvitePayload
): Promise<HttpResult<EmployeeMutationResponse>> {
  const parsed = IssueInvitePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve(
      badPayload(parsed.error.issues.map((i) => i.message).join("; "), parsed.error.format())
    );
  }
  return httpPost<EmployeeMutationResponse>(
    `/api/employees?action=invite&id=${encodeURIComponent(parsed.data.id)}`,
    parsed.data,
    { schema: EmployeeMutationResponseSchema, init: { ...sameOrigin } }
  );
}

export function revokeInvite(id: string): Promise<HttpResult<EmployeeMutationResponse>> {
  if (!id) return Promise.resolve(badPayload("id required", null));
  return httpPost<EmployeeMutationResponse>(
    `/api/employees?action=revoke&id=${encodeURIComponent(id)}`,
    { id },
    { schema: EmployeeMutationResponseSchema, init: { ...sameOrigin } }
  );
}

export function disableEmployee(
  payload: DisableEmployeePayload
): Promise<HttpResult<EmployeeMutationResponse>> {
  const parsed = DisableEmployeePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve(
      badPayload(parsed.error.issues.map((i) => i.message).join("; "), parsed.error.format())
    );
  }
  return httpPost<EmployeeMutationResponse>(
    `/api/employees?action=disable&id=${encodeURIComponent(parsed.data.id)}`,
    parsed.data,
    { schema: EmployeeMutationResponseSchema, init: { ...sameOrigin } }
  );
}

export const employeesClient = {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  issueInvite,
  revokeInvite,
  disableEmployee,
} as const;
