// Epic 5 (#197) — typed fetch client for /api/ai-drawings.
//
// Every function throws AiDrawingsError with the server's honest message on
// non-2xx, and a typed `code` for the states the UI treats specially:
//   'STORE_UNAVAILABLE' — 503 (no Supabase in this environment — preview/dev)
//   'CAP_REACHED'       — 402 (per-job AI budget spent)

import {
  DetectDevicesResponseSchema,
  DetectionsResponseSchema,
  DiffPagesResponseSchema,
  DiffsResponseSchema,
  ExtractLegendResponseSchema,
  ExtractScheduleResponseSchema,
  LegendEntryResponseSchema,
  LegendListResponseSchema,
  OverrideResponseSchema,
  ReviewDiffRegionResponseSchema,
  ReviewScheduleRowResponseSchema,
  SchedulesResponseSchema,
  SheetsResponseSchema,
  UnderstandResponseSchema,
  type CropRegion,
  type DetectDevicesResponse,
  type DetectionsResponse,
  type DiffPagesResponse,
  type DiffsResponse,
  type ExtractLegendResponse,
  type ExtractScheduleResponse,
  type LegendCategory,
  type LegendEntryResponse,
  type LegendListResponse,
  type OverrideResponse,
  type ReviewDiffRegionResponse,
  type ReviewScheduleRowResponse,
  type ScheduleTableKind,
  type SchedulesResponse,
  type SheetField,
  type SheetsResponse,
  type UnderstandResponse,
} from "./schema";

export type AiDrawingsErrorCode =
  | "STORE_UNAVAILABLE"
  | "CAP_REACHED"
  | "HTTP"
  | "BAD_RESPONSE";

export class AiDrawingsError extends Error {
  code: AiDrawingsErrorCode;
  status: number | null;

  constructor(code: AiDrawingsErrorCode, message: string, status: number | null) {
    super(message);
    this.name = "AiDrawingsError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(
  url: string,
  init: RequestInit,
  parse: (body: unknown) => T,
): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through — handled below
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `AI drawings API ${res.status}`;
    const code =
      res.status === 503
        ? "STORE_UNAVAILABLE"
        : res.status === 402
          ? "CAP_REACHED"
          : "HTTP";
    throw new AiDrawingsError(code, message, res.status);
  }
  try {
    return parse(body);
  } catch {
    throw new AiDrawingsError("BAD_RESPONSE", "Unexpected AI drawings response", res.status);
  }
}

export async function fetchSheets(jobId: string): Promise<SheetsResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=sheets`,
    { method: "GET" },
    (b) => SheetsResponseSchema.parse(b),
  );
}

export async function understandPage(
  jobId: string,
  planId: string,
  pageIndex: number,
  titleBlockCrop?: { dataUrl: string; region: CropRegion },
): Promise<UnderstandResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=understand-page`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, titleBlockCrop }),
    },
    (b) => UnderstandResponseSchema.parse(b),
  );
}

export async function saveOverride(
  jobId: string,
  planId: string,
  pageIndex: number,
  field: SheetField,
  value: string | null,
): Promise<OverrideResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=override`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, field, value }),
    },
    (b) => OverrideResponseSchema.parse(b),
  );
}

export async function clearOverride(
  jobId: string,
  planId: string,
  pageIndex: number,
  field: SheetField,
): Promise<OverrideResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=clear-override`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, field }),
    },
    (b) => OverrideResponseSchema.parse(b),
  );
}

// ─── #201: legend vocabulary ────────────────────────────────────────────────

export async function fetchLegend(jobId: string): Promise<LegendListResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=legend`,
    { method: "GET" },
    (b) => LegendListResponseSchema.parse(b),
  );
}

export async function extractLegend(
  jobId: string,
  planId: string,
  pageIndex: number,
): Promise<ExtractLegendResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=extract-legend`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex }),
    },
    (b) => ExtractLegendResponseSchema.parse(b),
  );
}

export async function reviewLegendEntry(
  jobId: string,
  entryId: string,
  status: "accepted" | "edited" | "rejected",
  opts: { humanLabel?: string; note?: string } = {},
): Promise<LegendEntryResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=review-legend-entry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId, status, ...opts }),
    },
    (b) => LegendEntryResponseSchema.parse(b),
  );
}

export async function addLegendEntry(
  jobId: string,
  label: string,
  opts: { description?: string | null; category?: LegendCategory | null } = {},
): Promise<LegendEntryResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=add-legend-entry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, ...opts }),
    },
    (b) => LegendEntryResponseSchema.parse(b),
  );
}

export async function attachLegendCrop(
  jobId: string,
  entryId: string,
  dataUrl: string,
): Promise<LegendEntryResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=attach-legend-crop`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId, dataUrl }),
    },
    (b) => LegendEntryResponseSchema.parse(b),
  );
}

// ─── #202/#207: schedule tables ─────────────────────────────────────────────

export async function fetchSchedules(jobId: string): Promise<SchedulesResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=schedules`,
    { method: "GET" },
    (b) => SchedulesResponseSchema.parse(b),
  );
}

export async function extractSchedule(
  jobId: string,
  planId: string,
  pageIndex: number,
  tableKind: ScheduleTableKind,
): Promise<ExtractScheduleResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=extract-schedule`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, tableKind }),
    },
    (b) => ExtractScheduleResponseSchema.parse(b),
  );
}

export async function reviewScheduleRow(
  jobId: string,
  rowId: string,
  status: "accepted" | "edited" | "rejected",
  opts: { cells?: Record<string, string | null>; note?: string } = {},
): Promise<ReviewScheduleRowResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=review-schedule-row`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rowId, status, ...opts }),
    },
    (b) => ReviewScheduleRowResponseSchema.parse(b),
  );
}

// ─── #203: revision diffs ───────────────────────────────────────────────────

export async function fetchDiffs(jobId: string): Promise<DiffsResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=diffs`,
    { method: "GET" },
    (b) => DiffsResponseSchema.parse(b),
  );
}

export async function diffPages(
  jobId: string,
  base: { planId: string; pageIndex: number },
  head: { planId: string; pageIndex: number },
): Promise<DiffPagesResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=diff-pages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base, head }),
    },
    (b) => DiffPagesResponseSchema.parse(b),
  );
}

export async function reviewDiffRegion(
  jobId: string,
  regionId: string,
  status: "reviewed" | "dismissed",
  opts: { note?: string } = {},
): Promise<ReviewDiffRegionResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=review-diff-region`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regionId, status, ...opts }),
    },
    (b) => ReviewDiffRegionResponseSchema.parse(b),
  );
}

// ─── #204: device detection ─────────────────────────────────────────────────

export async function fetchDetections(jobId: string): Promise<DetectionsResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=detections`,
    { method: "GET" },
    (b) => DetectionsResponseSchema.parse(b),
  );
}

export async function detectDevices(
  jobId: string,
  planId: string,
  pageIndex: number,
  tile: { region: CropRegion; dataUrl: string },
): Promise<DetectDevicesResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=detect-devices`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, tile }),
    },
    (b) => DetectDevicesResponseSchema.parse(b),
  );
}
