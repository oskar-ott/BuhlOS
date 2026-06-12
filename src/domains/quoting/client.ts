import { httpDelete, httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  QuoteCreateInputSchema,
  QuoteDetailResponseSchema,
  QuoteListResponseSchema,
  QuoteSaveInputSchema,
  type QuoteCreateInput,
  type QuoteDetailResponse,
  type QuoteListResponse,
  type QuoteSaveInput,
} from "./schema";

/**
 * Typed wrapper around /api/quotes-v2 (#183) — the v2 quoting endpoint built
 * per the #172 MIGRATE-BY-REBUILD ruling. This client NEVER talks to the
 * legacy /api/quotes module.
 *
 * Auth, validation, totals recompute and the 409 stale-save contract are all
 * enforced server-side in api/quotes-v2.js; outgoing writes are .safeParse()d
 * first so a malformed payload fails fast and locally (jobs client pattern).
 *
 * A stale PUT returns 409 with the CURRENT server document in the error body
 * — callers parse it with QuoteConflictResponseSchema to offer "load latest".
 */

export function listQuotes(): Promise<HttpResult<QuoteListResponse>> {
  return httpGet<QuoteListResponse>("/api/quotes-v2", {
    schema: QuoteListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function getQuote(quoteId: string): Promise<HttpResult<QuoteDetailResponse>> {
  return httpGet<QuoteDetailResponse>(`/api/quotes-v2?id=${encodeURIComponent(quoteId)}`, {
    schema: QuoteDetailResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export async function createQuote(
  input: QuoteCreateInput
): Promise<HttpResult<QuoteDetailResponse>> {
  const parsed = QuoteCreateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { status: 0, body: null, message: parsed.error.issues[0]?.message ?? "invalid input" },
    };
  }
  return httpPost<QuoteDetailResponse>("/api/quotes-v2", parsed.data, {
    schema: QuoteDetailResponseSchema,
    init: { credentials: "same-origin" },
  });
}

/** Full-document save. `input.updatedAt` must echo the loaded document's
 *  value — the server 409s when the stored document has moved. */
export async function saveQuote(
  quoteId: string,
  input: QuoteSaveInput
): Promise<HttpResult<QuoteDetailResponse>> {
  const parsed = QuoteSaveInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: { status: 0, body: null, message: parsed.error.issues[0]?.message ?? "invalid input" },
    };
  }
  return httpPut<QuoteDetailResponse>(`/api/quotes-v2?id=${encodeURIComponent(quoteId)}`, parsed.data, {
    schema: QuoteDetailResponseSchema,
    init: { credentials: "same-origin" },
  });
}

/** Archive (server-side status flip — never destructive). */
export function archiveQuote(quoteId: string): Promise<HttpResult<QuoteDetailResponse>> {
  return httpDelete<QuoteDetailResponse>(`/api/quotes-v2?id=${encodeURIComponent(quoteId)}`, {
    schema: QuoteDetailResponseSchema,
    init: { credentials: "same-origin" },
  });
}
