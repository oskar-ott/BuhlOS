// Workshop Stock — the API (docs/workshop-stock.md). Owner pull 2026-10-09.
//
// Quantities of electrical materials and consumables kept in the workshop, with
// photo-assisted identification and an append-only movement ledger. NOT gear:
// no custody, no serials, no check-in — stock leaving is a quantity movement.
//
// Dark behind the `workshop_stock` launch-gate: 404 on EVERY path while off
// (checked right after auth, before any data is read).
//
//   GET    ?action=list[&archived=1]          catalogue (archived: office)
//   GET    ?action=item&id=                   one item + its latest movements (+ catalogue history for the office)
//   GET    ?action=history&id=&before=&beforeId=  older movements (paging)
//   GET    ?action=recent                     the viewer's own movements, last 24 h, with Undo eligibility
//   GET    ?action=operation&key=             reconcile a save whose response was lost (own operations; office: any)
//   GET    ?action=photo&id=                  a product photo (authenticated proxy — the Blob URL never leaves the server)
//   GET    ?action=jobs&q=                    job picker for the optional job note
//   POST   ?action=read-photo  { dataUrl, purpose: 'add'|'take' }       read a photo, match the catalogue (writes no stock)
//   POST   ?action=store-photo { dataUrl }  keep a product photo for a new item without reading it again (no AI call)
//   POST   ?action=lookup      { brand?, manufacturerCode, colourFinish?, variantDetails? }  online code check (allowlisted sources)
//   POST   ?action=create      { …item, openingQuantity | pack…, useLookup?, idempotencyKey }  new item + opening balance, atomically
//   POST   ?action=move        { itemId, kind: add|take|return, quantity | packCount+pack, jobId?, note?, estimated?, idempotencyKey }
//   POST   ?action=count       { itemId, countedQuantity, expectedVersion, reason, estimated?, idempotencyKey }   OFFICE
//   POST   ?action=undo        { movementId, reason?, idempotencyKey }   own recent (worker) · any with reason (office)
//   PUT    ?action=item&id=    { expectedRevision, …fields }             OFFICE catalogue edit (compare-and-set)
//   POST   ?action=identifier  { itemId, kind, value, supplierName?, packUnit?, packSize? }   OFFICE
//   DELETE ?action=identifier&id=                                        OFFICE
//   POST   ?action=archive | restore  { itemId }                         OFFICE
//   POST   ?action=item-photo  { itemId, photoId }                       OFFICE
//   POST   ?action=verify      { itemId }   OFFICE — record the cached online check on an item
//
// Rules every path follows: the actor, role and company scope come from the
// session and the server — never from the body; bodies are Zod-validated;
// quantities are decimal strings parsed exactly; every ledger write needs an
// Idempotency-Key (header or body `idempotencyKey`) and a reused key with a
// different payload is refused; nothing reports success before Postgres
// committed; errors are { error: <stable code> } — never an exception message.
// A job on a movement is informational only: no job cost is written anywhere.

'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { getDb } = require('./_lib/supabase-db');
const auditLog = require('./_lib/audit-log');
const { withErrorCapture } = require('./_lib/error-wrap');
const { idempotencyKeyFrom } = require('./_lib/idempotency');
const { createRateLimiter } = require('./_lib/rate-limit');
const { isFieldOpenable } = require('./_lib/job-lifecycle');
const store = require('./_lib/workshop-stock/store');
const policy = require('./_lib/workshop-stock/policy');
const Q = require('./_lib/workshop-stock/quantity');
const codes = require('./_lib/workshop-stock/codes');
const { identify } = require('./_lib/workshop-stock/match');
const vision = require('./_lib/workshop-stock/vision');
const photo = require('./_lib/workshop-stock/photo');
const search = require('./_lib/workshop-stock/search');
const { lookupProduct } = require('./_lib/workshop-stock/lookup');
const { fetchAllowlistedPage } = require('./_lib/workshop-stock/safe-fetch');

const FLAG = 'workshop_stock';

// Burst limits per user (per warm instance) + a durable daily ceiling per tenant
// for the two calls that cost money.
const photoReadLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30 });
const lookupLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 20 });
const DAILY_PHOTO_READS = Math.max(1, Number(process.env.STOCK_DAILY_PHOTO_READS || 300));
const DAILY_LOOKUPS = Math.max(1, Number(process.env.STOCK_DAILY_LOOKUPS || 60));
const LOOKUP_TTL_DAYS = { manufacturer_code_matched: 30, possible_match: 7, no_match: 3 };

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// ── helpers ───────────────────────────────────────────────────────────────────

function actorOf(me) {
  return { id: me.id, name: me.name || me.username || '', role: me.role || null };
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
}

function bad(res, error, extra = {}) {
  return res.status(400).json({ error, ...extra });
}

/** Stable JSON (sorted keys) → sha256: the payload fingerprint behind an idempotency key. */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
function requestHash(op, payload) {
  return crypto.createHash('sha256').update(stableStringify({ op, ...payload })).digest('hex');
}

function operationKey(req, res) {
  const key = idempotencyKeyFrom(req);
  if (!key) { bad(res, 'idempotency_key_required'); return null; }
  if (!KEY_RE.test(key)) { bad(res, 'idempotency_key_invalid'); return null; }
  return key;
}

async function journal(me, action, itemId, summary, metadata) {
  try {
    await auditLog.append({
      action,
      actorId: me.id,
      actorName: actorOf(me).name,
      actorRole: me.role || null,
      jobId: null,
      targetType: 'workshop_stock_item',
      targetId: itemId,
      summary: String(summary).slice(0, 240),
      metadata: metadata || {},
    });
  } catch {
    // Best-effort: the ledger/event rows in Postgres are the durable record.
  }
}

async function readJobs() {
  const data = await readBlob('jobs.json', { jobs: [] });
  return Array.isArray(data.jobs) ? data.jobs : [];
}

/** Optional informational job reference. Field roles may only pick jobs open on site. */
async function resolveJob(jobId, me) {
  if (!jobId) return { job: null };
  const jobs = await readJobs();
  const job = jobs.find((j) => j && j.id === jobId && !j.deleted && !j.deletedAt);
  if (!job) return { error: 'job_not_available' };
  if (!policy.isOffice(me.role) && !isFieldOpenable(job)) return { error: 'job_not_available' };
  const label = [typeof job.code === 'string' ? job.code : null, job.name || null].filter(Boolean).join(' · ').slice(0, 160) || job.id;
  return { job: { id: job.id, label } };
}

function undoInfo(movement, me, nowMs) {
  if (!movement) return { allowed: false };
  const office = policy.isOffice(me.role);
  const allowed = policy.canUndo(movement, me, nowMs);
  return {
    allowed,
    until: allowed && !office ? new Date(Date.parse(movement.createdAt) + policy.WORKER_UNDO_MINUTES * 60_000).toISOString() : null,
    needsReason: office,
  };
}

function withUndo(movements, me) {
  const now = Date.now();
  return movements.map((m) => ({ ...m, undo: undoInfo(m, me, now) }));
}

// ── schemas ───────────────────────────────────────────────────────────────────

const qty = z.union([z.string().trim().max(24), z.number()]);
const optText = (max) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const uuid = z.string().uuid();
const packUnit = z.enum(Q.PACK_UNITS);

const PackPick = z.union([
  z.object({ source: z.literal('identifier'), identifierId: uuid }),
  z.object({ source: z.literal('default') }),
  z.object({ source: z.literal('custom'), unit: packUnit, size: qty }),
]);

const MoveBody = z.object({
  itemId: uuid,
  kind: z.enum(['add', 'take', 'return']),
  quantity: qty.optional(),
  packCount: z.number().int().min(1).max(Q.MAX_PACK_COUNT).optional(),
  pack: PackPick.optional(),
  jobId: optText(120),
  note: optText(200),
  estimated: z.boolean().optional(),
});

const CreateBody = z.object({
  name: z.string().trim().min(1).max(160),
  brand: optText(60),
  manufacturerCode: optText(48),
  supplierSku: optText(48),
  supplierName: optText(60),
  barcode: optText(20),
  variant: optText(160),
  colourFinish: optText(40),
  baseUnit: z.enum(Q.UNIT_KEYS),
  location: optText(60),
  photoId: uuid.nullish(),
  openingQuantity: qty.optional(),
  packCount: z.number().int().min(1).max(Q.MAX_PACK_COUNT).optional(),
  packUnit: packUnit.optional(),
  packSize: qty.optional(),
  rememberPack: z.boolean().optional(),
  estimated: z.boolean().optional(),
  useLookup: z.boolean().optional(),
  provenance: z.record(z.enum(['name', 'brand', 'manufacturerCode', 'supplierSku', 'barcode', 'variant', 'colourFinish']), z.enum(['photo', 'lookup', 'typed'])).optional(),
  note: optText(200),
});

const CountBody = z.object({
  itemId: uuid,
  countedQuantity: qty,
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(3).max(200),
  estimated: z.boolean().optional(),
});

const UndoBody = z.object({ movementId: uuid, reason: optText(200) });

const EditBody = z.object({
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(160).optional(),
  brand: optText(60).optional(),
  manufacturerCode: optText(48).optional(),
  supplierSku: optText(48).optional(),
  supplierName: optText(60).optional(),
  variant: optText(160).optional(),
  colourFinish: optText(40).optional(),
  location: optText(60).optional(),
  baseUnit: z.enum(Q.UNIT_KEYS).optional(),
  defaultPack: z.object({ unit: packUnit, size: qty }).nullable().optional(),
});

const IdentifierBody = z.object({
  itemId: uuid,
  kind: z.enum(codes.IDENTIFIER_KINDS),
  value: z.string().trim().min(2).max(48),
  supplierName: optText(60),
  packUnit: packUnit.optional(),
  packSize: qty.optional(),
});

const ReadPhotoBody = z.object({ dataUrl: z.string().min(16), purpose: z.enum(['add', 'take']) });
const LookupBody = z.object({
  brand: optText(60),
  manufacturerCode: z.string().trim().min(1).max(48),
  colourFinish: optText(40),
  variantDetails: z.array(z.string().trim().max(30)).max(8).optional(),
  refresh: z.boolean().optional(),
});
const ItemIdBody = z.object({ itemId: uuid });
const ItemPhotoBody = z.object({ itemId: uuid, photoId: uuid });

function parseOr400(schema, body, res) {
  if (!body) { bad(res, 'body_required'); return null; }
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    bad(res, 'invalid_request', { field: first && first.path.join('.') });
    return null;
  }
  return r.data;
}

// ── reads ─────────────────────────────────────────────────────────────────────

async function list(sql, tenant, me, req, res) {
  const office = policy.isOffice(me.role);
  const includeArchived = office && req.query && req.query.archived === '1';
  const items = await store.listItems(sql, tenant.id, { includeArchived });
  return res.status(200).json({
    items,
    viewer: { id: me.id, office },
    capabilities: { photoRead: vision.enabled(), lookup: search.enabled() },
    undoMinutes: policy.WORKER_UNDO_MINUTES,
    asOf: new Date().toISOString(),
  });
}

async function itemDetail(sql, tenant, me, id, res) {
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'item_not_found' });
  const item = await store.getItem(sql, tenant.id, id);
  if (!item || (item.archivedAt && !policy.isOffice(me.role))) return res.status(404).json({ error: 'item_not_found' });
  const [movements, events] = await Promise.all([
    store.listMovements(sql, tenant.id, id, { limit: 50 }),
    policy.isOffice(me.role) ? store.itemEvents(sql, tenant.id, id) : Promise.resolve(null),
  ]);
  return res.status(200).json({ item, movements: withUndo(movements, me), events, undoMinutes: policy.WORKER_UNDO_MINUTES });
}

async function history(sql, tenant, me, q, res) {
  if (!uuid.safeParse(q.id).success) return res.status(404).json({ error: 'item_not_found' });
  const before = q.before && q.beforeId && !Number.isNaN(Date.parse(q.before)) && uuid.safeParse(q.beforeId).success ? { at: new Date(q.before).toISOString(), id: q.beforeId } : null;
  const item = await store.getItem(sql, tenant.id, q.id);
  if (!item || (item.archivedAt && !policy.isOffice(me.role))) return res.status(404).json({ error: 'item_not_found' });
  const movements = await store.listMovements(sql, tenant.id, q.id, { limit: 100, before });
  const last = movements[movements.length - 1];
  return res.status(200).json({ movements: withUndo(movements, me), next: movements.length === 100 && last ? { before: last.createdAt, beforeId: last.id } : null });
}

async function recent(sql, tenant, me, res) {
  const rows = await store.recentForActor(sql, tenant.id, me.id, { sinceMinutes: 24 * 60, limit: 10 });
  return res.status(200).json({ movements: withUndo(rows, me), undoMinutes: policy.WORKER_UNDO_MINUTES });
}

async function operation(sql, tenant, me, key, res) {
  if (!KEY_RE.test(String(key || ''))) return bad(res, 'idempotency_key_invalid');
  const movement = await store.getOperation(sql, tenant.id, key);
  // Someone else's operation reads exactly like "never saved" — no probing.
  if (!movement || (movement.actorId !== me.id && !policy.isOffice(me.role))) return res.status(200).json({ found: false });
  const item = await store.getItem(sql, tenant.id, movement.itemId);
  return res.status(200).json({ found: true, movement: { ...movement, undo: undoInfo(movement, me, Date.now()) }, item });
}

async function servePhoto(sql, tenant, me, id, res) {
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'not_found' });
  const p = await store.getPhotoForServing(sql, tenant.id, id, { viewerId: me.id, office: policy.isOffice(me.role) });
  if (!p) return res.status(404).json({ error: 'not_found' });
  let bytes;
  try {
    bytes = await photo.fetchPhoto(p.blobUrl);
  } catch {
    return res.status(502).json({ error: 'photo_unavailable' });
  }
  res.setHeader('Content-Type', p.contentType);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Content-Disposition', 'inline; filename="stock-photo"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Photos are immutable per id: a private browser cache is fine, a shared cache is not.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.status(200).end(bytes);
}

async function jobs(me, q, res) {
  const needle = String(q.q || '').trim().toLowerCase().slice(0, 60);
  const office = policy.isOffice(me.role);
  const rows = (await readJobs())
    .filter((j) => j && !j.deleted && !j.deletedAt && (office || isFieldOpenable(j)))
    .map((j) => ({ id: j.id, name: j.name || j.id, code: typeof j.code === 'string' ? j.code : null, status: j.status || 'active' }))
    .filter((j) => !needle || j.name.toLowerCase().includes(needle) || (j.code || '').toLowerCase().includes(needle))
    .slice(0, 30);
  return res.status(200).json({ jobs: rows });
}

// ── photo reading + online check ──────────────────────────────────────────────

async function cleanupExpiredPhotos(sql, tenantId) {
  try {
    const expired = await store.expiredPhotos(sql, tenantId, 3);
    for (const p of expired) {
      try {
        await photo.deletePhoto(p.blobUrl);
        await store.markPhotoDeleted(sql, tenantId, p.id);
      } catch {
        // leave it for the next pass
      }
    }
  } catch {
    // cleanup never blocks a read
  }
}

function itemSummary(item) {
  return {
    id: item.id, name: item.name, brand: item.brand, manufacturerCode: item.manufacturerCode, supplierSku: item.supplierSku,
    supplierName: item.supplierName, variant: item.variant, colourFinish: item.colourFinish, location: item.location,
    baseUnit: item.baseUnit, balanceMilli: item.balanceMilli, estimated: item.estimated, version: item.version,
    photoId: item.photoId, defaultPack: item.defaultPack, identifiers: item.identifiers,
  };
}

async function readPhoto(sql, tenant, me, body, res) {
  const input = parseOr400(ReadPhotoBody, body, res);
  if (!input) return;
  const up = photo.readPhotoUpload(input.dataUrl);
  if (up.error) return res.status(up.status).json({ error: up.error, maxBytes: up.maxBytes });
  if (photoReadLimiter.isLimited(me.id)) {
    return res.status(429).json({ error: 'photo_limit', retryAfterSec: photoReadLimiter.retryAfterSec(me.id) });
  }

  let photoId = null;
  let photoStored = null;
  if (input.purpose === 'add') {
    await cleanupExpiredPhotos(sql, tenant.id);
    try {
      const stored = await photo.storePhoto({ tenantSlug: tenant.slug, bytes: up.bytes, contentType: up.contentType });
      photoId = await store.insertPhoto(sql, tenant.id, {
        blobUrl: stored.url, blobPathname: stored.pathname, contentType: up.contentType, byteSize: up.bytes.length,
        width: up.width, height: up.height, sha256: up.sha256, actor: actorOf(me), ttlHours: 24,
      });
      photoStored = true;
    } catch (e) {
      console.error('[workshop-stock] photo store failed', { code: (e && e.code) || 'blob' });
      photoStored = false;
    }
  }

  let readStatus = 'ok';
  let reading = null;
  if (!vision.enabled()) {
    readStatus = 'not_configured';
  } else {
    const usage = await store.consumeUsage(sql, tenant.id, 'photo_read', DAILY_PHOTO_READS);
    if (!usage.allowed) {
      readStatus = 'daily_limit';
    } else {
      photoReadLimiter.record(me.id);
      try {
        reading = await vision.readProductPhoto({ bytes: up.bytes, contentType: up.contentType });
        if (!reading || !reading.products.length) readStatus = 'unreadable';
      } catch (e) {
        console.error('[workshop-stock] photo read failed', { status: (e && e.status) || null });
        readStatus = 'unavailable';
      }
    }
  }
  if (reading && photoId) {
    const { usage, ...kept } = reading;
    try { await store.setPhotoReading(sql, tenant.id, photoId, kept); } catch { /* provenance only */ }
  }

  let matches = [];
  let candidateItems = [];
  if (reading && reading.products.length) {
    const items = await store.listItems(sql, tenant.id);
    matches = reading.products.map((p, i) => ({ productIndex: i, ...identify(p, items) }));
    const ids = new Set(matches.flatMap((m) => m.candidates.map((c) => c.itemId)));
    candidateItems = items.filter((i) => ids.has(i.id)).map(itemSummary);
  }
  return res.status(200).json({
    readStatus,
    reading: reading ? { legibility: reading.legibility, note: reading.note, products: reading.products } : null,
    matches,
    candidateItems,
    photoId,
    photoStored,
  });
}

const StorePhotoBody = z.object({ dataUrl: z.string().min(16) });

/** Keep a product photo as 'pending' (claimed by the create that follows, else expires). No AI call. */
async function storePhotoOnly(sql, tenant, me, body, res) {
  const input = parseOr400(StorePhotoBody, body, res);
  if (!input) return;
  const up = photo.readPhotoUpload(input.dataUrl);
  if (up.error) return res.status(up.status).json({ error: up.error, maxBytes: up.maxBytes });
  await cleanupExpiredPhotos(sql, tenant.id);
  let stored;
  try {
    stored = await photo.storePhoto({ tenantSlug: tenant.slug, bytes: up.bytes, contentType: up.contentType });
  } catch (e) {
    console.error('[workshop-stock] photo store failed', { code: (e && e.code) || 'blob' });
    return res.status(502).json({ error: 'photo_store_failed' });
  }
  const photoId = await store.insertPhoto(sql, tenant.id, {
    blobUrl: stored.url, blobPathname: stored.pathname, contentType: up.contentType, byteSize: up.bytes.length,
    width: up.width, height: up.height, sha256: up.sha256, actor: actorOf(me), ttlHours: 24,
  });
  return res.status(201).json({ photoId });
}

async function lookup(sql, tenant, me, body, res) {
  const input = parseOr400(LookupBody, body, res);
  if (!input) return;
  const code = codes.cleanCode(input.manufacturerCode);
  if (!code) return res.status(200).json({ status: 'not_checked', reasons: ['That doesn\'t look like a product code — check it against the label'], candidate: null, sources: [] });
  const bKey = codes.brandKey(input.brand) || '';
  const cKey = codes.codeKey(code);
  const refresh = input.refresh === true && policy.isOffice(me.role);
  if (!refresh) {
    const cached = await store.getCachedLookup(sql, tenant.id, bKey, cKey);
    if (cached) return res.status(200).json(cached);
  }
  if (!search.enabled()) {
    return res.status(200).json({ status: 'not_configured', reasons: ['The online product check isn\'t set up — the item can still be saved'], candidate: null, sources: [], code });
  }
  if (lookupLimiter.isLimited(me.id)) {
    return res.status(429).json({ error: 'lookup_limit', retryAfterSec: lookupLimiter.retryAfterSec(me.id) });
  }
  const usage = await store.consumeUsage(sql, tenant.id, 'lookup', DAILY_LOOKUPS);
  if (!usage.allowed) {
    return res.status(200).json({ status: 'unavailable', reasons: ['Today\'s online checks are used up — save it now and check it tomorrow'], candidate: null, sources: [], code });
  }
  lookupLimiter.record(me.id);
  const result = await lookupProduct(
    { brand: input.brand, manufacturerCode: code, colourFinish: input.colourFinish, variantDetails: input.variantDetails || [] },
    { search: search.searchListings, fetchPage: fetchAllowlistedPage, configured: true },
  );
  if (LOOKUP_TTL_DAYS[result.status]) {
    try { await store.putCachedLookup(sql, tenant.id, bKey, cKey, result.status, result, LOOKUP_TTL_DAYS[result.status]); } catch { /* cache is an optimisation */ }
  }
  return res.status(200).json({ ...result, cached: false });
}

// ── writes ────────────────────────────────────────────────────────────────────

function identifiersForItem({ brand, manufacturerCode, supplierSku, supplierName, barcode }) {
  const out = [];
  if (manufacturerCode) out.push(codes.identifierFor('manufacturer_code', manufacturerCode, { brand }));
  if (supplierSku) out.push(codes.identifierFor('supplier_sku', supplierSku, { supplier: supplierName }));
  if (barcode) out.push(codes.identifierFor('barcode', barcode));
  return out;
}

function verificationFromLookup(cached) {
  if (!cached || !['manufacturer_code_matched', 'possible_match'].includes(cached.status) || !cached.candidate) return null;
  const c = cached.candidate;
  return {
    status: cached.status,
    detail: {
      provider: cached.provider || null,
      checkedAt: cached.checkedAt || null,
      sourceUrl: c.sourceUrl || null,
      sourceTitle: c.sourceTitle || null,
      sourceDomain: c.sourceDomain || null,
      sourceKind: c.sourceKind || null,
      evidence: c.evidence || null,
      codeAsWritten: c.codeAsWritten || null,
      productName: c.name || null,
      reasons: (cached.reasons || []).slice(0, 6),
      conflicts: (cached.conflicts || []).slice(0, 6),
    },
  };
}

async function create(sql, tenant, me, req, body, res) {
  const key = operationKey(req, res);
  if (!key) return;
  const input = parseOr400(CreateBody, body, res);
  if (!input) return;
  const unit = input.baseUnit;

  const manufacturerCode = input.manufacturerCode ? codes.cleanCode(input.manufacturerCode) : null;
  if (input.manufacturerCode && !manufacturerCode) return bad(res, 'code_invalid', { field: 'manufacturerCode' });
  const supplierSku = input.supplierSku ? codes.cleanCode(input.supplierSku) : null;
  if (input.supplierSku && !supplierSku) return bad(res, 'code_invalid', { field: 'supplierSku' });
  const barcode = input.barcode ? codes.cleanBarcode(input.barcode) : null;
  if (input.barcode && !barcode) return bad(res, 'barcode_invalid');

  let openingMilli = 0;
  let pack = null;
  let defaultPack = null;
  const anyPack = input.packCount !== undefined || input.packUnit !== undefined || input.packSize !== undefined;
  if (anyPack) {
    if (input.packCount === undefined || !input.packUnit || input.packSize === undefined) return bad(res, 'pack_incomplete');
    const size = Q.parseQuantity(input.packSize, unit);
    if (size.error) return bad(res, size.error, { field: 'packSize' });
    const total = Q.packTotalMilli(input.packCount, size.milli, unit);
    if (total.error) return bad(res, total.error);
    openingMilli = total.milli;
    pack = { count: input.packCount, unit: input.packUnit, sizeMilli: size.milli };
    if (input.rememberPack) defaultPack = { unit: input.packUnit, sizeMilli: size.milli };
  } else if (input.openingQuantity !== undefined && input.openingQuantity !== '') {
    const q = Q.parseQuantity(input.openingQuantity, unit, { allowZero: true });
    if (q.error) return bad(res, q.error, { field: 'openingQuantity' });
    openingMilli = q.milli;
  }

  const identifiers = identifiersForItem({ brand: input.brand, manufacturerCode, supplierSku, supplierName: input.supplierName, barcode });
  if (identifiers.some((i) => i.error)) return bad(res, 'code_invalid');

  // The verification is the SERVER's cached lookup for this brand + code — a
  // client cannot claim "matched"; it can only accept or ignore the check.
  let verificationStatus = 'unverified';
  let verification = null;
  let lookupSummary = null;
  if (input.useLookup && manufacturerCode) {
    const cached = await store.getCachedLookup(sql, tenant.id, codes.brandKey(input.brand) || '', codes.codeKey(manufacturerCode));
    const v = verificationFromLookup(cached);
    if (v) {
      verificationStatus = v.status;
      verification = v.detail;
      lookupSummary = { status: v.status, sourceUrl: v.detail.sourceUrl, checkedAt: v.detail.checkedAt };
    }
  }

  const actor = actorOf(me);
  const payload = {
    name: input.name, brand: input.brand, manufacturerCode, supplierSku, supplierName: supplierSku ? input.supplierName : null, barcode,
    variant: input.variant, colourFinish: input.colourFinish, baseUnit: unit, location: input.location, photoId: input.photoId || null,
    openingMilli, pack, defaultPack, estimated: input.estimated === true, useLookup: input.useLookup === true, actorId: actor.id,
  };
  const result = await store.createItemWithOpening(sql, tenant.id, {
    item: {
      name: input.name, brand: input.brand, manufacturerCode, supplierSku, supplierName: supplierSku ? input.supplierName : null,
      variant: input.variant, colourFinish: input.colourFinish, baseUnit: unit, location: input.location, defaultPack,
    },
    identifiers,
    photoId: input.photoId || null,
    openingMilli,
    pack,
    estimated: input.estimated === true,
    note: input.note,
    verificationStatus,
    verification,
    provenance: { fields: input.provenance || {}, lookup: lookupSummary },
    actor,
    actorIsOffice: policy.isOffice(me.role),
    idempotencyKey: key,
    requestHash: requestHash('create', payload),
  });
  if (result.error === 'duplicate_item') return res.status(409).json({ error: 'duplicate_item', existing: result.existing });
  if (result.error === 'idempotency_conflict') return res.status(409).json({ error: 'idempotency_conflict' });
  if (result.error) return res.status(409).json({ error: result.error });
  if (!result.replayed) {
    await journal(me, 'workshop_stock.item_created', result.item.id, `Added ${result.item.name} to workshop stock`, {
      unit, verificationStatus, photo: Boolean(result.item.photoId),
    });
  }
  return res.status(result.replayed ? 200 : 201).json({
    item: result.item,
    movement: { ...result.movement, undo: undoInfo(result.movement, me, Date.now()) },
    replayed: result.replayed === true,
    photoAttached: result.photoAttached !== false,
  });
}

async function move(sql, tenant, me, req, body, res) {
  const key = operationKey(req, res);
  if (!key) return;
  const input = parseOr400(MoveBody, body, res);
  if (!input) return;
  const item = await store.getItem(sql, tenant.id, input.itemId);
  if (!item || item.archivedAt) return res.status(404).json({ error: item ? 'item_archived' : 'item_not_found' });

  let quantityMilli;
  let pack = null;
  if (input.packCount !== undefined || input.pack) {
    if (input.packCount === undefined || !input.pack) return bad(res, 'pack_incomplete');
    let unitName = null;
    let sizeMilli = null;
    if (input.pack.source === 'identifier') {
      const idf = item.identifiers.find((i) => i.id === input.pack.identifierId && i.packSizeMilli);
      if (!idf) return bad(res, 'pack_not_found');
      unitName = idf.packUnit;
      sizeMilli = idf.packSizeMilli;
    } else if (input.pack.source === 'default') {
      if (!item.defaultPack) return bad(res, 'pack_not_found');
      unitName = item.defaultPack.unit;
      sizeMilli = item.defaultPack.sizeMilli;
    } else {
      const s = Q.parseQuantity(input.pack.size, item.baseUnit);
      if (s.error) return bad(res, s.error, { field: 'pack.size' });
      unitName = input.pack.unit;
      sizeMilli = s.milli;
    }
    const total = Q.packTotalMilli(input.packCount, sizeMilli, item.baseUnit);
    if (total.error) return bad(res, total.error);
    quantityMilli = total.milli;
    pack = { count: input.packCount, unit: unitName, sizeMilli };
  } else {
    const q = Q.parseQuantity(input.quantity, item.baseUnit);
    if (q.error) return bad(res, q.error, { field: 'quantity' });
    quantityMilli = q.milli;
  }

  const jobRef = await resolveJob(input.jobId, me);
  if (jobRef.error) return bad(res, jobRef.error);

  const actor = actorOf(me);
  const result = await store.recordMovement(sql, tenant.id, {
    itemId: item.id,
    kind: input.kind,
    quantityMilli,
    pack,
    estimated: input.kind !== 'take' && input.estimated === true,
    jobId: jobRef.job ? jobRef.job.id : null,
    jobLabel: jobRef.job ? jobRef.job.label : null,
    note: input.note,
    actor,
    idempotencyKey: key,
    requestHash: requestHash('move', { itemId: item.id, kind: input.kind, quantityMilli, pack, jobId: jobRef.job ? jobRef.job.id : null, note: input.note, estimated: input.estimated === true, actorId: actor.id }),
  });
  if (result.error === 'insufficient_stock') {
    return res.status(409).json({ error: 'insufficient_stock', balanceMilli: result.balanceMilli, unit: result.unit, requestedMilli: result.requestedMilli, recorded: Q.formatQuantity(result.balanceMilli, result.unit) });
  }
  if (result.error) return res.status(result.error === 'item_not_found' ? 404 : 409).json({ error: result.error });
  return res.status(result.replayed ? 200 : 201).json({
    item: result.item,
    movement: { ...result.movement, undo: undoInfo(result.movement, me, Date.now()) },
    replayed: result.replayed === true,
  });
}

async function count(sql, tenant, me, req, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const key = operationKey(req, res);
  if (!key) return;
  const input = parseOr400(CountBody, body, res);
  if (!input) return;
  const item = await store.getItem(sql, tenant.id, input.itemId);
  if (!item || item.archivedAt) return res.status(404).json({ error: item ? 'item_archived' : 'item_not_found' });
  const counted = Q.parseQuantity(input.countedQuantity, item.baseUnit, { allowZero: true });
  if (counted.error) return bad(res, counted.error, { field: 'countedQuantity' });
  const actor = actorOf(me);
  const result = await store.recordCount(sql, tenant.id, {
    itemId: item.id,
    countedMilli: counted.milli,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
    estimated: input.estimated === true,
    actor,
    idempotencyKey: key,
    requestHash: requestHash('count', { itemId: item.id, countedMilli: counted.milli, expectedVersion: input.expectedVersion, reason: input.reason, estimated: input.estimated === true, actorId: actor.id }),
  });
  if (result.error === 'stock_changed') {
    return res.status(409).json({ error: 'stock_changed', currentVersion: result.currentVersion, balanceMilli: result.balanceMilli, since: result.since });
  }
  if (result.error) return res.status(409).json({ error: result.error });
  if (!result.replayed) {
    await journal(me, 'workshop_stock.count_corrected', item.id, `Counted ${item.name}: ${Q.formatQuantity(counted.milli, item.baseUnit)}`, {
      countedMilli: counted.milli, deltaMilli: result.movement.quantityMilli, reason: input.reason,
    });
  }
  return res.status(result.replayed ? 200 : 201).json({ item: result.item, movement: result.movement, replayed: result.replayed === true });
}

async function undo(sql, tenant, me, req, body, res) {
  const key = operationKey(req, res);
  if (!key) return;
  const input = parseOr400(UndoBody, body, res);
  if (!input) return;
  const actor = actorOf(me);
  const result = await store.reverseMovement(
    sql,
    tenant.id,
    { movementId: input.movementId, reason: input.reason, actor, idempotencyKey: key, requestHash: requestHash('undo', { movementId: input.movementId, reason: input.reason, actorId: actor.id }) },
    (movement) => policy.undoDenial(movement, me, { nowMs: Date.now(), reason: input.reason }),
  );
  if (result.error === 'movement_not_found') return res.status(404).json({ error: 'movement_not_found' });
  if (result.error === 'undo_would_go_negative') {
    return res.status(409).json({ error: 'undo_would_go_negative', balanceMilli: result.balanceMilli, originalMilli: result.originalMilli, unit: result.unit, recorded: Q.formatQuantity(result.balanceMilli, result.unit) });
  }
  if (['undo_not_yours', 'undo_office_only', 'forbidden'].includes(result.error)) return res.status(403).json({ error: result.error });
  if (result.error === 'reason_required') return bad(res, 'reason_required');
  if (result.error) return res.status(409).json({ error: result.error, reversal: result.reversal || null });
  if (!result.replayed) {
    await journal(me, 'workshop_stock.movement_undone', result.item.id, `Undid a ${result.originalKind || 'stock'} movement on ${result.item.name}`, {
      movementId: input.movementId, reversalId: result.movement.id, reason: input.reason || null,
    });
  }
  return res.status(result.replayed ? 200 : 201).json({ item: result.item, movement: result.movement, replayed: result.replayed === true });
}

async function editItem(sql, tenant, me, id, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'item_not_found' });
  const input = parseOr400(EditBody, body, res);
  if (!input) return;
  const current = await store.getItem(sql, tenant.id, id);
  if (!current) return res.status(404).json({ error: 'item_not_found' });
  const patch = {};
  for (const k of ['name', 'brand', 'supplierName', 'variant', 'colourFinish', 'location', 'baseUnit']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  for (const k of ['manufacturerCode', 'supplierSku']) {
    if (input[k] === undefined) continue;
    if (input[k] === null) { patch[k] = null; continue; }
    const c = codes.cleanCode(input[k]);
    if (!c) return bad(res, 'code_invalid', { field: k });
    patch[k] = c;
  }
  const unit = patch.baseUnit || current.baseUnit;
  if (input.defaultPack !== undefined) {
    if (input.defaultPack === null) patch.defaultPack = null;
    else {
      const s = Q.parseQuantity(input.defaultPack.size, unit);
      if (s.error) return bad(res, s.error, { field: 'defaultPack.size' });
      patch.defaultPack = { unit: input.defaultPack.unit, sizeMilli: s.milli };
    }
  }
  // Keep the identifiers in step with the edited codes (and the brand/supplier that scope them).
  const identifierChanges = { retire: [], add: [] };
  const nextBrand = patch.brand !== undefined ? patch.brand : current.brand;
  const nextMfr = patch.manufacturerCode !== undefined ? patch.manufacturerCode : current.manufacturerCode;
  if (patch.brand !== undefined || patch.manufacturerCode !== undefined) {
    const before = current.manufacturerCode ? codes.identifierFor('manufacturer_code', current.manufacturerCode, { brand: current.brand }) : null;
    const after = nextMfr ? codes.identifierFor('manufacturer_code', nextMfr, { brand: nextBrand }) : null;
    if (!(before && after && before.valueKey === after.valueKey && before.scope === after.scope)) {
      if (before && !before.error) identifierChanges.retire.push(before);
      if (after && !after.error) identifierChanges.add.push(after);
    }
  }
  const nextSupplier = patch.supplierName !== undefined ? patch.supplierName : current.supplierName;
  const nextSku = patch.supplierSku !== undefined ? patch.supplierSku : current.supplierSku;
  if (patch.supplierName !== undefined || patch.supplierSku !== undefined) {
    const before = current.supplierSku ? codes.identifierFor('supplier_sku', current.supplierSku, { supplier: current.supplierName }) : null;
    const after = nextSku ? codes.identifierFor('supplier_sku', nextSku, { supplier: nextSupplier }) : null;
    if (!(before && after && before.valueKey === after.valueKey && before.scope === after.scope)) {
      if (before && !before.error) identifierChanges.retire.push(before);
      if (after && !after.error) identifierChanges.add.push(after);
    }
  }
  const result = await store.updateItem(sql, tenant.id, id, { patch, expectedRevision: input.expectedRevision, actor: actorOf(me), identifierChanges });
  if (result.error === 'unit_locked') return res.status(409).json({ error: 'unit_locked' });
  if (result.error === 'identifier_in_use') return res.status(409).json({ error: 'identifier_in_use', existing: result.existing || [] });
  if (result.error) return res.status(result.error === 'item_not_found' ? 404 : 409).json(result);
  if (!result.unchanged) {
    await journal(me, 'workshop_stock.item_updated', id, `Edited ${result.item ? result.item.name : 'a workshop item'}`, { fields: Object.keys(result.changes || {}) });
  }
  return res.status(200).json({ item: result.item || (await store.getItem(sql, tenant.id, id)), unchanged: result.unchanged === true });
}

async function identifier(sql, tenant, me, req, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  if (req.method === 'DELETE') {
    const id = String((req.query && req.query.id) || '');
    if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'identifier_not_found' });
    const r = await store.retireIdentifier(sql, tenant.id, id, actorOf(me));
    if (r.error) return res.status(404).json({ error: r.error });
    await journal(me, 'workshop_stock.identifier_removed', r.itemId, 'Removed a code from a workshop item', { identifierId: id });
    return res.status(200).json({ item: await store.getItem(sql, tenant.id, r.itemId) });
  }
  const input = parseOr400(IdentifierBody, body, res);
  if (!input) return;
  const item = await store.getItem(sql, tenant.id, input.itemId);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  const idf = codes.identifierFor(input.kind, input.value, { brand: item.brand, supplier: input.supplierName || item.supplierName });
  if (idf.error) return bad(res, idf.error);
  if ((input.packUnit && input.packSize === undefined) || (!input.packUnit && input.packSize !== undefined)) return bad(res, 'pack_incomplete');
  if (input.packUnit) {
    const s = Q.parseQuantity(input.packSize, item.baseUnit);
    if (s.error) return bad(res, s.error, { field: 'packSize' });
    idf.packUnit = input.packUnit;
    idf.packSizeMilli = s.milli;
  }
  const r = await store.addIdentifier(sql, tenant.id, item.id, idf, actorOf(me));
  if (r.error === 'identifier_in_use') return res.status(409).json({ error: 'identifier_in_use', existing: r.existing || [] });
  if (r.error) return res.status(409).json({ error: r.error });
  await journal(me, 'workshop_stock.identifier_added', item.id, `Added ${input.kind.replace('_', ' ')} ${idf.value} to ${item.name}`, { kind: input.kind, value: idf.value });
  return res.status(201).json({ item: await store.getItem(sql, tenant.id, item.id) });
}

async function archive(sql, tenant, me, body, res, archived) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const input = parseOr400(ItemIdBody, body, res);
  if (!input) return;
  const r = await store.setArchived(sql, tenant.id, input.itemId, archived, actorOf(me));
  if (r.error) return res.status(r.error === 'item_not_found' ? 404 : 409).json({ error: r.error });
  if (!r.unchanged) {
    await journal(me, archived ? 'workshop_stock.item_archived' : 'workshop_stock.item_restored', input.itemId, `${archived ? 'Archived' : 'Restored'} ${r.item.name}`, {});
  }
  return res.status(200).json({ item: r.item, unchanged: r.unchanged === true });
}

async function itemPhoto(sql, tenant, me, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const input = parseOr400(ItemPhotoBody, body, res);
  if (!input) return;
  const r = await store.replaceItemPhoto(sql, tenant.id, input.itemId, input.photoId, actorOf(me));
  if (r.error) return res.status(r.error === 'item_not_found' ? 404 : 409).json({ error: r.error });
  await journal(me, 'workshop_stock.photo_changed', input.itemId, 'Changed a workshop item photo', {});
  return res.status(200).json({ item: await store.getItem(sql, tenant.id, input.itemId) });
}

async function verify(sql, tenant, me, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const input = parseOr400(ItemIdBody, body, res);
  if (!input) return;
  const item = await store.getItem(sql, tenant.id, input.itemId);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  if (!item.manufacturerCode) return res.status(409).json({ error: 'no_code' });
  const cached = await store.getCachedLookup(sql, tenant.id, codes.brandKey(item.brand) || '', codes.codeKey(item.manufacturerCode));
  const v = verificationFromLookup(cached);
  const r = await store.recordVerification(sql, tenant.id, item.id, { status: v ? v.status : 'unverified', verification: v ? v.detail : null, actor: actorOf(me) });
  if (r.error) return res.status(404).json({ error: r.error });
  await journal(me, 'workshop_stock.verification_recorded', item.id, `Recorded the online check for ${item.name}: ${v ? v.status : 'unverified'}`, { status: v ? v.status : 'unverified' });
  return res.status(200).json({ item: await store.getItem(sql, tenant.id, item.id) });
}

// ── router ────────────────────────────────────────────────────────────────────

async function handler(req, res) {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const me = await requireAuth(req, res);
  if (!me) return;
  if (!(await isFlagEnabled(FLAG, me))) return res.status(404).json({ error: 'not found' });
  if (!policy.isEmployee(me.role)) return res.status(403).json({ error: 'forbidden' });

  const q = req.query || {};
  const action = String(q.action || '');
  const body = bodyOf(req);

  if (req.method === 'GET' && action === 'jobs') return jobs(me, q, res);

  let sql;
  let tenant;
  try {
    sql = getDb({ mode: req.method === 'GET' ? 'read' : 'write' });
    tenant = await store.resolveTenant(sql);
  } catch (e) {
    console.error('[workshop-stock] store unavailable', { code: (e && e.code) || 'db' });
    return res.status(503).json({ error: 'store_unavailable' });
  }
  if (!tenant) return res.status(503).json({ error: 'store_unprovisioned' });

  if (req.method === 'GET') {
    switch (action) {
      case '':
      case 'list': return list(sql, tenant, me, req, res);
      case 'item': return itemDetail(sql, tenant, me, String(q.id || ''), res);
      case 'history': return history(sql, tenant, me, q, res);
      case 'recent': return recent(sql, tenant, me, res);
      case 'operation': return operation(sql, tenant, me, q.key, res);
      case 'photo': return servePhoto(sql, tenant, me, String(q.id || ''), res);
      default: return res.status(400).json({ error: 'unknown_action' });
    }
  }
  if (req.method === 'POST') {
    switch (action) {
      case 'read-photo': return readPhoto(sql, tenant, me, body, res);
      case 'store-photo': return storePhotoOnly(sql, tenant, me, body, res);
      case 'lookup': return lookup(sql, tenant, me, body, res);
      case 'create': return create(sql, tenant, me, req, body, res);
      case 'move': return move(sql, tenant, me, req, body, res);
      case 'count': return count(sql, tenant, me, req, body, res);
      case 'undo': return undo(sql, tenant, me, req, body, res);
      case 'identifier': return identifier(sql, tenant, me, req, body, res);
      case 'archive': return archive(sql, tenant, me, body, res, true);
      case 'restore': return archive(sql, tenant, me, body, res, false);
      case 'item-photo': return itemPhoto(sql, tenant, me, body, res);
      case 'verify': return verify(sql, tenant, me, body, res);
      default: return res.status(400).json({ error: 'unknown_action' });
    }
  }
  if (req.method === 'PUT' && action === 'item') return editItem(sql, tenant, me, String(q.id || ''), body, res);
  if (req.method === 'DELETE' && action === 'identifier') return identifier(sql, tenant, me, req, body, res);
  return res.status(405).json({ error: 'method_not_allowed' });
}

module.exports = withErrorCapture(handler, 'workshop-stock');
module.exports.__test = { stableStringify, requestHash, verificationFromLookup, identifiersForItem };
