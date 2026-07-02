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
import { type DraftLine, type TakeoffInput } from "./ai-draft";

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

// ── #246: AI quote drafts ────────────────────────────────────────────────
// Both actions return the updated quote document; the additive `aiDraft`
// field rides through QuoteSchema's .passthrough() — read it with
// readAiDraft() from ./ai-draft. Error statuses the UI must surface
// honestly: 404 flag-dark, 503 AI unconfigured, 502 provider/JSON failure,
// 409 concurrent edit.

export function runAiQuoteDraft(
  quoteId: string,
  input: { sourceText: string; takeoff?: TakeoffInput }
): Promise<HttpResult<QuoteDetailResponse>> {
  return httpPost<QuoteDetailResponse>(
    `/api/quotes-v2?id=${encodeURIComponent(quoteId)}&action=ai-draft`,
    input,
    { schema: QuoteDetailResponseSchema, init: { credentials: "same-origin" } }
  );
}

export interface AiDraftReviewInput {
  suggestionId: string;
  decision: "accept" | "edit" | "reject";
  /** Required for decision 'edit' — replaces the proposed line content. */
  editedLine?: DraftLine;
  reviewNote?: string;
}

export function reviewAiQuoteDraftSuggestion(
  quoteId: string,
  input: AiDraftReviewInput
): Promise<HttpResult<QuoteDetailResponse>> {
  return httpPost<QuoteDetailResponse>(
    `/api/quotes-v2?id=${encodeURIComponent(quoteId)}&action=ai-draft-review`,
    input,
    { schema: QuoteDetailResponseSchema, init: { credentials: "same-origin" } }
  );
}
