import { z } from "zod";
import { httpDelete, httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  ItemDetailSchema,
  ItemOnlySchema,
  JobPickerSchema,
  LookupResultSchema,
  OperationSchema,
  ReadPhotoSchema,
  RecentSchema,
  StockListSchema,
  WriteResultSchema,
  type LookupResult,
  type PackUnit,
  type ReadPhotoResult,
  type StockList,
  type StockUnit,
  type WriteResult,
} from "./schema";

/**
 * Typed client for /api/workshop-stock. Every ledger write carries an
 * Idempotency-Key the caller holds for the whole logical operation: a retry
 * after a timeout re-sends the SAME key, so the server replays the saved result
 * instead of recording the movement twice.
 */

const BASE = "/api/workshop-stock";
const INIT: RequestInit = { cache: "no-store", credentials: "same-origin" };
const WRITE_TIMEOUT_MS = 20_000;
const PHOTO_TIMEOUT_MS = 70_000;
const LOOKUP_TIMEOUT_MS = 70_000;

function withKey(key: string): RequestInit {
  return { ...INIT, headers: { "Idempotency-Key": key } };
}

export function fetchStockList(opts: { archived?: boolean; signal?: AbortSignal } = {}): Promise<HttpResult<StockList>> {
  return httpGet(`${BASE}?action=list${opts.archived ? "&archived=1" : ""}`, { schema: StockListSchema, init: { ...INIT, signal: opts.signal }, timeoutMs: 20_000 });
}

export function fetchItem(id: string) {
  return httpGet(`${BASE}?action=item&id=${encodeURIComponent(id)}`, { schema: ItemDetailSchema, init: INIT, timeoutMs: 20_000 });
}

export function fetchHistory(id: string, before?: { before: string; beforeId: string }) {
  const cursor = before ? `&before=${encodeURIComponent(before.before)}&beforeId=${encodeURIComponent(before.beforeId)}` : "";
  return httpGet(`${BASE}?action=history&id=${encodeURIComponent(id)}${cursor}`, {
    schema: z.object({ movements: ItemDetailSchema.shape.movements, next: z.object({ before: z.string(), beforeId: z.string() }).nullable() }),
    init: INIT,
    timeoutMs: 20_000,
  });
}

export function fetchRecent() {
  return httpGet(`${BASE}?action=recent`, { schema: RecentSchema, init: INIT, timeoutMs: 15_000 });
}

export function fetchOperation(key: string) {
  return httpGet(`${BASE}?action=operation&key=${encodeURIComponent(key)}`, { schema: OperationSchema, init: INIT, timeoutMs: 15_000 });
}

export function searchJobs(q: string) {
  return httpGet(`${BASE}?action=jobs&q=${encodeURIComponent(q)}`, { schema: JobPickerSchema, init: INIT, timeoutMs: 15_000 });
}

export function readPhoto(dataUrl: string, purpose: "add" | "take"): Promise<HttpResult<ReadPhotoResult>> {
  return httpPost(`${BASE}?action=read-photo`, { dataUrl, purpose }, { schema: ReadPhotoSchema, init: INIT, timeoutMs: PHOTO_TIMEOUT_MS });
}

export function storePhoto(dataUrl: string) {
  return httpPost(`${BASE}?action=store-photo`, { dataUrl }, { schema: z.object({ photoId: z.string() }), init: INIT, timeoutMs: PHOTO_TIMEOUT_MS });
}

export function lookupCode(input: { brand?: string | null; manufacturerCode: string; colourFinish?: string | null; variantDetails?: string[]; refresh?: boolean }): Promise<HttpResult<LookupResult>> {
  return httpPost(`${BASE}?action=lookup`, input, { schema: LookupResultSchema, init: INIT, timeoutMs: LOOKUP_TIMEOUT_MS });
}

export type PackPick =
  | { source: "identifier"; identifierId: string }
  | { source: "default" }
  | { source: "custom"; unit: PackUnit; size: string };

export interface MoveInput {
  itemId: string;
  kind: "add" | "take" | "return";
  quantity?: string;
  packCount?: number;
  pack?: PackPick;
  jobId?: string | null;
  note?: string | null;
  estimated?: boolean;
}

export function recordMove(input: MoveInput, key: string): Promise<HttpResult<WriteResult>> {
  return httpPost(`${BASE}?action=move`, input, { schema: WriteResultSchema, init: withKey(key), timeoutMs: WRITE_TIMEOUT_MS });
}

export interface CreateInput {
  name: string;
  brand?: string | null;
  manufacturerCode?: string | null;
  supplierSku?: string | null;
  supplierName?: string | null;
  barcode?: string | null;
  variant?: string | null;
  colourFinish?: string | null;
  baseUnit: StockUnit;
  location?: string | null;
  photoId?: string | null;
  openingQuantity?: string;
  packCount?: number;
  packUnit?: PackUnit;
  packSize?: string;
  rememberPack?: boolean;
  estimated?: boolean;
  useLookup?: boolean;
  provenance?: Record<string, "photo" | "lookup" | "typed">;
  note?: string | null;
}

export function createItem(input: CreateInput, key: string): Promise<HttpResult<WriteResult>> {
  return httpPost(`${BASE}?action=create`, input, { schema: WriteResultSchema, init: withKey(key), timeoutMs: WRITE_TIMEOUT_MS });
}

export function recordCount(input: { itemId: string; countedQuantity: string; expectedVersion: number; reason: string; estimated?: boolean }, key: string) {
  return httpPost(`${BASE}?action=count`, input, { schema: WriteResultSchema, init: withKey(key), timeoutMs: WRITE_TIMEOUT_MS });
}

export function undoMovement(input: { movementId: string; reason?: string | null }, key: string) {
  return httpPost(`${BASE}?action=undo`, input, { schema: WriteResultSchema, init: withKey(key), timeoutMs: WRITE_TIMEOUT_MS });
}

export function editItem(id: string, patch: Record<string, unknown> & { expectedRevision: number }) {
  return httpPut(`${BASE}?action=item&id=${encodeURIComponent(id)}`, patch, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function addIdentifier(input: { itemId: string; kind: "manufacturer_code" | "supplier_sku" | "barcode"; value: string; supplierName?: string | null; packUnit?: PackUnit; packSize?: string }) {
  return httpPost(`${BASE}?action=identifier`, input, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function removeIdentifier(id: string) {
  return httpDelete(`${BASE}?action=identifier&id=${encodeURIComponent(id)}`, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function setArchived(itemId: string, archived: boolean) {
  return httpPost(`${BASE}?action=${archived ? "archive" : "restore"}`, { itemId }, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function replaceItemPhoto(itemId: string, photoId: string) {
  return httpPost(`${BASE}?action=item-photo`, { itemId, photoId }, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function recordVerification(itemId: string) {
  return httpPost(`${BASE}?action=verify`, { itemId }, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

/** A fresh operation key (crypto.randomUUID with a fallback for old webviews). */
export function newOperationKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
