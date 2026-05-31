import { httpGet, httpPatch, httpPost, type HttpResult } from "@/lib/http";
import {
  ApproveTimeEntryPayloadSchema,
  CreateTimeEntryPayloadSchema,
  PatchTimeEntryPayloadSchema,
  RejectTimeEntryPayloadSchema,
  TimeEntryListResponseSchema,
  TimeEntryMutationResponseSchema,
  TimeEntryOverviewResponseSchema,
  TodayPulseResponseSchema,
} from "./schema";
import type {
  ApproveTimeEntryPayload,
  CreateTimeEntryPayload,
  PatchTimeEntryPayload,
  RejectTimeEntryPayload,
  TimeEntryListResponse,
  TimeEntryMutationResponse,
  TimeEntryOverviewResponse,
  TodayPulseResponse,
} from "./types";

/**
 * Typed wrapper around /api/time-entries* (per ADR-002, the legacy endpoints
 * are consumed verbatim — no new endpoint is written in Phase B). Every call
 * returns an HttpResult so callers can branch on success vs typed failure
 * without throws.
 *
 * Endpoints consumed:
 *   GET    /api/time-entries                              → list own entries
 *   GET    /api/time-entries?scope=approver&status=...    → admin/LH queue
 *   GET    /api/time-entries-overview?fromDate=&toDate=   → admin/LH rollup + missing
 *   POST   /api/time-entries                              → create draft / submit
 *   PATCH  /api/time-entries?date=YYYY-MM-DD              → edit own draft/rejected
 *   POST   /api/time-entries-approve                      → approve a submitted entry
 *   POST   /api/time-entries-reject                       → reject with reason
 *
 * Cross-ref: docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §API
 *            api/time-entries.js / api/time-entries-approve.js / api/time-entries-reject.js
 *            api/time-entries-overview.js
 */

interface ListEntriesOptions {
  userId?: string;
  fromDate?: string;
  toDate?: string;
  status?: "draft" | "submitted" | "approved" | "rejected";
}

function buildQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

/**
 * GET /api/time-entries — list the current user's own entries (newest first).
 * Admin or LH may pass `userId` to view another user's entries.
 */
export function listOwnEntries(
  options: ListEntriesOptions = {}
): Promise<HttpResult<TimeEntryListResponse>> {
  const query = buildQuery({
    userId: options.userId,
    fromDate: options.fromDate,
    toDate: options.toDate,
    status: options.status,
  });
  return httpGet<TimeEntryListResponse>(`/api/time-entries${query}`, {
    schema: TimeEntryListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * GET /api/time-entries?scope=approver — list entries visible to the current
 * approver. Admin sees every submitted entry across all users; LH sees only
 * entries on jobs they're assigned to, and never another LH's submission.
 *
 * The legacy server enriches each allocation with `jobName` and
 * `_jobLedByMe` so the UI can render job labels without a second fetch.
 */
export function listForApprover(
  status: "submitted" | "approved" | "rejected" = "submitted"
): Promise<HttpResult<TimeEntryListResponse>> {
  const query = buildQuery({ scope: "approver", status });
  return httpGet<TimeEntryListResponse>(`/api/time-entries${query}`, {
    schema: TimeEntryListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

interface OverviewOptions {
  /** Single-day view. Ignored when fromDate/toDate are supplied. */
  date?: string;
  fromDate?: string;
  toDate?: string;
  jobId?: string;
  userId?: string;
}

/**
 * GET /api/time-entries-overview — admin/LH cross-user rollup for a day or a
 * range. Returns enriched entries, totals (by job/user/date/status), the
 * server's missing-hours list, and the visible job/user reference data for
 * filter dropdowns. Server returns 403 for non-staff viewers.
 */
export function overview(
  options: OverviewOptions = {}
): Promise<HttpResult<TimeEntryOverviewResponse>> {
  const query = buildQuery({
    date: options.date,
    fromDate: options.fromDate,
    toDate: options.toDate,
    jobId: options.jobId,
    userId: options.userId,
  });
  return httpGet<TimeEntryOverviewResponse>(`/api/time-entries-overview${query}`, {
    schema: TimeEntryOverviewResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * GET /api/today-pulse — the live "what's on site today" snapshot backing the
 * end-of-day closeout panel. Defaults to today (Sydney); a past `date` is
 * allowed for back-scrolling. Staff-gated (403 for non-staff). Leading hands
 * get the same shape, scoped to their jobs.
 */
export function todayPulse(date?: string): Promise<HttpResult<TodayPulseResponse>> {
  const query = buildQuery({ date });
  return httpGet<TodayPulseResponse>(`/api/today-pulse${query}`, {
    schema: TodayPulseResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * POST /api/time-entries — create a new entry. Status defaults to `draft`
 * server-side unless the payload sets `status: 'submitted'`.
 *
 * Returns 409 if the user already has an entry for that date — callers
 * should switch to `editOwnEntry` in that case.
 */
export function submitNewEntry(
  payload: CreateTimeEntryPayload
): Promise<HttpResult<TimeEntryMutationResponse>> {
  const parsed = CreateTimeEntryPayloadSchema.safeParse(payload);
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
  return httpPost<TimeEntryMutationResponse>("/api/time-entries", parsed.data, {
    schema: TimeEntryMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * PATCH /api/time-entries?date=YYYY-MM-DD — edit an existing entry. Used
 * when a rejected entry needs to be amended and resubmitted by the worker,
 * or when an admin spot-edits.
 */
export function editOwnEntry(
  date: string,
  payload: PatchTimeEntryPayload
): Promise<HttpResult<TimeEntryMutationResponse>> {
  const parsed = PatchTimeEntryPayloadSchema.safeParse(payload);
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
  return httpPatch<TimeEntryMutationResponse>(
    `/api/time-entries?date=${encodeURIComponent(date)}`,
    parsed.data,
    {
      schema: TimeEntryMutationResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

/**
 * POST /api/time-entries-approve — approve a submitted entry. Only admin or
 * leading-hand may call this; server returns 403 otherwise.
 */
export function approveEntry(
  payload: ApproveTimeEntryPayload
): Promise<HttpResult<TimeEntryMutationResponse>> {
  const parsed = ApproveTimeEntryPayloadSchema.safeParse(payload);
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
  return httpPost<TimeEntryMutationResponse>("/api/time-entries-approve", parsed.data, {
    schema: TimeEntryMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * POST /api/time-entries-reject — reject a submitted entry with a reason.
 * The reason is required (server returns 400 without one).
 */
export function rejectEntry(
  payload: RejectTimeEntryPayload
): Promise<HttpResult<TimeEntryMutationResponse>> {
  const parsed = RejectTimeEntryPayloadSchema.safeParse(payload);
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
  return httpPost<TimeEntryMutationResponse>("/api/time-entries-reject", parsed.data, {
    schema: TimeEntryMutationResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export const timesheetsClient = {
  listOwnEntries,
  listForApprover,
  overview,
  todayPulse,
  submitNewEntry,
  editOwnEntry,
  approveEntry,
  rejectEntry,
} as const;
