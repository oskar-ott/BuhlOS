import { z } from "zod";
import { httpDelete, httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  ItemDetailSchema,
  ItemOnlySchema,
  JobPickerSchema,
  ListsSchema,
  LocationMatrixSchema,
  LookupResultSchema,
  OneListSchema,
  OperationSchema,
  ReadPhotoSchema,
  CustomTypeSchema,
  StockItemSchema,
  StockListSchema,
  WriteResultSchema,
  type LocationMatrixResponse,
  type LookupResult,
  type PackUnit,
  type ReadPhotoResult,
  type StockList,
  type StockUnit,
  type WriteResult,
} from "./schema";
import { variantDetailsFrom, type LookupCheck } from "./check";
import { setCustomTypes } from "./types";

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

export async function fetchStockList(opts: { archived?: boolean; signal?: AbortSignal } = {}): Promise<HttpResult<StockList>> {
  const once = () => httpGet(`${BASE}?action=list${opts.archived ? "&archived=1" : ""}`, { schema: StockListSchema, init: { ...INIT, signal: opts.signal }, timeoutMs: 20_000 });
  const r = await once();
  // 503 = the server gave up before reading anything (a stalled database
  // connection, which it has now dropped): one quiet retry gets a fresh one,
  // so the screen loads instead of showing an error (2026-11-02).
  const out = !r.ok && r.error.status === 503 && !opts.signal?.aborted ? await once() : r;
  // The office's own categories join the built-in ones for every screen.
  if (out.ok) setCustomTypes(out.data.customTypes ?? []);
  return out;
}

/** Add a category (no key) or change one (its key) — office only. Fields are only ever added or renamed. */
export function saveCustomType(input: { key?: string; label: string; unit: StockUnit; fields: Array<{ key?: string; label: string }> }) {
  return httpPost(`${BASE}?action=type`, input, { schema: z.object({ type: CustomTypeSchema }), init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
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

export function fetchOperation(key: string) {
  return httpGet(`${BASE}?action=operation&key=${encodeURIComponent(key)}`, { schema: OperationSchema, init: INIT, timeoutMs: 15_000 });
}

export function searchJobs(q: string) {
  return httpGet(`${BASE}?action=jobs&q=${encodeURIComponent(q)}`, { schema: JobPickerSchema, init: INIT, timeoutMs: 15_000 });
}

/** Read a photo. An add-stock photo is kept (with its list-size copy, when there is one); a take-stock photo never is. */
export function readPhoto(dataUrl: string, purpose: "add" | "take", thumbDataUrl?: string | null): Promise<HttpResult<ReadPhotoResult>> {
  return httpPost(`${BASE}?action=read-photo`, { dataUrl, purpose, ...(purpose === "add" && thumbDataUrl ? { thumbDataUrl } : {}) }, { schema: ReadPhotoSchema, init: INIT, timeoutMs: PHOTO_TIMEOUT_MS });
}

/** The camera table's read: one object's crop, never kept, on the table's own limits (office only). */
export function readIntakeCrop(dataUrl: string): Promise<HttpResult<ReadPhotoResult>> {
  return httpPost(`${BASE}?action=read-photo`, { dataUrl, purpose: "take", intake: true }, { schema: ReadPhotoSchema, init: INIT, timeoutMs: PHOTO_TIMEOUT_MS });
}

export function fetchLocationMatrix(): Promise<HttpResult<LocationMatrixResponse>> {
  return httpGet(`${BASE}?action=location-matrix`, { schema: LocationMatrixSchema, init: INIT, timeoutMs: 20_000 });
}

/** Saves the whole matrix; 409 matrix_conflict when someone else saved since `expectedRevision`. */
export function saveLocationMatrix(input: LocationMatrixResponse["matrix"] & { expectedRevision: number }): Promise<HttpResult<LocationMatrixResponse>> {
  return httpPut(`${BASE}?action=location-matrix`, input, { schema: LocationMatrixSchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function storePhoto(dataUrl: string, thumbDataUrl?: string | null) {
  return httpPost(`${BASE}?action=store-photo`, { dataUrl, ...(thumbDataUrl ? { thumbDataUrl } : {}) }, { schema: z.object({ photoId: z.string() }), init: INIT, timeoutMs: PHOTO_TIMEOUT_MS });
}

/** Online code check. Size/rating text is sent as the check compares it (≤ 8 words). */
export function lookupCode(input: { brand?: string | null; manufacturerCode: string; colourFinish?: string | null; variantDetails?: string[] | string | null; refresh?: boolean }): Promise<HttpResult<LookupResult>> {
  return httpPost(`${BASE}?action=lookup`, { ...input, variantDetails: variantDetailsFrom(input.variantDetails ?? []) }, { schema: LookupResultSchema, init: INIT, timeoutMs: LOOKUP_TIMEOUT_MS });
}

/** A pack the screen showed, WITH the size it showed — the server refuses (pack_changed) if that size changed. */
export type PackPick =
  | { source: "identifier"; identifierId: string; sizeMilli: number }
  | { source: "default"; sizeMilli: number }
  | { source: "custom"; unit: PackUnit; size: string };

export interface MoveInput {
  itemId: string;
  kind: "add" | "take" | "return";
  quantity?: string;
  packCount?: number;
  pack?: PackPick;
  /** out of the box, alongside the full packs: "3 boxes of 10 + 4 loose" */
  looseQuantity?: string;
  jobId?: string | null;
  note?: string | null;
  estimated?: boolean;
  /** a shopping-list line this take collects (ticked in the same transaction) */
  listLineId?: string;
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
  /** a photo of where it lives (uploaded with storePhoto first) */
  locationPhotoId?: string | null;
  /** …or the same photo another item already shows (setting up one shelf) */
  locationPhotoFromItemId?: string | null;
  /** the item's type (types.ts) and that type's fields */
  category?: string | null;
  specs?: Record<string, string>;
  openingQuantity?: string;
  packCount?: number;
  packUnit?: PackUnit;
  packSize?: string;
  /** out of the box, alongside the full packs */
  looseQuantity?: string;
  /** no barcode? the server gives it one of ours, for a printed label */
  makeBarcode?: boolean;
  rememberPack?: boolean;
  estimated?: boolean;
  /** the online check the worker accepted — exactly what it asked (LookupResult.check) */
  lookupCheck?: LookupCheck;
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

/**
 * Office: replace the product photo, or (slot 'location') replace or remove (null) the photo of where it lives.
 * The crew: slot 'location' only, to fill a MISSING photo of where it lives (409 location_photo_exists otherwise).
 */
export function replaceItemPhoto(itemId: string, photoId: string | null, slot: "product" | "location" = "product") {
  return httpPost(`${BASE}?action=item-photo`, { itemId, photoId, slot }, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

const WebPhotoSchema = z.object({
  photoId: z.string(),
  source: z.object({ domain: z.string().nullable(), kind: z.string().nullable(), pageUrl: z.string().nullable() }),
});
export type WebPhoto = z.infer<typeof WebPhotoSchema>;

/**
 * Office: fetch the product image the online check found for this item (on the
 * maker's or a wholesaler's page) and keep it as a PENDING photo to preview —
 * replaceItemPhoto(itemId, photoId) then uses it. The server picks the image
 * from its own check; nothing here names a URL.
 * 409 not_checked: run lookupCode for the item first, then ask again.
 */
export function findWebPhoto(itemId: string) {
  return httpPost(`${BASE}?action=web-photo`, { itemId }, { schema: WebPhotoSchema, init: INIT, timeoutMs: LOOKUP_TIMEOUT_MS });
}

export function recordVerification(itemId: string) {
  return httpPost(`${BASE}?action=verify`, { itemId }, { schema: ItemOnlySchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

/** A fresh operation key (crypto.randomUUID with a fallback for old webviews). */
export function newOperationKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── shopping lists ───────────────────────────────────────────────────────────

export function fetchLists() {
  return httpGet(`${BASE}?action=lists`, { schema: ListsSchema, init: INIT, timeoutMs: 20_000 });
}

/** Start a list (the id is made here, so a retry is the same list) or change one. jobId null clears it. */
export function saveList(input: { id: string; name?: string; jobId?: string | null; done?: boolean }) {
  return httpPost(`${BASE}?action=list`, input, { schema: OneListSchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function deleteList(id: string) {
  return httpDelete(`${BASE}?action=list&id=${encodeURIComponent(id)}`, { schema: z.object({ deleted: z.boolean() }), init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export interface ListLineInput {
  listId: string;
  id: string;
  /** a workshop item — or `text` for something we don't stock */
  itemId?: string | null;
  text?: string;
  /** how many are needed, as a decimal string (null clears it) */
  quantity?: string | null;
  unit?: StockUnit | null;
  got?: boolean;
  position?: number;
}

export function saveListLine(input: ListLineInput) {
  return httpPost(`${BASE}?action=list-line`, input, { schema: OneListSchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

export function deleteListLine(id: string) {
  return httpDelete(`${BASE}?action=list-line&id=${encodeURIComponent(id)}`, { schema: OneListSchema, init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}

/**
 * A v4 UUID for a list or a line — made on the phone, so a retried save is the
 * same row. crypto.randomUUID where there is one; the same shape from
 * getRandomValues on older webviews (the server only accepts UUIDs here).
 */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Give an item with no barcode one of ours (in-store EAN-13, made by the server) for a NIIMBOT label; an item that has one gets it back. */
export function makeLabelBarcode(itemId: string) {
  return httpPost(`${BASE}?action=label`, { itemId }, { schema: z.object({ item: StockItemSchema, barcode: z.string(), created: z.boolean() }), init: INIT, timeoutMs: WRITE_TIMEOUT_MS });
}
