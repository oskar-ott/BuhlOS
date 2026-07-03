// Epic 5 (#197) — typed fetch client for /api/ai-drawings.
//
// Every function throws AiDrawingsError with the server's honest message on
// non-2xx, and a typed `code` for the states the UI treats specially:
//   'STORE_UNAVAILABLE' — 503 (no Supabase in this environment — preview/dev)
//   'CAP_REACHED'       — 402 (per-job AI budget spent)

import {
  AcceptCountResponseSchema,
  CableRunResponseSchema,
  CalibrateResponseSchema,
  CountReviewResponseSchema,
  ExtractRoomsResponseSchema,
  ReviewRoomResponseSchema,
  RoomAssignResponseSchema,
  DetectDevicesResponseSchema,
  DetectionsResponseSchema,
  DiffPagesResponseSchema,
  DiffsResponseSchema,
  ExtractLegendResponseSchema,
  ExtractRefsResponseSchema,
  ExtractScheduleResponseSchema,
  LinkResponseSchema,
  LinksResponseSchema,
  ProposeLinksResponseSchema,
  LegendEntryResponseSchema,
  LegendListResponseSchema,
  OverrideResponseSchema,
  ReviewDiffRegionResponseSchema,
  ReviewMarkerResponseSchema,
  ReviewScheduleRowResponseSchema,
  SchedulesResponseSchema,
  SheetsResponseSchema,
  TakeoffLineResponseSchema,
  TakeoffViewsSchema,
  UnderstandResponseSchema,
  type AcceptCountResponse,
  type CableRunResponse,
  type CalibrateResponse,
  type CountReviewResponse,
  type ExtractRoomsResponse,
  type ReviewRoomResponse,
  type RoomAssignResponse,
  type CropRegion,
  type DetectDevicesResponse,
  type DetectionsResponse,
  type DiffPagesResponse,
  type DiffsResponse,
  type ExtractLegendResponse,
  type ExtractRefsResponse,
  type ExtractScheduleResponse,
  type LinkResponse,
  type LinksResponse,
  type ProposeLinksResponse,
  type LegendCategory,
  type LegendEntryResponse,
  type LegendListResponse,
  type OverrideResponse,
  type ReviewDiffRegionResponse,
  type ReviewMarkerResponse,
  type ReviewScheduleRowResponse,
  type ScheduleTableKind,
  type SchedulesResponse,
  type SheetField,
  type TakeoffLineResponse,
  type TakeoffViews,
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

// ─── #205: count review ─────────────────────────────────────────────────────

export async function fetchCountReview(jobId: string): Promise<CountReviewResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=count-review`,
    { method: "GET" },
    (b) => CountReviewResponseSchema.parse(b),
  );
}

export async function reviewMarker(
  jobId: string,
  body: {
    action: "delete" | "restore" | "reclassify";
    detectionId?: string;
    reviewId?: string;
    toLegendEntryId?: string;
    note?: string;
  },
): Promise<ReviewMarkerResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=review-marker`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    (b) => ReviewMarkerResponseSchema.parse(b),
  );
}

export async function addMarker(
  jobId: string,
  planId: string,
  pageIndex: number,
  bbox: CropRegion,
  legendEntryId: string,
  note?: string,
): Promise<ReviewMarkerResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=add-marker`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, bbox, legendEntryId, note }),
    },
    (b) => ReviewMarkerResponseSchema.parse(b),
  );
}

export async function acceptCount(
  jobId: string,
  planId: string,
  pageIndex: number,
  legendEntryId: string,
): Promise<AcceptCountResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=accept-count`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, legendEntryId }),
    },
    (b) => AcceptCountResponseSchema.parse(b),
  );
}

// ─── #206: rooms and zones ──────────────────────────────────────────────────

export async function extractRooms(
  jobId: string,
  planId: string,
  pageIndex: number,
): Promise<ExtractRoomsResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=extract-rooms`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex }),
    },
    (b) => ExtractRoomsResponseSchema.parse(b),
  );
}

export async function reviewRoom(
  jobId: string,
  roomId: string,
  status: "accepted" | "edited" | "rejected",
  opts: { name?: string; bbox?: CropRegion; note?: string } = {},
): Promise<ReviewRoomResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=review-room`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, status, ...opts }),
    },
    (b) => ReviewRoomResponseSchema.parse(b),
  );
}

export async function addRoom(
  jobId: string,
  planId: string,
  pageIndex: number,
  name: string,
  bbox: CropRegion,
): Promise<ReviewRoomResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=add-room`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, name, bbox }),
    },
    (b) => ReviewRoomResponseSchema.parse(b),
  );
}

export async function assignDeviceRoom(
  jobId: string,
  planId: string,
  pageIndex: number,
  markerKey: string,
  roomId: string | null,
): Promise<RoomAssignResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=assign-device-room`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, markerKey, roomId }),
    },
    (b) => RoomAssignResponseSchema.parse(b),
  );
}

export async function clearDeviceRoom(
  jobId: string,
  planId: string,
  pageIndex: number,
  markerKey: string,
): Promise<RoomAssignResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=clear-device-room`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, markerKey }),
    },
    (b) => RoomAssignResponseSchema.parse(b),
  );
}

// ─── #211: cable estimates ──────────────────────────────────────────────────

export async function pinBoard(
  jobId: string,
  planId: string,
  pageIndex: number,
  boardIdentifier: string,
  point: { x: number; y: number },
): Promise<RoomAssignResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=pin-board`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, boardIdentifier, point }),
    },
    (b) => RoomAssignResponseSchema.parse(b),
  );
}

export async function clearBoardPin(
  jobId: string,
  planId: string,
  pageIndex: number,
  boardIdentifier: string,
): Promise<RoomAssignResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=clear-board-pin`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, boardIdentifier }),
    },
    (b) => RoomAssignResponseSchema.parse(b),
  );
}

export async function calibrateSheet(
  jobId: string,
  planId: string,
  pageIndex: number,
  pointA: { x: number; y: number },
  pointB: { x: number; y: number },
  realMm: number,
  rasterAspect: number,
): Promise<CalibrateResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=calibrate-sheet`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, pointA, pointB, realMm, rasterAspect }),
    },
    (b) => CalibrateResponseSchema.parse(b),
  );
}

export async function estimateCable(
  jobId: string,
  planId: string,
  pageIndex: number,
  factors?: { routingFactor?: number; riseDropMm?: number; slackFactor?: number },
): Promise<CableRunResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=estimate-cable`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex, factors }),
    },
    (b) => CableRunResponseSchema.parse(b),
  );
}

export async function acceptCableEstimate(
  jobId: string,
  runId: string,
): Promise<CableRunResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=accept-cable-estimate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    },
    (b) => CableRunResponseSchema.parse(b),
  );
}

// ─── #212: cross-sheet links ────────────────────────────────────────────────

export async function fetchLinks(jobId: string): Promise<LinksResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=links`,
    { method: "GET" },
    (b) => LinksResponseSchema.parse(b),
  );
}

export async function extractRefs(
  jobId: string,
  planId: string,
  pageIndex: number,
): Promise<ExtractRefsResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=extract-refs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId, pageIndex }),
    },
    (b) => ExtractRefsResponseSchema.parse(b),
  );
}

export async function proposeLinks(jobId: string): Promise<ProposeLinksResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=propose-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    (b) => ProposeLinksResponseSchema.parse(b),
  );
}

export async function reviewLink(
  jobId: string,
  linkId: string,
  status: "confirmed" | "rejected",
): Promise<LinkResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=review-link`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId, status }),
    },
    (b) => LinkResponseSchema.parse(b),
  );
}

export async function addLink(
  jobId: string,
  identifier: string,
  a: { planId: string; pageIndex: number },
  b: { planId: string; pageIndex: number },
): Promise<LinkResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=add-link`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "same-board", identifier, a, b }),
    },
    (b2) => LinkResponseSchema.parse(b2),
  );
}

// ─── #213: takeoffs ─────────────────────────────────────────────────────────

export async function fetchTakeoff(jobId: string): Promise<TakeoffViews> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=takeoff`,
    { method: "GET" },
    (b) => TakeoffViewsSchema.parse(b),
  );
}

export async function assembleTakeoff(jobId: string): Promise<TakeoffViews> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=assemble-takeoff`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    (b) => TakeoffViewsSchema.parse(b),
  );
}

export async function adjustTakeoffLine(
  jobId: string,
  lineId: string,
  qty: number | null,
  note?: string,
): Promise<TakeoffLineResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=adjust-takeoff-line`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lineId, qty, note }),
    },
    (b) => TakeoffLineResponseSchema.parse(b),
  );
}

export async function addTakeoffLine(
  jobId: string,
  takeoffId: string,
  description: string,
  qty: number,
  unit: string,
): Promise<TakeoffLineResponse> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=add-takeoff-line`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ takeoffId, description, qty, unit }),
    },
    (b) => TakeoffLineResponseSchema.parse(b),
  );
}

export async function signOffTakeoff(jobId: string, takeoffId: string): Promise<TakeoffViews> {
  return request(
    `/api/ai-drawings?jobId=${encodeURIComponent(jobId)}&action=sign-off-takeoff`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ takeoffId }),
    },
    (b) => TakeoffViewsSchema.parse(b),
  );
}
