// Epic 5 (#197) — typed fetch client for /api/ai-drawings.
//
// Every function throws AiDrawingsError with the server's honest message on
// non-2xx, and a typed `code` for the states the UI treats specially:
//   'STORE_UNAVAILABLE' — 503 (no Supabase in this environment — preview/dev)
//   'CAP_REACHED'       — 402 (per-job AI budget spent)

import {
  OverrideResponseSchema,
  SheetsResponseSchema,
  UnderstandResponseSchema,
  type CropRegion,
  type OverrideResponse,
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
