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
//   GET    ?action=operation&key=             reconcile a save whose response was lost (own operations; office: any)
//   GET    ?action=photo&id=[&size=thumb]     a product photo or its list-size copy (authenticated proxy — the Blob URL never leaves the server)
//   GET    ?action=jobs&q=                    job picker for the optional job note
//   GET    ?action=location-matrix            the racks and "these words go in this bin" rules   OFFICE
//   PUT    ?action=location-matrix { expectedRevision, racks, rules }   save the whole matrix (compare-and-set)   OFFICE
//   POST   ?action=read-photo  { dataUrl, thumbDataUrl?, purpose: 'add'|'take', intake? }  read a photo, match the catalogue (writes no stock; intake = the camera table, OFFICE, its own limits)
//   POST   ?action=store-photo { dataUrl, thumbDataUrl? }  keep a product photo for a new item without reading it again (no AI call)
//   POST   ?action=lookup      { brand?, manufacturerCode, colourFinish?, variantDetails? }  online code check (allowlisted sources)
//   POST   ?action=create      { …item, openingQuantity | pack…, lookupCheck?, idempotencyKey }  new item + opening balance, atomically
//   POST   ?action=move        { itemId, kind: add|take|return, quantity | packCount+pack[+looseQuantity], jobId?, note?, estimated?, idempotencyKey }
//                              pack: the pack the screen showed, with its size — refused (409 pack_changed) if the office changed it
//   POST   ?action=count       { itemId, countedQuantity, expectedVersion, reason, estimated?, idempotencyKey }   OFFICE
//   POST   ?action=undo        { movementId, reason?, idempotencyKey }   own recent (worker) · any with reason (office)
//   PUT    ?action=item&id=    { expectedRevision, …fields }             OFFICE catalogue edit (compare-and-set)
//   POST   ?action=identifier  { itemId, kind, value, supplierName?, packUnit?, packSize? }   OFFICE
//   DELETE ?action=identifier&id=                                        OFFICE
//   POST   ?action=archive | restore  { itemId }                         OFFICE (restore says which codes another item now holds)
//   POST   ?action=item-photo  { itemId, photoId, slot?: product|location }   OFFICE (location: photoId may be null = remove)
//   POST   ?action=type        { key?, label, unit, fields: [{ key?, label }] }   OFFICE — add a category (no key) or change one (its key); fields are only added or renamed
//                              the crew: slot location only, to FILL a missing photo of where it lives with one they took
//   POST   ?action=verify      { itemId }   OFFICE — record the cached online check on an item
//
// Shopping lists (a plan, never a stock record; shared with the crew — once 20261101100000 is applied):
//   GET    ?action=lists                         open lists + those finished in the last week
//   POST   ?action=list        { id, name?, jobId?, done? }                     start (id from the phone) or change a list
//   DELETE ?action=list&id=                                                     its owner or the office
//   POST   ?action=list-line   { listId, id, itemId? | text?, quantity?, unit?, got?, position? }   add or change a line
//   DELETE ?action=list-line&id=
//   (a TAKE ticks the line it collects: POST ?action=move { …, listLineId } — same transaction; its undo un-ticks it)
//
// Rules every path follows: the actor, role and company scope come from the
// session and the server — never from the body; bodies are Zod-validated;
// quantities are decimal strings parsed exactly; every ledger write needs an
// Idempotency-Key (header or body `idempotencyKey`): a used key is answered
// first — the saved result for the same request (even if the item, its pack or
// the job changed since), a refusal for a different one; nothing reports
// success before Postgres committed; errors are { error: <stable code> } —
// never an exception message. 503 store_unavailable / store_unprovisioned mean
// nothing was attempted, so nothing was saved.
// A job on a movement is informational only: no job cost is written anywhere.

'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { getDb, closeDb } = require('./_lib/supabase-db');
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
const { withTimeout } = require('./_lib/with-timeout');

const FLAG = 'workshop_stock';

// Burst limits per user (per warm instance) + a durable daily ceiling per tenant
// for the two calls that cost money.
const photoReadLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30 });
const lookupLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 20 });
// The camera table reads one object at a time in bulk, so it has its own burst
// limit and its own daily counter — a big session can't use up the crew's reads.
const intakeReadLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 300 });
const DAILY_PHOTO_READS = Math.max(1, Number(process.env.STOCK_DAILY_PHOTO_READS || 300));
const DAILY_LOOKUPS = Math.max(1, Number(process.env.STOCK_DAILY_LOOKUPS || 60));
const DAILY_INTAKE_READS = Math.max(1, Number(process.env.STOCK_DAILY_INTAKE_READS || 2000));
const LOOKUP_TTL_DAYS = { manufacturer_code_matched: 30, possible_match: 7, no_match: 3 };
const CLEANUP_BUDGET_MS = 4000;

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

// ── helpers ───────────────────────────────────────────────────────────────────

function actorOf(me) {
  return { id: me.id, name: me.name || me.username || '', role: me.role || null };
}

function bodyOf(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
}

/**
 * Full packs + some loose (2026-11-03, "some items aren't always in
 * packaging"). The ledger keeps a pack only when the quantity is exactly
 * count × size (a database rule), so with loose ones the movement is the plain
 * total and the note says how it was made up: "3 boxes of 10 + 4 loose".
 * Returns { milli, pack, note } or { error }.
 */
function withLoose(totalMilli, pack, looseRaw, unit, note) {
  if (looseRaw === undefined || looseRaw === '') return { milli: totalMilli, pack, note };
  const loose = Q.parseQuantity(looseRaw, unit, { allowZero: true });
  if (loose.error) return { error: loose.error, field: 'looseQuantity' };
  if (loose.milli === 0) return { milli: totalMilli, pack, note };
  const milli = totalMilli + loose.milli;
  if (milli > Q.MAX_MOVE_MILLI) return { error: 'quantity_too_large' };
  const unitWord = pack.unit || 'pack';
  const plural = pack.count === 1 ? unitWord : (unitWord === 'box' ? 'boxes' : `${unitWord}s`);
  const amount = (m) => (unit === 'each' ? Q.formatNumber(m) : Q.formatQuantity(m, unit));
  const madeUp = `${pack.count} ${plural} of ${amount(pack.sizeMilli)} + ${amount(loose.milli)} loose`;
  return { milli, pack: null, note: [madeUp, note].filter(Boolean).join(' · ').slice(0, 200) };
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

/**
 * A used operation key, answered before anything else is read: the saved result
 * (200, replayed) for the same request, 409 idempotency_conflict for another.
 * Returns true when it answered. The hash is of the request AS SENT — the same
 * bytes on every retry — so a retry replays even when the item, its pack or the
 * job changed after the first attempt landed.
 */
async function answeredByReplay(sql, tenant, me, key, hash, res, extra = () => ({})) {
  const prior = await store.replayOperation(sql, tenant.id, key, hash);
  if (!prior) return false;
  if (prior.error) {
    res.status(409).json({ error: prior.error });
    return true;
  }
  res.status(200).json({
    item: prior.item,
    movement: { ...prior.movement, undo: undoInfo(prior.movement, me, Date.now()) },
    replayed: true,
    ...extra(prior),
  });
  return true;
}

// ── schemas ───────────────────────────────────────────────────────────────────

const qty = z.union([z.string().trim().max(24), z.number()]);
const optText = (max) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const uuid = z.string().uuid();
const packUnit = z.enum(Q.PACK_UNITS);

// identifier / default: the pack the screen showed, WITH the size it showed —
// the server refuses (pack_changed) rather than record a different quantity.
const shownSize = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PackPick = z.union([
  z.object({ source: z.literal('identifier'), identifierId: uuid, sizeMilli: shownSize }),
  z.object({ source: z.literal('default'), sizeMilli: shownSize }),
  z.object({ source: z.literal('custom'), unit: packUnit, size: qty }),
]);

// The size/rating words a check compared: anything a phone sends is trimmed to
// what the check uses (≤ 8 words of ≤ 30 characters), never refused.
const variantDetails = z.array(z.string().max(200)).max(50).optional().transform((v) => codes.variantDetailsFrom(v || []));
const LookupCheck = z.object({
  brand: optText(60),
  manufacturerCode: z.string().trim().min(1).max(48),
  colourFinish: optText(40),
  variantDetails,
});

// An item's type and that type's fields (the catalogue lives in the app,
// src/domains/workshop-stock/types.ts): a lower-case key, and short texts.
// Whitespace is collapsed and empty fields dropped; never refused for being blank.
const Category = z.string().trim().regex(/^[a-z][a-z0-9_]{1,31}$/);
const Specs = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(60))
  .refine((o) => Object.keys(o).length <= 16, { message: 'too_many_fields' })
  .transform((o) => {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const t = v.replace(/\s+/g, ' ').trim();
      if (t) out[k] = t;
    }
    return out;
  });

const MoveBody = z.object({
  itemId: uuid,
  kind: z.enum(['add', 'take', 'return']),
  quantity: qty.optional(),
  packCount: z.number().int().min(1).max(Q.MAX_PACK_COUNT).optional(),
  pack: PackPick.optional(),
  // out of the box, alongside full packs: "3 boxes of 10 + 4 loose" (2026-11-03)
  looseQuantity: qty.optional(),
  jobId: optText(120),
  note: optText(200),
  estimated: z.boolean().optional(),
  // a shopping-list line this take collects (ticked in the same transaction)
  listLineId: uuid.optional(),
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
  // a photo of WHERE it lives, stored like photoId — or the same photo another
  // item already shows (setting up a shelf: one shelf, one photo)
  locationPhotoId: uuid.nullish(),
  locationPhotoFromItemId: uuid.nullish(),
  category: Category.nullish(),
  specs: Specs.optional(),
  openingQuantity: qty.optional(),
  packCount: z.number().int().min(1).max(Q.MAX_PACK_COUNT).optional(),
  packUnit: packUnit.optional(),
  packSize: qty.optional(),
  // out of the box, alongside the full packs (2026-11-03)
  looseQuantity: qty.optional(),
  rememberPack: z.boolean().optional(),
  estimated: z.boolean().optional(),
  // the online check the worker accepted (exactly what was asked — the lookup
  // response's `check`); the server re-reads its own cached result for it
  lookupCheck: LookupCheck.optional(),
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
  category: Category.nullable().optional(),
  specs: Specs.optional(),
});

const IdentifierBody = z.object({
  itemId: uuid,
  kind: z.enum(codes.IDENTIFIER_KINDS),
  value: z.string().trim().min(2).max(48),
  supplierName: optText(60),
  packUnit: packUnit.optional(),
  packSize: qty.optional(),
});

// The list-size copy is optional and never fails an upload: anything unusable
// (too big, not a JPEG, not a string) is simply dropped by photo.readThumbUpload.
const thumbDataUrl = z.unknown().optional().transform((v) => (typeof v === 'string' ? v : null));
const ReadPhotoBody = z.object({ dataUrl: z.string().min(16), thumbDataUrl, purpose: z.enum(['add', 'take']), intake: z.boolean().optional() });
const LookupBody = z.object({
  brand: optText(60),
  manufacturerCode: z.string().trim().min(1).max(48),
  colourFinish: optText(40),
  variantDetails,
  refresh: z.boolean().optional(),
});
const ItemIdBody = z.object({ itemId: uuid });
// slot 'location' = the photo of where it lives, which may also be removed (photoId null)
const ItemPhotoBody = z
  .object({ itemId: uuid, photoId: uuid.nullable(), slot: z.enum(['product', 'location']).default('product') })
  .refine((b) => b.slot === 'location' || b.photoId !== null, { path: ['photoId'] });

// A category the office makes (20261103100000). No key = a new one; its key
// and its fields' keys are made from the names here, on the server.
const TypeBody = z.object({
  key: z.string().regex(/^c_[a-z0-9_]{1,29}$/).optional(),
  label: z.string().trim().min(1).max(40),
  unit: z.enum(Q.UNIT_KEYS).default('each'),
  fields: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
    label: z.string().trim().min(1).max(30),
  })).max(8).default([]),
});

const ListBody = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(80).optional(),
  // null clears the job; absent leaves it
  jobId: z.string().trim().max(120).nullable().optional(),
  done: z.boolean().optional(),
});
const ListLineBody = z.object({
  listId: uuid,
  id: uuid,
  itemId: uuid.nullish(),
  text: z.string().trim().max(160).optional(),
  // how many are needed (null clears it)
  quantity: qty.nullable().optional(),
  unit: z.enum(Q.UNIT_KEYS).nullable().optional(),
  got: z.boolean().optional(),
  position: z.number().int().min(0).max(100000).optional(),
});

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

// ── location matrix (office) ──────────────────────────────────────────────────

const MatrixBody = z.object({
  expectedRevision: z.number().int().min(0),
  racks: z.array(z.object({
    id: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(30),
    shelves: z.number().int().min(1).max(30),
    bins: z.number().int().min(1).max(60),
  })).max(60),
  rules: z.array(z.object({
    id: z.string().trim().min(1).max(60),
    words: z.string().trim().min(1).max(80),
    rackId: z.string().trim().min(1).max(60),
    shelf: z.number().int().min(1),
    bin: z.number().int().min(1),
  })).max(1000),
});

async function locationMatrix(sql, tenant, me, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  return res.status(200).json(await store.getLocationMatrix(sql, tenant.id));
}

async function saveLocationMatrix(sql, tenant, me, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const input = parseOr400(MatrixBody, body, res);
  if (!input) return;
  const racks = new Map(input.racks.map((r) => [r.id, r]));
  if (racks.size !== input.racks.length) return bad(res, 'rack_duplicate');
  const names = new Set(input.racks.map((r) => r.name.toLowerCase()));
  if (names.size !== input.racks.length) return bad(res, 'rack_duplicate');
  for (const rule of input.rules) {
    const rack = racks.get(rule.rackId);
    if (!rack || rule.shelf > rack.shelves || rule.bin > rack.bins) return bad(res, 'rule_out_of_range', { ruleId: rule.id });
  }
  const current = await store.getLocationMatrix(sql, tenant.id);
  if (!current.available) return res.status(503).json({ error: 'matrix_unavailable' });
  const saved = await store.saveLocationMatrix(sql, tenant.id, { racks: input.racks, rules: input.rules }, input.expectedRevision, actorOf(me));
  if (saved.error) return res.status(409).json({ error: saved.error, revision: current.revision });
  await journal(me, 'workshop_stock.location_matrix_saved', 'location-matrix', `Saved the location matrix: ${input.racks.length} racks, ${input.rules.length} rules`, { revision: saved.revision });
  return res.status(200).json({ available: true, matrix: { racks: input.racks, rules: input.rules }, ...saved });
}

// ── reads ─────────────────────────────────────────────────────────────────────

async function list(sql, tenant, me, req, res) {
  const office = policy.isOffice(me.role);
  const includeArchived = office && req.query && req.query.archived === '1';
  // One query at a time on the instance's single pooled connection
  // (2026-11-02): firing these together hung cold instances on the pooler.
  // The capability check is cached per instance, so this costs nothing warm.
  const locationPhoto = await store.hasLocationPhoto(sql);
  const types = await store.hasTypes(sql);
  const lists = await store.hasLists(sql);
  const customTypesReady = await store.hasCustomTypes(sql);
  const items = await store.listItems(sql, tenant.id, { includeArchived });
  const customTypes = customTypesReady ? await store.listCustomTypes(sql, tenant.id) : [];
  return res.status(200).json({
    items,
    viewer: { id: me.id, office },
    // locationPhoto / types / lists: what this database has yet (later, additive migrations)
    capabilities: { photoRead: vision.enabled(), lookup: search.enabled(), locationPhoto: locationPhoto === true, types: types === true, lists: lists === true, customTypes: customTypesReady === true },
    // the office's own categories, alongside the built-in ones the app knows
    customTypes,
    undoMinutes: policy.WORKER_UNDO_MINUTES,
    asOf: new Date().toISOString(),
  });
}

async function itemDetail(sql, tenant, me, id, res) {
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'item_not_found' });
  const item = await store.getItem(sql, tenant.id, id);
  if (!item || (item.archivedAt && !policy.isOffice(me.role))) return res.status(404).json({ error: 'item_not_found' });
  // one at a time on the single pooled connection (see list)
  const movements = await store.listMovements(sql, tenant.id, id, { limit: 50 });
  const events = policy.isOffice(me.role) ? await store.itemEvents(sql, tenant.id, id) : null;
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

async function operation(sql, tenant, me, key, res) {
  if (!KEY_RE.test(String(key || ''))) return bad(res, 'idempotency_key_invalid');
  const movement = await store.getOperation(sql, tenant.id, key);
  // Someone else's operation reads exactly like "never saved" — no probing.
  if (!movement || (movement.actorId !== me.id && !policy.isOffice(me.role))) return res.status(200).json({ found: false });
  const item = await store.getItem(sql, tenant.id, movement.itemId);
  return res.status(200).json({ found: true, movement: { ...movement, undo: undoInfo(movement, me, Date.now()) }, item });
}

async function servePhoto(sql, tenant, me, id, size, res) {
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'not_found' });
  const p = await store.getPhotoForServing(sql, tenant.id, id, { viewerId: me.id, office: policy.isOffice(me.role), size: size === 'thumb' ? 'thumb' : 'full' });
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

/**
 * Delete expired photos. Each is marked first (from then on nothing can claim
 * it), then its blobs go; a failed blob delete is retried by a later pass.
 */
async function cleanupPhotos(sql, tenantId) {
  const due = await store.photosDueForDeletion(sql, tenantId, 3);
  for (const p of due) {
    try {
      if (!p.marked && !(await store.markPhotoDeleted(sql, tenantId, p.id))) continue; // claimed meanwhile
      await photo.deletePhoto([p.blobUrl, p.thumbUrl]);
      await store.markBlobDeleted(sql, tenantId, p.id);
    } catch {
      // the next pass retries it
    }
  }
}

/**
 * Cleanup rides along with the slow part of an upload (the photo read, the blob
 * write) instead of in front of it, capped so it can never hold a response up
 * for long. Never throws.
 */
function cleanupAlongside(sql, tenantId) {
  return withTimeout(cleanupPhotos(sql, tenantId), CLEANUP_BUDGET_MS, 'photo cleanup').catch(() => {});
}

/** Store a validated upload (+ its list-size copy when there is a usable one) and record it as pending. */
async function keepPhoto(sql, tenant, me, up, thumbDataUrl) {
  const thumbUp = photo.readThumbUpload(thumbDataUrl);
  const [stored, thumb] = await Promise.all([
    photo.storePhoto({ tenantSlug: tenant.slug, bytes: up.bytes, contentType: up.contentType }),
    thumbUp
      ? photo.storePhoto({ tenantSlug: tenant.slug, bytes: thumbUp.bytes, contentType: thumbUp.contentType, thumb: true })
        .then((t) => ({ url: t.url, pathname: t.pathname, byteSize: thumbUp.bytes.length }))
        .catch(() => null)
      : Promise.resolve(null),
  ]);
  return store.insertPhoto(sql, tenant.id, {
    blobUrl: stored.url, blobPathname: stored.pathname, contentType: up.contentType, byteSize: up.bytes.length,
    width: up.width, height: up.height, sha256: up.sha256, thumb, actor: actorOf(me), ttlHours: 24,
  });
}

function itemSummary(item) {
  return {
    id: item.id, name: item.name, brand: item.brand, manufacturerCode: item.manufacturerCode, supplierSku: item.supplierSku,
    supplierName: item.supplierName, variant: item.variant, colourFinish: item.colourFinish, location: item.location,
    baseUnit: item.baseUnit, balanceMilli: item.balanceMilli, estimated: item.estimated, version: item.version,
    photoId: item.photoId, locationPhotoId: item.locationPhotoId ?? null, defaultPack: item.defaultPack, identifiers: item.identifiers,
    category: item.category ?? null, specs: item.specs ?? {},
  };
}

async function readPhoto(sql, tenant, me, body, res) {
  const input = parseOr400(ReadPhotoBody, body, res);
  if (!input) return;
  if (input.intake && !policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const up = photo.readPhotoUpload(input.dataUrl);
  if (up.error) return res.status(up.status).json({ error: up.error, maxBytes: up.maxBytes });
  const limiter = input.intake ? intakeReadLimiter : photoReadLimiter;
  if (limiter.isLimited(me.id)) {
    return res.status(429).json({ error: 'photo_limit', retryAfterSec: limiter.retryAfterSec(me.id) });
  }

  const cleanup = cleanupAlongside(sql, tenant.id);
  let photoId = null;
  let photoStored = null;
  if (input.purpose === 'add') {
    try {
      photoId = await keepPhoto(sql, tenant, me, up, input.thumbDataUrl);
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
    const usage = await store.consumeUsage(sql, tenant.id, input.intake ? 'intake_read' : 'photo_read', input.intake ? DAILY_INTAKE_READS : DAILY_PHOTO_READS);
    if (!usage.allowed) {
      readStatus = 'daily_limit';
    } else {
      limiter.record(me.id);
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
  await cleanup;
  return res.status(200).json({
    readStatus,
    reading: reading ? { legibility: reading.legibility, note: reading.note, products: reading.products } : null,
    matches,
    candidateItems,
    photoId,
    photoStored,
  });
}

const StorePhotoBody = z.object({ dataUrl: z.string().min(16), thumbDataUrl });

/** Keep a product photo as 'pending' (claimed by the create that follows, else expires). No AI call. */
async function storePhotoOnly(sql, tenant, me, body, res) {
  const input = parseOr400(StorePhotoBody, body, res);
  if (!input) return;
  const up = photo.readPhotoUpload(input.dataUrl);
  if (up.error) return res.status(up.status).json({ error: up.error, maxBytes: up.maxBytes });
  const cleanup = cleanupAlongside(sql, tenant.id);
  let photoId;
  try {
    photoId = await keepPhoto(sql, tenant, me, up, input.thumbDataUrl);
  } catch (e) {
    console.error('[workshop-stock] photo store failed', { code: (e && e.code) || 'blob' });
    await cleanup;
    return res.status(502).json({ error: 'photo_store_failed' });
  }
  await cleanup;
  return res.status(201).json({ photoId });
}

async function lookup(sql, tenant, me, body, res) {
  const input = parseOr400(LookupBody, body, res);
  if (!input) return;
  const code = codes.cleanCode(input.manufacturerCode);
  if (!code) return res.status(200).json({ status: 'not_checked', reasons: ['That doesn\'t look like a product code — check it against the label'], candidate: null, sources: [] });
  // Exactly what this check is for — echoed back so a save can name it (lookupCheck).
  const check = { brand: input.brand, manufacturerCode: code, colourFinish: input.colourFinish, variantDetails: input.variantDetails };
  const key = codes.lookupKey(check);
  const refresh = input.refresh === true && policy.isOffice(me.role);
  if (!refresh) {
    const cached = await store.getCachedLookup(sql, tenant.id, key);
    if (cached) return res.status(200).json({ ...cached, check });
  }
  if (!search.enabled()) {
    return res.status(200).json({ status: 'not_configured', reasons: ['The online product check isn\'t set up — the item can still be saved'], candidate: null, sources: [], code, check });
  }
  if (lookupLimiter.isLimited(me.id)) {
    return res.status(429).json({ error: 'lookup_limit', retryAfterSec: lookupLimiter.retryAfterSec(me.id) });
  }
  const usage = await store.consumeUsage(sql, tenant.id, 'lookup', DAILY_LOOKUPS);
  if (!usage.allowed) {
    return res.status(200).json({ status: 'unavailable', reasons: ['Today\'s online checks are used up — save it now and check it tomorrow'], candidate: null, sources: [], code, check });
  }
  lookupLimiter.record(me.id);
  const result = await lookupProduct(
    { brand: input.brand, manufacturerCode: code, colourFinish: input.colourFinish, variantDetails: input.variantDetails },
    { search: search.searchListings, fetchPage: fetchAllowlistedPage, configured: true },
  );
  // Only an answer is cached: never "couldn't check", never a no-match that
  // couldn't open every page it found.
  if (LOOKUP_TTL_DAYS[result.status] && !result.incomplete) {
    try { await store.putCachedLookup(sql, tenant.id, key, result.status, result, LOOKUP_TTL_DAYS[result.status]); } catch { /* cache is an optimisation */ }
  }
  return res.status(200).json({ ...result, cached: false, check });
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
  const actor = actorOf(me);
  const hash = requestHash('create', { ...input, actorId: actor.id });
  // A retried create returns the item it made — with its photo, if it claimed one.
  if (await answeredByReplay(sql, tenant, me, key, hash, res, (r) => ({ photoAttached: !input.photoId || Boolean(r.item.photoId), locationPhotoAttached: !(input.locationPhotoId || input.locationPhotoFromItemId) || Boolean(r.item.locationPhotoId), verificationStatus: r.item.verificationStatus }))) return;
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
  let openingNote = input.note;
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
    const mixed = withLoose(openingMilli, pack, input.looseQuantity, unit, input.note);
    if (mixed.error) return bad(res, mixed.error, mixed.field ? { field: mixed.field } : {});
    openingMilli = mixed.milli;
    pack = mixed.pack;
    openingNote = mixed.note;
  } else if (input.openingQuantity !== undefined && input.openingQuantity !== '') {
    const q = Q.parseQuantity(input.openingQuantity, unit, { allowZero: true });
    if (q.error) return bad(res, q.error, { field: 'openingQuantity' });
    openingMilli = q.milli;
  }

  const identifiers = identifiersForItem({ brand: input.brand, manufacturerCode, supplierSku, supplierName: input.supplierName, barcode });
  if (identifiers.some((i) => i.error)) return bad(res, 'code_invalid');

  // The verification is the SERVER's cached result for the check the worker
  // accepted — a client cannot claim "matched"; it can only name the check. And
  // only while that check still describes this item: same code, and the brand /
  // colour / size it was made for (or that the listing itself showed).
  let verificationStatus = 'unverified';
  let verification = null;
  let lookupSummary = null;
  if (input.lookupCheck && manufacturerCode) {
    const lk = codes.lookupKey(input.lookupCheck);
    const cached = lk ? await store.getCachedLookup(sql, tenant.id, lk) : null;
    const v = verificationFromLookup(cached);
    const applies = v && codes.checkApplies(input.lookupCheck, cached.candidate, { brand: input.brand, manufacturerCode, colourFinish: input.colourFinish, variant: input.variant });
    if (applies) {
      verificationStatus = v.status;
      verification = v.detail;
      lookupSummary = { status: v.status, sourceUrl: v.detail.sourceUrl, checkedAt: v.detail.checkedAt };
    } else {
      lookupSummary = { status: 'not_applied', reason: v ? 'item_differs_from_check' : 'check_not_found' };
    }
  }

  // The location photo, and the type with its fields, are only written once
  // their columns exist (the migrations can land after this code); before that
  // they are simply not kept.
  const [locationColumn, typeColumns] = await Promise.all([
    input.locationPhotoId || input.locationPhotoFromItemId ? store.hasLocationPhoto(sql) : false,
    input.category || (input.specs && Object.keys(input.specs).length) ? store.hasTypes(sql) : false,
  ]);
  const locationPhotoId = input.locationPhotoId && locationColumn === true ? input.locationPhotoId : null;
  const locationPhotoFromItemId = !input.locationPhotoId && input.locationPhotoFromItemId && locationColumn === true ? input.locationPhotoFromItemId : null;
  const askedForLocation = Boolean(input.locationPhotoId || input.locationPhotoFromItemId);

  const result = await store.createItemWithOpening(sql, tenant.id, {
    item: {
      name: input.name, brand: input.brand, manufacturerCode, supplierSku, supplierName: supplierSku ? input.supplierName : null,
      variant: input.variant, colourFinish: input.colourFinish, baseUnit: unit, location: input.location, defaultPack,
    },
    identifiers,
    photoId: input.photoId || null,
    locationPhotoId,
    locationPhotoFromItemId,
    category: typeColumns === true ? input.category || null : null,
    specs: typeColumns === true ? input.specs || {} : {},
    openingMilli,
    pack,
    estimated: input.estimated === true,
    note: openingNote,
    verificationStatus,
    verification,
    provenance: { fields: input.provenance || {}, lookup: lookupSummary },
    actor,
    actorIsOffice: policy.isOffice(me.role),
    idempotencyKey: key,
    requestHash: hash,
  });
  if (result.error === 'duplicate_item') return res.status(409).json({ error: 'duplicate_item', existing: result.existing });
  if (result.error === 'idempotency_conflict') return res.status(409).json({ error: 'idempotency_conflict' });
  if (result.error) return res.status(409).json({ error: result.error });
  // The crew's creates are in the item's own history (workshop_stock_item_events);
  // the shared audit journal — one blob, read-modify-write — only carries the
  // office's catalogue changes, so a workshop set-up session can't contend on it.
  if (!result.replayed && policy.isOffice(me.role)) {
    await journal(me, 'workshop_stock.item_created', result.item.id, `Added ${result.item.name} to workshop stock`, {
      unit, verificationStatus, photo: Boolean(result.item.photoId),
    });
  }
  return res.status(result.replayed ? 200 : 201).json({
    item: result.item,
    movement: { ...result.movement, undo: undoInfo(result.movement, me, Date.now()) },
    replayed: result.replayed === true,
    photoAttached: result.replayed ? !input.photoId || Boolean(result.item.photoId) : result.photoAttached !== false,
    locationPhotoAttached: result.replayed ? !askedForLocation || Boolean(result.item.locationPhotoId) : Boolean(locationPhotoId || locationPhotoFromItemId || !askedForLocation) && result.locationPhotoAttached !== false,
    verificationStatus: result.item.verificationStatus,
  });
}

async function move(sql, tenant, me, req, body, res) {
  const key = operationKey(req, res);
  if (!key) return;
  const input = parseOr400(MoveBody, body, res);
  if (!input) return;
  const actor = actorOf(me);
  const hash = requestHash('move', { ...input, actorId: actor.id });
  if (await answeredByReplay(sql, tenant, me, key, hash, res)) return;
  const item = await store.getItem(sql, tenant.id, input.itemId);
  if (!item || item.archivedAt) return res.status(404).json({ error: item ? 'item_archived' : 'item_not_found' });

  let quantityMilli;
  let pack = null;
  let moveNote = input.note;
  if (input.packCount !== undefined || input.pack) {
    if (input.packCount === undefined || !input.pack) return bad(res, 'pack_incomplete');
    let unitName = null;
    let sizeMilli = null;
    if (input.pack.source === 'identifier') {
      const idf = item.identifiers.find((i) => i.id === input.pack.identifierId && i.packSizeMilli);
      if (!idf) return res.status(409).json({ error: 'pack_not_found' });
      unitName = idf.packUnit;
      sizeMilli = idf.packSizeMilli;
    } else if (input.pack.source === 'default') {
      if (!item.defaultPack) return res.status(409).json({ error: 'pack_not_found' });
      unitName = item.defaultPack.unit;
      sizeMilli = item.defaultPack.sizeMilli;
    } else {
      const s = Q.parseQuantity(input.pack.size, item.baseUnit);
      if (s.error) return bad(res, s.error, { field: 'pack.size' });
      unitName = input.pack.unit;
      sizeMilli = s.milli;
    }
    // The worker confirmed "N boxes of the size on the screen": if the office has
    // changed that size since, ask again — never record a different quantity.
    if (input.pack.source !== 'custom' && input.pack.sizeMilli !== sizeMilli) {
      return res.status(409).json({ error: 'pack_changed', pack: { unit: unitName, sizeMilli } });
    }
    const total = Q.packTotalMilli(input.packCount, sizeMilli, item.baseUnit);
    if (total.error) return bad(res, total.error);
    quantityMilli = total.milli;
    pack = { count: input.packCount, unit: unitName, sizeMilli };
    const mixed = withLoose(quantityMilli, pack, input.looseQuantity, item.baseUnit, input.note);
    if (mixed.error) return bad(res, mixed.error, mixed.field ? { field: mixed.field } : {});
    quantityMilli = mixed.milli;
    pack = mixed.pack;
    moveNote = mixed.note;
  } else {
    const q = Q.parseQuantity(input.quantity, item.baseUnit);
    if (q.error) return bad(res, q.error, { field: 'quantity' });
    quantityMilli = q.milli;
  }

  const jobRef = await resolveJob(input.jobId, me);
  if (jobRef.error) return bad(res, jobRef.error);
  // Only a take collects a list line, and only once the lists exist.
  const listLineId = input.listLineId && input.kind === 'take' && (await store.hasLists(sql)) === true ? input.listLineId : null;

  const result = await store.recordMovement(sql, tenant.id, {
    itemId: item.id,
    kind: input.kind,
    quantityMilli,
    pack,
    estimated: input.kind !== 'take' && input.estimated === true,
    jobId: jobRef.job ? jobRef.job.id : null,
    jobLabel: jobRef.job ? jobRef.job.label : null,
    note: moveNote,
    listLineId,
    actor,
    idempotencyKey: key,
    requestHash: hash,
  });
  if (result.error === 'insufficient_stock') {
    return res.status(409).json({ error: 'insufficient_stock', balanceMilli: result.balanceMilli, unit: result.unit, requestedMilli: result.requestedMilli, recorded: Q.formatQuantity(result.balanceMilli, result.unit) });
  }
  if (result.error) return res.status(result.error === 'item_not_found' ? 404 : 409).json({ error: result.error });
  return res.status(result.replayed ? 200 : 201).json({
    item: result.item,
    movement: { ...result.movement, undo: undoInfo(result.movement, me, Date.now()) },
    replayed: result.replayed === true,
    ...(listLineId && !result.replayed ? { lineTicked: result.lineTicked === true } : {}),
  });
}

async function count(sql, tenant, me, req, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const key = operationKey(req, res);
  if (!key) return;
  const input = parseOr400(CountBody, body, res);
  if (!input) return;
  const actor = actorOf(me);
  const hash = requestHash('count', { ...input, actorId: actor.id });
  if (await answeredByReplay(sql, tenant, me, key, hash, res)) return;
  const item = await store.getItem(sql, tenant.id, input.itemId);
  if (!item || item.archivedAt) return res.status(404).json({ error: item ? 'item_archived' : 'item_not_found' });
  const counted = Q.parseQuantity(input.countedQuantity, item.baseUnit, { allowZero: true });
  if (counted.error) return bad(res, counted.error, { field: 'countedQuantity' });
  const result = await store.recordCount(sql, tenant.id, {
    itemId: item.id,
    countedMilli: counted.milli,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
    estimated: input.estimated === true,
    actor,
    idempotencyKey: key,
    requestHash: hash,
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
  const hash = requestHash('undo', { movementId: input.movementId, reason: input.reason, actorId: actor.id });
  if (await answeredByReplay(sql, tenant, me, key, hash, res)) return;
  const result = await store.reverseMovement(
    sql,
    tenant.id,
    { movementId: input.movementId, reason: input.reason, actor, idempotencyKey: key, requestHash: hash },
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
  if ((input.category !== undefined || input.specs !== undefined) && (await store.hasTypes(sql)) === true) {
    if (input.category !== undefined) patch.category = input.category;
    if (input.specs !== undefined) patch.specs = input.specs;
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
  if (item.archivedAt) return res.status(409).json({ error: 'item_archived' });
  const idf = codes.identifierFor(input.kind, input.value, { brand: item.brand, supplier: input.supplierName || item.supplierName });
  if (idf.error) return bad(res, idf.error);
  if ((input.packUnit && input.packSize === undefined) || (!input.packUnit && input.packSize !== undefined)) return bad(res, 'pack_incomplete');
  if (input.packUnit) {
    const s = Q.parseQuantity(input.packSize, item.baseUnit);
    if (s.error) return bad(res, s.error, { field: 'packSize' });
    idf.packUnit = input.packUnit;
    idf.packSizeMilli = s.milli;
  }
  const r = await store.addIdentifier(sql, tenant.id, item.id, { ...idf, supplierName: input.supplierName || null }, actorOf(me));
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
  const codesNotRestored = r.codesNotRestored || [];
  if (!r.unchanged) {
    await journal(me, archived ? 'workshop_stock.item_archived' : 'workshop_stock.item_restored', input.itemId, `${archived ? 'Archived' : 'Restored'} ${r.item.name}`,
      codesNotRestored.length ? { codesNotRestored: codesNotRestored.map((c) => c.value) } : {});
  }
  return res.status(200).json({ item: r.item, unchanged: r.unchanged === true, codesNotRestored });
}

async function itemPhoto(sql, tenant, me, body, res) {
  const input = parseOr400(ItemPhotoBody, body, res);
  if (!input) return;
  // The crew may FILL a missing photo of where an item lives (putting stock
  // away, the shelf with no photo yet) with a photo they took — never replace
  // or remove one: that stays the office's, like the shelf text.
  const office = policy.isOffice(me.role);
  const crewFill = !office && input.slot === 'location' && input.photoId !== null;
  if (!office && !crewFill) return res.status(403).json({ error: 'office_only' });
  const r = await store.replaceItemPhoto(sql, tenant.id, input.itemId, input.photoId, actorOf(me), input.slot, { onlyIfEmpty: crewFill });
  if (r.error) return res.status(r.error === 'item_not_found' ? 404 : r.error === 'location_photo_unavailable' ? 503 : 409).json({ error: r.error });
  const where = input.slot === 'location';
  // the crew's fill is in the item's own history (like their creates), not the shared journal
  if (office) {
    await journal(me, 'workshop_stock.photo_changed', input.itemId, where ? (input.photoId ? 'Changed where a workshop item lives (photo)' : 'Removed the photo of where a workshop item lives') : 'Changed a workshop item photo', { slot: input.slot });
  }
  return res.status(200).json({ item: await store.getItem(sql, tenant.id, input.itemId) });
}

async function verify(sql, tenant, me, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const input = parseOr400(ItemIdBody, body, res);
  if (!input) return;
  const item = await store.getItem(sql, tenant.id, input.itemId);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  if (item.archivedAt) return res.status(409).json({ error: 'item_archived' });
  if (!item.manufacturerCode) return res.status(409).json({ error: 'no_code' });
  // The check for exactly this item (its brand, code, colour and size words) —
  // what the office's "Check online" asked for.
  const key = codes.lookupKey({ brand: item.brand, manufacturerCode: item.manufacturerCode, colourFinish: item.colourFinish, variantDetails: item.variant });
  const cached = key ? await store.getCachedLookup(sql, tenant.id, key) : null;
  const v = verificationFromLookup(cached);
  const r = await store.recordVerification(sql, tenant.id, item.id, { status: v ? v.status : 'unverified', verification: v ? v.detail : null, actor: actorOf(me) });
  if (r.error) return res.status(r.error === 'item_not_found' ? 404 : 409).json({ error: r.error });
  await journal(me, 'workshop_stock.verification_recorded', item.id, `Recorded the online check for ${item.name}: ${v ? v.status : 'unverified'}`, { status: v ? v.status : 'unverified' });
  return res.status(200).json({ item: await store.getItem(sql, tenant.id, item.id) });
}

// ── shopping lists ────────────────────────────────────────────────────────────

const LIST_STATUS = { list_not_found: 404, line_not_found: 404, item_not_found: 404, list_not_yours: 403 };

function listError(res, r) {
  return res.status(LIST_STATUS[r.error] || (['list_name_required', 'line_empty'].includes(r.error) ? 400 : 409)).json({ error: r.error });
}

/** Lists need their tables: before the migration every list path says so (503), nothing else. */
// ── categories the office makes ───────────────────────────────────────────────

/** "Solar inverters" → "solar_inverters" (letters, digits, underscores; starts with a letter). */
function slugOf(label, max) {
  const s = String(label).toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'n$1');
  return s.slice(0, max).replace(/_+$/, '') || null;
}

async function saveType(sql, tenant, me, body, res) {
  if (!policy.isOffice(me.role)) return res.status(403).json({ error: 'office_only' });
  const input = parseOr400(TypeBody, body, res);
  if (!input) return;
  if ((await store.hasCustomTypes(sql)) !== true) return res.status(503).json({ error: 'types_unavailable' });
  const key = input.key || (slugOf(input.label, 29) ? `c_${slugOf(input.label, 29)}` : null);
  if (!key) return bad(res, 'type_name_invalid');
  const fields = [];
  for (const f of input.fields) {
    const fk = f.key || slugOf(f.label, 32);
    if (!fk || fk === 'brand' || fk === 'colourfinish') return bad(res, 'field_name_invalid', { field: f.label });
    if (fields.some((x) => x.key === fk || x.label.toLowerCase() === f.label.toLowerCase())) return bad(res, 'field_name_repeated', { field: f.label });
    fields.push({ key: fk, label: f.label });
  }
  const existing = await store.listCustomTypes(sql, tenant.id);
  if (!input.key && existing.some((t) => t.key === key)) return res.status(409).json({ error: 'type_name_taken' });
  if (input.key && !existing.some((t) => t.key === key)) return res.status(404).json({ error: 'type_not_found' });
  const r = await store.saveCustomType(sql, tenant.id, { key, label: input.label, unit: input.unit, fields }, actorOf(me));
  if (r.error === 'type_name_taken') return res.status(409).json({ error: r.error });
  if (r.error) return bad(res, r.error);
  await journal(me, r.created ? 'workshop_stock.type_created' : 'workshop_stock.type_changed', key,
    `${r.created ? 'Added' : 'Changed'} the stock category “${r.type.label}” (${r.type.fields.map((f) => f.label).join(', ') || 'no fields'})`, { key });
  return res.status(r.created ? 201 : 200).json({ type: r.type });
}

async function listsReady(sql, res) {
  if ((await store.hasLists(sql)) === true) return true;
  res.status(503).json({ error: 'lists_unavailable' });
  return false;
}

async function lists(sql, tenant, me, res) {
  if (!(await listsReady(sql, res))) return;
  return res.status(200).json({ lists: await store.listLists(sql, tenant.id), viewer: { id: me.id, office: policy.isOffice(me.role) } });
}

async function saveList(sql, tenant, me, body, res) {
  const input = parseOr400(ListBody, body, res);
  if (!input) return;
  if (!(await listsReady(sql, res))) return;
  let job;
  if (input.jobId !== undefined) {
    if (input.jobId === null || input.jobId === '') job = null;
    else {
      const ref = await resolveJob(input.jobId, me);
      if (ref.error) return bad(res, ref.error);
      job = ref.job;
    }
  }
  const r = await store.saveList(sql, tenant.id, input.id, { name: input.name, job, done: input.done }, actorOf(me));
  if (r.error) return listError(res, r);
  return res.status(r.created ? 201 : 200).json({ list: r.list });
}

async function deleteList(sql, tenant, me, id, res) {
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'list_not_found' });
  if (!(await listsReady(sql, res))) return;
  const r = await store.deleteList(sql, tenant.id, id, actorOf(me), { office: policy.isOffice(me.role) });
  if (r.error) return listError(res, r);
  return res.status(200).json({ deleted: true });
}

async function saveListLine(sql, tenant, me, body, res) {
  const input = parseOr400(ListLineBody, body, res);
  if (!input) return;
  if (!(await listsReady(sql, res))) return;
  // How many are needed, in the item's own unit (a text line: the unit it names, else each).
  let quantityMilli;
  if (input.quantity === null || input.quantity === '') quantityMilli = null;
  else if (input.quantity !== undefined) {
    let unit = input.unit || 'each';
    if (input.itemId) {
      const item = await store.getItem(sql, tenant.id, input.itemId);
      if (!item) return res.status(404).json({ error: 'item_not_found' });
      unit = item.baseUnit;
    }
    const q = Q.parseQuantity(input.quantity, unit);
    if (q.error) return bad(res, q.error, { field: 'quantity' });
    quantityMilli = q.milli;
  }
  const r = await store.saveListLine(sql, tenant.id, {
    listId: input.listId,
    id: input.id,
    itemId: input.itemId || null,
    text: input.itemId ? undefined : input.text,
    quantityMilli,
    unit: input.itemId ? undefined : input.unit,
    got: input.got,
    position: input.position,
  }, actorOf(me));
  if (r.error) return listError(res, r);
  return res.status(200).json({ list: r.list });
}

async function deleteListLine(sql, tenant, id, res) {
  if (!uuid.safeParse(id).success) return res.status(404).json({ error: 'line_not_found' });
  if (!(await listsReady(sql, res))) return;
  const r = await store.deleteListLine(sql, tenant.id, id);
  if (r.error) return listError(res, r);
  return res.status(200).json({ list: r.list });
}

// ── router ────────────────────────────────────────────────────────────────────

// The first query of a request (the tenant lookup) normally answers in a few
// ms. If it hasn't in DB_STALL_MS the connection is wedged: give up before
// anything is read or written instead of holding the screen for the 60 s
// function limit.
const DB_STALL_MS = 6000;
function firstQueryOrStall(promise) {
  let timer;
  const stall = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('db stalled'), { code: 'db_stalled' })), DB_STALL_MS);
  });
  return Promise.race([promise, stall]).finally(() => clearTimeout(timer));
}

// A read that hasn't answered in READ_STALL_MS is stuck on its connection
// (2026-11-02: list requests on fresh instances hung to the 60 s limit). Give
// up, drop the connection so the next request opens a fresh one, and answer
// 503 — reads only, so nothing can be half-done; the phone retries the list
// once. Whatever the stuck read does later is discarded.
const READ_STALL_MS = 12000;
async function readWithWatchdog(res, run) {
  let dead = false;
  const r = {
    status(code) { if (!dead) res.status(code); return r; },
    json(body) { if (!dead) res.json(body); return r; },
    setHeader(k, v) { if (!dead) res.setHeader(k, v); return r; },
    end(body) { if (!dead) res.end(body); return r; },
  };
  let timer;
  const stalled = new Promise((resolve) => { timer = setTimeout(() => resolve('stalled'), READ_STALL_MS); });
  const work = Promise.resolve().then(() => run(r)).then(() => 'done');
  work.catch(() => {}); // a late failure after a stall must not go unhandled
  try {
    const outcome = await Promise.race([work, stalled]);
    if (outcome === 'stalled') {
      dead = true;
      closeDb().catch(() => {});
      console.error('[workshop-stock] read stalled — connection dropped');
      return res.status(503).json({ error: 'store_unavailable' });
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

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
    tenant = await firstQueryOrStall(store.resolveTenant(sql));
  } catch (e) {
    if (e && e.code === 'db_stalled') {
      // The connection took the request and never ran it (2026-11-02, 00:37:
      // three stock requests sat 60 s on a fresh pooled connection, then timed
      // out). Drop this instance's connection so the next request opens a
      // fresh one — closeDb() forgets it at once; the close itself is
      // best-effort. Nothing was attempted yet, so 503 stays honest.
      closeDb().catch(() => {});
    }
    console.error('[workshop-stock] store unavailable', { code: (e && e.code) || 'db' });
    return res.status(503).json({ error: 'store_unavailable' });
  }
  if (!tenant) return res.status(503).json({ error: 'store_unprovisioned' });

  if (req.method === 'GET') {
    return readWithWatchdog(res, (r) => {
      switch (action) {
        case '':
        case 'list': return list(sql, tenant, me, req, r);
        case 'item': return itemDetail(sql, tenant, me, String(q.id || ''), r);
        case 'history': return history(sql, tenant, me, q, r);
        case 'operation': return operation(sql, tenant, me, q.key, r);
        case 'photo': return servePhoto(sql, tenant, me, String(q.id || ''), String(q.size || ''), r);
        case 'lists': return lists(sql, tenant, me, r);
        case 'location-matrix': return locationMatrix(sql, tenant, me, r);
        default: return r.status(400).json({ error: 'unknown_action' });
      }
    });
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
      case 'list': return saveList(sql, tenant, me, body, res);
      case 'type': return saveType(sql, tenant, me, body, res);
      case 'list-line': return saveListLine(sql, tenant, me, body, res);
      default: return res.status(400).json({ error: 'unknown_action' });
    }
  }
  if (req.method === 'PUT' && action === 'item') return editItem(sql, tenant, me, String(q.id || ''), body, res);
  if (req.method === 'PUT' && action === 'location-matrix') return saveLocationMatrix(sql, tenant, me, body, res);
  if (req.method === 'DELETE' && action === 'identifier') return identifier(sql, tenant, me, req, body, res);
  if (req.method === 'DELETE' && action === 'list') return deleteList(sql, tenant, me, String(q.id || ''), res);
  if (req.method === 'DELETE' && action === 'list-line') return deleteListLine(sql, tenant, String(q.id || ''), res);
  return res.status(405).json({ error: 'method_not_allowed' });
}

module.exports = withErrorCapture(handler, 'workshop-stock');
module.exports.__test = { firstQueryOrStall, DB_STALL_MS, READ_STALL_MS, stableStringify, requestHash, verificationFromLookup, identifiersForItem };
