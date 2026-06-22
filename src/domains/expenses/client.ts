import { httpGet, httpPatch, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateExpensePayloadSchema,
  ExpenseListResponseSchema,
  ExpenseMutationResponseSchema,
  ReceiptUploadResponseSchema,
  UpdateExpensePayloadSchema,
} from "./schema";
import type {
  CreateExpensePayload,
  ExpenseListResponse,
  ExpenseMutationResponse,
  ExpenseStatus,
  ReceiptUploadResponse,
  UpdateExpensePayload,
} from "./types";

/**
 * Typed wrapper around /api/expenses (#536).
 *
 *   POST  /api/expenses?action=upload-receipt  → receipt photo binary → { id, url }
 *   POST  /api/expenses                         → submit one (any staff/field; not client)
 *   GET   /api/expenses                         → admin: all; field/LH: own only
 *   PATCH /api/expenses  (id in body)           → review transition (admin only)
 *
 * Permissions + money validation are enforced server-side in api/expenses.js;
 * the client validates payloads against the schema first so invalid bodies
 * never hit the network (same pattern as snags/observations).
 */

export interface ExpenseListFilters {
  status?: ExpenseStatus;
  userId?: string;
}

function expensesUrl(filters: ExpenseListFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.userId) params.set("userId", filters.userId);
  const qs = params.toString();
  return qs ? `/api/expenses?${qs}` : "/api/expenses";
}

export function listExpenses(
  filters: ExpenseListFilters = {},
): Promise<HttpResult<ExpenseListResponse>> {
  return httpGet<ExpenseListResponse>(expensesUrl(filters), {
    schema: ExpenseListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/** Upload the receipt image (base64 data URL) → { id, url, capturedAt }. */
export function uploadReceiptPhoto(
  dataUrl: string,
): Promise<HttpResult<ReceiptUploadResponse>> {
  return httpPost<ReceiptUploadResponse>(
    "/api/expenses?action=upload-receipt",
    { dataUrl },
    {
      schema: ReceiptUploadResponseSchema,
      init: { credentials: "same-origin" },
      timeoutMs: 60_000,
    },
  );
}

export function submitExpense(
  payload: CreateExpensePayload,
): Promise<HttpResult<ExpenseMutationResponse>> {
  const parsed = CreateExpensePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: parsed.error.issues[0]?.message ?? "invalid expense",
      },
    });
  }
  return httpPost<ExpenseMutationResponse>("/api/expenses", parsed.data, {
    schema: ExpenseMutationResponseSchema,
    init: { credentials: "same-origin" },
    timeoutMs: 20_000,
  });
}

export function transitionExpense(
  payload: UpdateExpensePayload,
): Promise<HttpResult<ExpenseMutationResponse>> {
  const parsed = UpdateExpensePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: parsed.error.issues[0]?.message ?? "invalid update",
      },
    });
  }
  return httpPatch<ExpenseMutationResponse>("/api/expenses", parsed.data, {
    schema: ExpenseMutationResponseSchema,
    init: { credentials: "same-origin" },
    timeoutMs: 20_000,
  });
}
