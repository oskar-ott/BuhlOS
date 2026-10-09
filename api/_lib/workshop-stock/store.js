'use strict';

// Workshop Stock — Postgres store (migration 20261009100000_workshop_stock.sql).
//
// These tables ARE the store (Supabase-first, docs/product/02-lean-reset.md);
// photos are Blob binaries whose URLs never leave the server.
//
// House idiom (api/_lib/itp-simple-store.js, api/_lib/invoices/store.js): every
// function takes the Postgres.js `sql` the handler opened through the env guard,
// every statement filters on tenant_id, and errors throw. On top of that, the
// rules that make the ledger safe under concurrency and retries:
//
//   • each mutation is ONE transaction that row-locks the item (SELECT … FOR
//     UPDATE) before reading the balance — two workers taking the last GPO are
//     serialised; the second sees the first's result
//   • the idempotency key is re-checked AFTER the lock, so a double tap that
//     raced in behind the first returns the first's result (a replay), and a
//     reused key with a different payload is refused (request_hash mismatch)
//   • unique-violations (23505) are caught OUTSIDE sql.begin — inside, the
//     transaction is already aborted (25P02) — then the winner is re-read
//   • the balance itself is moved by the DB trigger in the same statement as the
//     movement insert; this module never writes balance_milli
//
// Results are plain objects: { ok:true, … } or { error:'<stable code>', … }.

const { toMilli } = require('./quantity');

const TENANT_SLUG = 'buhl';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

async function resolveTenant(sql) {
  const rows = await sql`select id, slug from public.tenants where slug = ${TENANT_SLUG}`;
  return rows.length ? { id: rows[0].id, slug: rows[0].slug } : null;
}

// ── row mapping ───────────────────────────────────────────────────────────────

function iso(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapIdentifier(r) {
  return {
    id: r.id,
    kind: r.kind,
    value: r.value,
    valueKey: r.value_key,
    scope: r.scope || '',
    packUnit: r.pack_unit || null,
    packSizeMilli: r.pack_size_milli == null ? null : toMilli(r.pack_size_milli),
  };
}

function mapItem(r, identifiers) {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand || null,
    manufacturerCode: r.manufacturer_code || null,
    supplierSku: r.supplier_sku || null,
    supplierName: r.supplier_name || null,
    variant: r.variant || null,
    colourFinish: r.colour_finish || null,
    baseUnit: r.base_unit,
    location: r.location || null,
    photoId: r.photo_id || null,
    defaultPack: r.default_pack_unit ? { unit: r.default_pack_unit, sizeMilli: toMilli(r.default_pack_size_milli) } : null,
    balanceMilli: toMilli(r.balance_milli),
    estimated: r.estimated === true,
    version: Number(r.version),
    metaRevision: Number(r.meta_revision),
    verificationStatus: r.verification_status,
    verification: r.verification || null,
    lastMovementAt: iso(r.last_movement_at),
    lastCountedAt: iso(r.last_counted_at),
    lastCountedByName: r.last_counted_by_name || null,
    archivedAt: iso(r.archived_at),
    createdAt: iso(r.created_at),
    createdByName: r.created_by_name || null,
    updatedAt: iso(r.updated_at),
    identifiers: identifiers || [],
  };
}

function mapMovement(r, reversal, countedSince = false) {
  return {
    id: r.id,
    itemId: r.item_id,
    kind: r.kind,
    quantityMilli: toMilli(r.quantity_milli),
    balanceAfterMilli: toMilli(r.balance_after_milli),
    itemVersionAfter: Number(r.item_version_after),
    countedMilli: r.counted_milli == null ? null : toMilli(r.counted_milli),
    pack: r.pack_count == null ? null : { count: Number(r.pack_count), unit: r.pack_unit || null, sizeMilli: toMilli(r.pack_size_milli) },
    estimated: r.estimated === true,
    jobId: r.job_legacy_id || null,
    jobLabel: r.job_label || null,
    reason: r.reason || null,
    note: r.note || null,
    reversesMovementId: r.reverses_movement_id || null,
    actorId: r.actor_legacy_id,
    actorName: r.actor_name || null,
    createdAt: iso(r.created_at),
    reversedBy: reversal ? { id: reversal.id, actorId: reversal.actor_legacy_id, actorName: reversal.actor_name || null, at: iso(reversal.created_at), reason: reversal.reason || null } : null,
    // A later count (still standing) has absorbed this movement — it can't be undone.
    countedSince,
  };
}

const ITEM_COLUMNS = (sql) => sql`
  i.id, i.name, i.brand, i.manufacturer_code, i.supplier_sku, i.supplier_name, i.variant, i.colour_finish,
  i.base_unit, i.location, i.photo_id, i.default_pack_unit, i.default_pack_size_milli, i.balance_milli,
  i.estimated, i.version, i.meta_revision, i.verification_status, i.verification, i.last_movement_at,
  i.last_counted_at, i.last_counted_by_name, i.archived_at, i.created_at, i.created_by_name, i.updated_at`;

async function identifiersFor(sql, tenantId, itemIds) {
  if (!itemIds.length) return new Map();
  const rows = await sql`
    select id, item_id, kind, value, value_key, scope, pack_unit, pack_size_milli
    from public.workshop_stock_identifiers
    where tenant_id = ${tenantId} and item_id in ${sql(itemIds)} and retired_at is null
    order by created_at`;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.item_id)) by.set(r.item_id, []);
    by.get(r.item_id).push(mapIdentifier(r));
  }
  return by;
}

// ── reads ─────────────────────────────────────────────────────────────────────

/** Every live item (or archived too) with its identifiers — the catalogue is small; the client searches it. */
async function listItems(sql, tenantId, { includeArchived = false } = {}) {
  const rows = includeArchived
    ? await sql`select ${ITEM_COLUMNS(sql)} from public.workshop_stock_items i where i.tenant_id = ${tenantId} order by i.archived_at nulls first, lower(i.name) limit 3000`
    : await sql`select ${ITEM_COLUMNS(sql)} from public.workshop_stock_items i where i.tenant_id = ${tenantId} and i.archived_at is null order by lower(i.name) limit 3000`;
  const ids = await identifiersFor(sql, tenantId, rows.map((r) => r.id));
  return rows.map((r) => mapItem(r, ids.get(r.id)));
}

async function getItem(sql, tenantId, itemId) {
  const rows = await sql`select ${ITEM_COLUMNS(sql)} from public.workshop_stock_items i where i.tenant_id = ${tenantId} and i.id = ${itemId}`;
  if (!rows.length) return null;
  const ids = await identifiersFor(sql, tenantId, [itemId]);
  return mapItem(rows[0], ids.get(itemId));
}

async function reversalsFor(sql, tenantId, movementIds) {
  if (!movementIds.length) return new Map();
  const rows = await sql`
    select id, reverses_movement_id, actor_legacy_id, actor_name, created_at, reason
    from public.workshop_stock_movements
    where tenant_id = ${tenantId} and reverses_movement_id in ${sql(movementIds)}`;
  return new Map(rows.map((r) => [r.reverses_movement_id, r]));
}

/** Per item, the ledger version of its latest count that still stands (not undone). */
async function liveCountVersions(sql, tenantId, itemIds) {
  if (!itemIds.length) return new Map();
  const rows = await sql`
    select c.item_id, max(c.item_version_after) as v
    from public.workshop_stock_movements c
    where c.tenant_id = ${tenantId} and c.item_id in ${sql([...new Set(itemIds)])} and c.kind = 'count'
      and not exists (
        select 1 from public.workshop_stock_movements r
        where r.tenant_id = c.tenant_id and r.reverses_movement_id = c.id)
    group by c.item_id`;
  return new Map(rows.map((r) => [r.item_id, Number(r.v)]));
}

/** Movement rows → API shape, with who undid them and whether a later count absorbed them. */
async function mapMovements(sql, tenantId, rows) {
  const rev = await reversalsFor(sql, tenantId, rows.map((r) => r.id));
  const counts = await liveCountVersions(sql, tenantId, rows.map((r) => r.item_id));
  return rows.map((r) => mapMovement(r, rev.get(r.id), (counts.get(r.item_id) || 0) > Number(r.item_version_after)));
}

/** An item's movements, newest first (cursor: an ISO timestamp + id). */
async function listMovements(sql, tenantId, itemId, { limit = 50, before = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = before
    ? await sql`
        select * from public.workshop_stock_movements
        where tenant_id = ${tenantId} and item_id = ${itemId} and (created_at, id) < (${before.at}, ${before.id})
        order by created_at desc, id desc limit ${lim}`
    : await sql`
        select * from public.workshop_stock_movements
        where tenant_id = ${tenantId} and item_id = ${itemId}
        order by created_at desc, id desc limit ${lim}`;
  return mapMovements(sql, tenantId, rows);
}

/** One actor's recent movements across items (for "your recent" + Undo on the phone). */
async function recentForActor(sql, tenantId, actorId, { sinceMinutes = 24 * 60, limit = 10 } = {}) {
  const rows = await sql`
    select m.*, i.name as item_name, i.base_unit as item_unit
    from public.workshop_stock_movements m
    join public.workshop_stock_items i on i.tenant_id = m.tenant_id and i.id = m.item_id
    where m.tenant_id = ${tenantId} and m.actor_legacy_id = ${actorId}
      and m.created_at > now() - make_interval(mins => ${sinceMinutes})
    order by m.created_at desc, m.id desc limit ${Math.min(Number(limit) || 10, 50)}`;
  const mapped = await mapMovements(sql, tenantId, rows);
  return mapped.map((m, i) => ({ ...m, itemName: rows[i].item_name, itemUnit: rows[i].item_unit }));
}

async function getMovement(sql, tenantId, movementId) {
  const rows = await sql`select * from public.workshop_stock_movements where tenant_id = ${tenantId} and id = ${movementId}`;
  if (!rows.length) return null;
  return (await mapMovements(sql, tenantId, rows))[0];
}

async function findByKey(sql, tenantId, key) {
  const rows = await sql`select * from public.workshop_stock_movements where tenant_id = ${tenantId} and idempotency_key = ${key}`;
  return rows[0] || null;
}

/** The movement an operation key produced (reconciling a lost response), or null. */
async function getOperation(sql, tenantId, key) {
  const row = await findByKey(sql, tenantId, key);
  if (!row) return null;
  return (await mapMovements(sql, tenantId, [row]))[0];
}

/** Movements that landed after the version a counter started from (stale-count review). */
async function movementsSinceVersion(sql, tenantId, itemId, version) {
  const rows = await sql`
    select * from public.workshop_stock_movements
    where tenant_id = ${tenantId} and item_id = ${itemId} and item_version_after > ${version}
    order by item_version_after asc limit 50`;
  return rows.map((r) => mapMovement(r, null));
}

async function itemEvents(sql, tenantId, itemId, { limit = 50 } = {}) {
  const rows = await sql`
    select id, event, detail, actor_legacy_id, actor_name, created_at
    from public.workshop_stock_item_events
    where tenant_id = ${tenantId} and item_id = ${itemId}
    order by created_at desc limit ${Math.min(Number(limit) || 50, 200)}`;
  return rows.map((r) => ({ id: r.id, event: r.event, detail: r.detail || {}, actorId: r.actor_legacy_id, actorName: r.actor_name || null, at: iso(r.created_at) }));
}

// ── shared write helpers ──────────────────────────────────────────────────────

async function insertEvent(tx, tenantId, itemId, event, detail, actor) {
  await tx`
    insert into public.workshop_stock_item_events (tenant_id, item_id, event, detail, actor_legacy_id, actor_name, actor_role)
    values (${tenantId}, ${itemId}, ${event}, ${tx.json(detail || {})}, ${actor.id}, ${actor.name || null}, ${actor.role || null})`;
}

function replayOrConflict(prior, requestHash, extra = {}) {
  if (prior.request_hash !== requestHash) return { error: 'idempotency_conflict' };
  return { ok: true, replayed: true, movementRow: prior, ...extra };
}

async function lockItem(tx, tenantId, itemId) {
  const rows = await tx`
    select id, base_unit, balance_milli, version, archived_at, name
    from public.workshop_stock_items
    where tenant_id = ${tenantId} and id = ${itemId}
    for update`;
  return rows[0] || null;
}

async function insertMovement(tx, tenantId, m) {
  const rows = await tx`
    insert into public.workshop_stock_movements
      (tenant_id, item_id, kind, quantity_milli, counted_milli, pack_count, pack_unit, pack_size_milli,
       estimated, job_legacy_id, job_label, reason, note, reverses_movement_id,
       actor_legacy_id, actor_name, actor_role, idempotency_key, request_hash)
    values
      (${tenantId}, ${m.itemId}, ${m.kind}, ${m.quantityMilli}, ${m.countedMilli ?? null},
       ${m.pack ? m.pack.count : null}, ${m.pack ? m.pack.unit : null}, ${m.pack ? m.pack.sizeMilli : null},
       ${m.estimated === true}, ${m.jobId || null}, ${m.jobLabel || null}, ${m.reason || null}, ${m.note || null},
       ${m.reversesMovementId || null}, ${m.actor.id}, ${m.actor.name || null}, ${m.actor.role || null},
       ${m.idempotencyKey}, ${m.requestHash})
    returning *`;
  return rows[0];
}

async function finishWith(sql, tenantId, result) {
  if (!result || result.error || !result.movementRow) return result;
  const [item, movement] = await Promise.all([getItem(sql, tenantId, result.movementRow.item_id), getMovement(sql, tenantId, result.movementRow.id)]);
  const { movementRow, ...rest } = result;
  return { ...rest, item, movement };
}

/** Postgres.js error → the constraint it names ('' when none). */
function constraintOf(e) {
  return e && (e.constraint_name || e.constraint || '');
}

/**
 * The ledger trigger's refusals (check_violation) as stable codes. The app
 * pre-checks all of these on the locked row; reaching here means a race the
 * database caught, so the answer is the same refusal, never a 500.
 */
function ledgerRefusal(e) {
  if (!e || e.code !== CHECK_VIOLATION) return null;
  const m = String(e.message || '');
  if (/insufficient/i.test(m)) return 'insufficient_stock';
  if (/does not fit/i.test(m)) return 'quantity_unit_mismatch';
  if (/archived/i.test(m)) return 'item_archived';
  if (/count does not match/i.test(m)) return 'stock_changed';
  if (/counted since/i.test(m)) return 'undo_counted_since';
  if (/reversal|reversed/i.test(m)) return 'cannot_undo';
  return null;
}

// ── movements ─────────────────────────────────────────────────────────────────

/**
 * add / take / return on an existing item.
 * @param {{ itemId, kind, quantityMilli, pack?, estimated?, jobId?, jobLabel?, note?, actor, idempotencyKey, requestHash }} input
 */
async function recordMovement(sql, tenantId, input) {
  let result;
  try {
    result = await sql.begin(async (tx) => {
      const item = await lockItem(tx, tenantId, input.itemId);
      // after the lock: a concurrent request with this key has committed or never will
      const prior = await findByKey(tx, tenantId, input.idempotencyKey);
      if (prior) return replayOrConflict(prior, input.requestHash);
      if (!item) return { error: 'item_not_found' };
      if (item.archived_at) return { error: 'item_archived' };
      const balance = toMilli(item.balance_milli);
      const delta = input.kind === 'take' ? -input.quantityMilli : input.quantityMilli;
      if (balance + delta < 0) return { error: 'insufficient_stock', balanceMilli: balance, unit: item.base_unit, requestedMilli: input.quantityMilli };
      const row = await insertMovement(tx, tenantId, { ...input, quantityMilli: delta });
      return { ok: true, movementRow: row };
    });
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION && /idempotency/.test(constraintOf(e))) {
      const prior = await findByKey(sql, tenantId, input.idempotencyKey);
      if (prior) result = replayOrConflict(prior, input.requestHash);
    } else if (ledgerRefusal(e) === 'insufficient_stock') {
      const item = await getItem(sql, tenantId, input.itemId);
      return { error: 'insufficient_stock', balanceMilli: item ? item.balanceMilli : 0, unit: item ? item.baseUnit : null, requestedMilli: input.quantityMilli };
    } else if (ledgerRefusal(e)) {
      return { error: ledgerRefusal(e) };
    }
    if (!result) throw e;
  }
  return finishWith(sql, tenantId, result);
}

/**
 * Physical count: the counted quantity becomes the recorded balance — but only
 * when nothing moved since the counter started (expectedVersion). Otherwise the
 * intervening movements come back for review and nothing is written.
 */
async function recordCount(sql, tenantId, input) {
  let result;
  try {
    result = await sql.begin(async (tx) => {
      const item = await lockItem(tx, tenantId, input.itemId);
      const prior = await findByKey(tx, tenantId, input.idempotencyKey);
      if (prior) return replayOrConflict(prior, input.requestHash);
      if (!item) return { error: 'item_not_found' };
      if (item.archived_at) return { error: 'item_archived' };
      if (Number(item.version) !== Number(input.expectedVersion)) {
        return { error: 'stock_changed', currentVersion: Number(item.version), balanceMilli: toMilli(item.balance_milli) };
      }
      const delta = input.countedMilli - toMilli(item.balance_milli);
      const row = await insertMovement(tx, tenantId, { ...input, kind: 'count', quantityMilli: delta, countedMilli: input.countedMilli });
      return { ok: true, movementRow: row };
    });
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION && /idempotency/.test(constraintOf(e))) {
      const prior = await findByKey(sql, tenantId, input.idempotencyKey);
      if (prior) result = replayOrConflict(prior, input.requestHash);
    } else if (ledgerRefusal(e) === 'stock_changed') {
      const item = await getItem(sql, tenantId, input.itemId);
      result = { error: 'stock_changed', currentVersion: item ? item.version : null, balanceMilli: item ? item.balanceMilli : null };
    } else if (ledgerRefusal(e)) {
      return { error: ledgerRefusal(e) };
    }
    if (!result) throw e;
  }
  if (result && result.error === 'stock_changed') {
    result.since = await movementsSinceVersion(sql, tenantId, input.itemId, input.expectedVersion);
    return result;
  }
  return finishWith(sql, tenantId, result);
}

/**
 * Undo: a compensating reversal row. `allow(movement, item)` is the caller's
 * permission policy, evaluated inside the transaction on the locked state; it
 * returns null (allowed) or an error code.
 */
async function reverseMovement(sql, tenantId, input, allow) {
  let result;
  try {
    result = await sql.begin(async (tx) => {
      const origRows = await tx`select * from public.workshop_stock_movements where tenant_id = ${tenantId} and id = ${input.movementId}`;
      const orig = origRows[0];
      if (!orig) {
        const prior = await findByKey(tx, tenantId, input.idempotencyKey);
        return prior ? replayOrConflict(prior, input.requestHash) : { error: 'movement_not_found' };
      }
      const item = await lockItem(tx, tenantId, orig.item_id);
      const prior = await findByKey(tx, tenantId, input.idempotencyKey);
      if (prior) return replayOrConflict(prior, input.requestHash);
      if (orig.kind === 'reversal') return { error: 'cannot_undo_undo' };
      const existing = await tx`select * from public.workshop_stock_movements where tenant_id = ${tenantId} and reverses_movement_id = ${orig.id}`;
      if (existing.length) return { error: 'already_undone', reversal: mapMovement(existing[0], null) };
      if (!item || item.archived_at) return { error: 'item_archived' };
      // Under the item lock: has a count that still stands landed since? (The trigger checks again.)
      const counts = await liveCountVersions(tx, tenantId, [orig.item_id]);
      if ((counts.get(orig.item_id) || 0) > Number(orig.item_version_after)) return { error: 'undo_counted_since' };
      const denied = allow(mapMovement(orig, null), { id: item.id, name: item.name, baseUnit: item.base_unit });
      if (denied) return { error: denied };
      const delta = -toMilli(orig.quantity_milli);
      const balance = toMilli(item.balance_milli);
      if (balance + delta < 0) {
        return { error: 'undo_would_go_negative', balanceMilli: balance, originalMilli: toMilli(orig.quantity_milli), unit: item.base_unit };
      }
      const row = await insertMovement(tx, tenantId, {
        itemId: orig.item_id, kind: 'reversal', quantityMilli: delta, reversesMovementId: orig.id,
        reason: input.reason || null, actor: input.actor, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash,
        jobId: orig.job_legacy_id, jobLabel: orig.job_label,
      });
      return { ok: true, movementRow: row, originalKind: orig.kind };
    });
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION && /idempotency/.test(constraintOf(e))) {
      const prior = await findByKey(sql, tenantId, input.idempotencyKey);
      if (prior) result = replayOrConflict(prior, input.requestHash);
    } else if (e && e.code === UNIQUE_VIOLATION && /one_reversal/.test(constraintOf(e))) {
      const rows = await sql`select * from public.workshop_stock_movements where tenant_id = ${tenantId} and reverses_movement_id = ${input.movementId}`;
      return { error: 'already_undone', reversal: rows[0] ? mapMovement(rows[0], null) : null };
    } else if (ledgerRefusal(e) === 'insufficient_stock') {
      return { error: 'undo_would_go_negative' };
    } else if (ledgerRefusal(e)) {
      return { error: ledgerRefusal(e) };
    }
    if (!result) throw e;
  }
  return finishWith(sql, tenantId, result);
}

// ── items ─────────────────────────────────────────────────────────────────────

/**
 * Create an item, its identifiers, claim its photo and record its opening
 * balance — one transaction, so a failure leaves nothing half-made. The opening
 * movement carries the idempotency key: a retried create returns the first item.
 */
async function createItemWithOpening(sql, tenantId, input) {
  let result;
  try {
    result = await sql.begin(async (tx) => {
      const prior = await findByKey(tx, tenantId, input.idempotencyKey);
      if (prior) return replayOrConflict(prior, input.requestHash);
      let photoId = null;
      let photoReading = null;
      if (input.photoId) {
        const claimed = await tx`
          update public.workshop_stock_photos set purpose = 'item', expires_at = null
          where tenant_id = ${tenantId} and id = ${input.photoId} and purpose = 'pending' and deleted_at is null
            and (uploaded_by_legacy_id = ${input.actor.id} or ${input.actorIsOffice === true})
          returning id, reading`;
        if (claimed.length) {
          photoId = claimed[0].id;
          photoReading = claimed[0].reading || null;
        }
      }
      const it = input.item;
      const provenance = { ...(input.provenance || {}), photo: photoReading, confirmedBy: { id: input.actor.id, name: input.actor.name || null } };
      const rows = await tx`
        insert into public.workshop_stock_items
          (tenant_id, name, brand, manufacturer_code, supplier_sku, supplier_name, variant, colour_finish,
           base_unit, location, photo_id, default_pack_unit, default_pack_size_milli,
           verification_status, verification, provenance, created_by_legacy_id, created_by_name,
           updated_by_legacy_id, updated_by_name)
        values
          (${tenantId}, ${it.name}, ${it.brand || null}, ${it.manufacturerCode || null}, ${it.supplierSku || null},
           ${it.supplierName || null}, ${it.variant || null}, ${it.colourFinish || null}, ${it.baseUnit},
           ${it.location || null}, ${photoId}, ${it.defaultPack ? it.defaultPack.unit : null},
           ${it.defaultPack ? it.defaultPack.sizeMilli : null}, ${input.verificationStatus || 'unverified'},
           ${input.verification ? tx.json(input.verification) : null}, ${tx.json(provenance)},
           ${input.actor.id}, ${input.actor.name || null}, ${input.actor.id}, ${input.actor.name || null})
        returning id`;
      const itemId = rows[0].id;
      for (const idf of input.identifiers || []) {
        await tx`
          insert into public.workshop_stock_identifiers
            (tenant_id, item_id, kind, value, value_key, scope, pack_unit, pack_size_milli, created_by_legacy_id, created_by_name)
          values (${tenantId}, ${itemId}, ${idf.kind}, ${idf.value}, ${idf.valueKey}, ${idf.scope || ''},
                  ${idf.packUnit || null}, ${idf.packSizeMilli || null}, ${input.actor.id}, ${input.actor.name || null})`;
      }
      const row = await insertMovement(tx, tenantId, {
        itemId, kind: 'opening', quantityMilli: input.openingMilli, pack: input.pack || null, estimated: input.estimated === true,
        note: input.note || null, actor: input.actor, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash,
      });
      await insertEvent(tx, tenantId, itemId, 'created', {
        photo: photoId ? 'attached' : input.photoId ? 'not_available' : 'none',
        verificationStatus: input.verificationStatus || 'unverified',
        identifiers: (input.identifiers || []).map((i) => ({ kind: i.kind, value: i.value })),
      }, input.actor);
      return { ok: true, created: true, movementRow: row, photoAttached: Boolean(photoId) || !input.photoId };
    });
  } catch (e) {
    const c = constraintOf(e);
    if (e && e.code === UNIQUE_VIOLATION && /idempotency/.test(c)) {
      const prior = await findByKey(sql, tenantId, input.idempotencyKey);
      if (prior) result = replayOrConflict(prior, input.requestHash);
    } else if (e && e.code === UNIQUE_VIOLATION && /identifiers_live/.test(c)) {
      const owners = await identifierOwners(sql, tenantId, input.identifiers || []);
      return { error: 'duplicate_item', existing: owners };
    } else if (ledgerRefusal(e)) {
      return { error: ledgerRefusal(e) };
    }
    if (!result) throw e;
  }
  return finishWith(sql, tenantId, result);
}

/** Which live items already hold any of these identifiers. */
async function identifierOwners(sql, tenantId, identifiers) {
  const out = [];
  for (const idf of identifiers) {
    const rows = await sql`
      select d.item_id, d.kind, d.value, i.name
      from public.workshop_stock_identifiers d
      join public.workshop_stock_items i on i.tenant_id = d.tenant_id and i.id = d.item_id
      where d.tenant_id = ${tenantId} and d.kind = ${idf.kind} and d.scope = ${idf.scope || ''}
        and d.value_key = ${idf.valueKey} and d.retired_at is null`;
    for (const r of rows) out.push({ itemId: r.item_id, itemName: r.name, kind: r.kind, value: r.value });
  }
  return out;
}

const EDITABLE = {
  name: 'name', brand: 'brand', manufacturerCode: 'manufacturer_code', supplierSku: 'supplier_sku',
  supplierName: 'supplier_name', variant: 'variant', colourFinish: 'colour_finish', location: 'location', baseUnit: 'base_unit',
};

/**
 * Office catalogue edit, compare-and-set on meta_revision. `patch` holds only
 * validated, changed fields (+ optional defaultPack). Returns the before/after
 * of each changed field for the history.
 */
async function updateItem(sql, tenantId, itemId, { patch, expectedRevision, actor, identifierChanges = null }) {
  try {
    return await sql.begin(async (tx) => {
      const rows = await tx`select * from public.workshop_stock_items where tenant_id = ${tenantId} and id = ${itemId} for update`;
      const cur = rows[0];
      if (!cur) return { error: 'item_not_found' };
      if (Number(cur.meta_revision) !== Number(expectedRevision)) return { error: 'item_changed', metaRevision: Number(cur.meta_revision) };
      const set = {};
      const changes = {};
      for (const [k, col] of Object.entries(EDITABLE)) {
        if (!(k in patch)) continue;
        const next = patch[k] === '' ? null : patch[k];
        if ((cur[col] ?? null) === (next ?? null)) continue;
        set[col] = next;
        changes[k] = { from: cur[col] ?? null, to: next ?? null };
      }
      if ('defaultPack' in patch) {
        const unit = patch.defaultPack ? patch.defaultPack.unit : null;
        const size = patch.defaultPack ? patch.defaultPack.sizeMilli : null;
        if ((cur.default_pack_unit || null) !== unit || (cur.default_pack_size_milli == null ? null : toMilli(cur.default_pack_size_milli)) !== size) {
          set.default_pack_unit = unit;
          set.default_pack_size_milli = size;
          changes.defaultPack = { from: cur.default_pack_unit ? { unit: cur.default_pack_unit, sizeMilli: toMilli(cur.default_pack_size_milli) } : null, to: patch.defaultPack || null };
        }
      }
      if (!Object.keys(set).length) return { ok: true, unchanged: true };
      set.meta_revision = Number(cur.meta_revision) + 1;
      set.updated_by_legacy_id = actor.id;
      set.updated_by_name = actor.name || null;
      await tx`update public.workshop_stock_items set ${tx(set)} where tenant_id = ${tenantId} and id = ${itemId}`;
      // A changed code (or the brand/supplier that scopes it) moves its identifier
      // in the same transaction, so matching never runs on a stale code.
      for (const r of (identifierChanges && identifierChanges.retire) || []) {
        await tx`update public.workshop_stock_identifiers set retired_at = now()
                 where tenant_id = ${tenantId} and item_id = ${itemId} and kind = ${r.kind}
                   and scope = ${r.scope || ''} and value_key = ${r.valueKey} and retired_at is null`;
      }
      for (const a of (identifierChanges && identifierChanges.add) || []) {
        await tx`insert into public.workshop_stock_identifiers
                   (tenant_id, item_id, kind, value, value_key, scope, created_by_legacy_id, created_by_name)
                 values (${tenantId}, ${itemId}, ${a.kind}, ${a.value}, ${a.valueKey}, ${a.scope || ''}, ${actor.id}, ${actor.name || null})`;
      }
      await insertEvent(tx, tenantId, itemId, 'updated', { changes }, actor);
      return { ok: true, changes };
    }).then(async (r) => (r.ok ? { ...r, item: await getItem(sql, tenantId, itemId) } : r));
  } catch (e) {
    if (e && /movement history cannot change/.test(e.message || '')) return { error: 'unit_locked' };
    if (e && e.code === UNIQUE_VIOLATION && /identifiers_live/.test(constraintOf(e))) {
      const adds = (identifierChanges && identifierChanges.add) || [];
      return { error: 'identifier_in_use', existing: await identifierOwners(sql, tenantId, adds) };
    }
    throw e;
  }
}

async function setArchived(sql, tenantId, itemId, archived, actor) {
  try {
    return await sql.begin(async (tx) => {
      const rows = await tx`select id, archived_at from public.workshop_stock_items where tenant_id = ${tenantId} and id = ${itemId} for update`;
      if (!rows.length) return { error: 'item_not_found' };
      const isArchived = Boolean(rows[0].archived_at);
      if (isArchived === archived) return { ok: true, unchanged: true };
      if (archived) {
        await tx`update public.workshop_stock_items set archived_at = now(), archived_by_legacy_id = ${actor.id}, archived_by_name = ${actor.name || null}, meta_revision = meta_revision + 1 where tenant_id = ${tenantId} and id = ${itemId}`;
        // free the codes for a replacement item; the history keeps them
        await tx`update public.workshop_stock_identifiers set retired_at = now() where tenant_id = ${tenantId} and item_id = ${itemId} and retired_at is null`;
      } else {
        await tx`update public.workshop_stock_identifiers d set retired_at = null
                 where d.tenant_id = ${tenantId} and d.item_id = ${itemId} and d.retired_at = (
                   select max(retired_at) from public.workshop_stock_identifiers x where x.tenant_id = ${tenantId} and x.item_id = ${itemId})`;
        await tx`update public.workshop_stock_items set archived_at = null, archived_by_legacy_id = null, archived_by_name = null, meta_revision = meta_revision + 1 where tenant_id = ${tenantId} and id = ${itemId}`;
      }
      await insertEvent(tx, tenantId, itemId, archived ? 'archived' : 'restored', {}, actor);
      return { ok: true };
    }).then(async (r) => (r.ok ? { ...r, item: await getItem(sql, tenantId, itemId) } : r));
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION && /identifiers_live/.test(constraintOf(e))) return { error: 'identifier_in_use' };
    throw e;
  }
}

async function addIdentifier(sql, tenantId, itemId, idf, actor) {
  try {
    return await sql.begin(async (tx) => {
      const rows = await tx`select id, archived_at from public.workshop_stock_items where tenant_id = ${tenantId} and id = ${itemId} for update`;
      if (!rows.length) return { error: 'item_not_found' };
      if (rows[0].archived_at) return { error: 'item_archived' };
      const ins = await tx`
        insert into public.workshop_stock_identifiers
          (tenant_id, item_id, kind, value, value_key, scope, pack_unit, pack_size_milli, created_by_legacy_id, created_by_name)
        values (${tenantId}, ${itemId}, ${idf.kind}, ${idf.value}, ${idf.valueKey}, ${idf.scope || ''},
                ${idf.packUnit || null}, ${idf.packSizeMilli || null}, ${actor.id}, ${actor.name || null})
        returning *`;
      await insertEvent(tx, tenantId, itemId, 'identifier_added', { kind: idf.kind, value: idf.value, packUnit: idf.packUnit || null, packSizeMilli: idf.packSizeMilli || null }, actor);
      return { ok: true, identifier: mapIdentifier(ins[0]) };
    });
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION && /identifiers_live/.test(constraintOf(e))) {
      return { error: 'identifier_in_use', existing: await identifierOwners(sql, tenantId, [idf]) };
    }
    throw e;
  }
}

async function retireIdentifier(sql, tenantId, identifierId, actor) {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update public.workshop_stock_identifiers set retired_at = now()
      where tenant_id = ${tenantId} and id = ${identifierId} and retired_at is null
      returning item_id, kind, value`;
    if (!rows.length) return { error: 'identifier_not_found' };
    await insertEvent(tx, tenantId, rows[0].item_id, 'identifier_removed', { kind: rows[0].kind, value: rows[0].value }, actor);
    return { ok: true, itemId: rows[0].item_id };
  });
}

/** Office: record (or clear) a product-code verification on an item from a server-side lookup result. */
async function recordVerification(sql, tenantId, itemId, { status, verification, actor }) {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update public.workshop_stock_items set verification_status = ${status}, verification = ${verification ? tx.json(verification) : null},
        meta_revision = meta_revision + 1, updated_by_legacy_id = ${actor.id}, updated_by_name = ${actor.name || null}
      where tenant_id = ${tenantId} and id = ${itemId} returning id`;
    if (!rows.length) return { error: 'item_not_found' };
    await insertEvent(tx, tenantId, itemId, 'verification_recorded', { status, sourceUrl: verification ? verification.sourceUrl : null }, actor);
    return { ok: true };
  });
}

// ── photos ────────────────────────────────────────────────────────────────────

async function insertPhoto(sql, tenantId, p) {
  const rows = await sql`
    insert into public.workshop_stock_photos
      (tenant_id, purpose, blob_url, blob_pathname, content_type, byte_size, width, height, sha256,
       uploaded_by_legacy_id, uploaded_by_name, expires_at)
    values (${tenantId}, 'pending', ${p.blobUrl}, ${p.blobPathname}, ${p.contentType}, ${p.byteSize}, ${p.width}, ${p.height},
            ${p.sha256}, ${p.actor.id}, ${p.actor.name || null}, now() + make_interval(hours => ${p.ttlHours || 24}))
    returning id`;
  return rows[0].id;
}

async function setPhotoReading(sql, tenantId, photoId, reading) {
  await sql`update public.workshop_stock_photos set reading = ${sql.json(reading)} where tenant_id = ${tenantId} and id = ${photoId}`;
}

/** Server-only: the Blob URL + type of a photo the viewer may see, or null. */
async function getPhotoForServing(sql, tenantId, photoId, { viewerId, office }) {
  const rows = await sql`
    select id, blob_url, content_type, byte_size, purpose, uploaded_by_legacy_id
    from public.workshop_stock_photos
    where tenant_id = ${tenantId} and id = ${photoId} and deleted_at is null`;
  const p = rows[0];
  if (!p) return null;
  if (p.purpose !== 'item' && !office && p.uploaded_by_legacy_id !== viewerId) return null;
  return { id: p.id, blobUrl: p.blob_url, contentType: p.content_type, byteSize: Number(p.byte_size) };
}

/** Office: point an item at a new (pending) photo; the old one is retired and expires. */
async function replaceItemPhoto(sql, tenantId, itemId, photoId, actor) {
  return sql.begin(async (tx) => {
    const items = await tx`select id, photo_id from public.workshop_stock_items where tenant_id = ${tenantId} and id = ${itemId} for update`;
    if (!items.length) return { error: 'item_not_found' };
    const claimed = await tx`
      update public.workshop_stock_photos set purpose = 'item', expires_at = null
      where tenant_id = ${tenantId} and id = ${photoId} and purpose = 'pending' and deleted_at is null returning id`;
    if (!claimed.length) return { error: 'photo_not_available' };
    const old = items[0].photo_id;
    await tx`update public.workshop_stock_items set photo_id = ${photoId}, meta_revision = meta_revision + 1, updated_by_legacy_id = ${actor.id}, updated_by_name = ${actor.name || null} where tenant_id = ${tenantId} and id = ${itemId}`;
    if (old) await tx`update public.workshop_stock_photos set purpose = 'retired', expires_at = now() + interval '1 day' where tenant_id = ${tenantId} and id = ${old}`;
    await insertEvent(tx, tenantId, itemId, 'photo_changed', { from: old, to: photoId }, actor);
    return { ok: true };
  });
}

/** Expired pending/retired photos no item points at — safe to delete. */
async function expiredPhotos(sql, tenantId, limit = 5) {
  const rows = await sql`
    select p.id, p.blob_url from public.workshop_stock_photos p
    where p.tenant_id = ${tenantId} and p.purpose <> 'item' and p.deleted_at is null and p.expires_at < now()
      and not exists (select 1 from public.workshop_stock_items i where i.tenant_id = p.tenant_id and i.photo_id = p.id)
    order by p.expires_at limit ${limit}`;
  return rows.map((r) => ({ id: r.id, blobUrl: r.blob_url }));
}

async function markPhotoDeleted(sql, tenantId, photoId) {
  await sql`update public.workshop_stock_photos set deleted_at = now() where tenant_id = ${tenantId} and id = ${photoId} and purpose <> 'item'`;
}

// ── cost ceiling + lookup cache ───────────────────────────────────────────────

/** Count one paid call against today's (Sydney) ceiling. { allowed, count }. */
async function consumeUsage(sql, tenantId, kind, cap) {
  const rows = await sql`
    insert into public.workshop_stock_usage (tenant_id, day, kind, count)
    values (${tenantId}, (now() at time zone 'Australia/Sydney')::date, ${kind}, 1)
    on conflict (tenant_id, day, kind) do update set count = public.workshop_stock_usage.count + 1
      where public.workshop_stock_usage.count < ${cap}
    returning count`;
  return rows.length ? { allowed: true, count: Number(rows[0].count) } : { allowed: false, count: cap };
}

async function getCachedLookup(sql, tenantId, brandKey, codeKey) {
  const rows = await sql`
    select result, fetched_at from public.workshop_stock_lookup_cache
    where tenant_id = ${tenantId} and brand_key = ${brandKey || ''} and code_key = ${codeKey} and expires_at > now()`;
  return rows.length ? { ...rows[0].result, cached: true, cachedAt: iso(rows[0].fetched_at) } : null;
}

async function putCachedLookup(sql, tenantId, brandKey, codeKey, status, result, ttlDays) {
  await sql`
    insert into public.workshop_stock_lookup_cache (tenant_id, brand_key, code_key, status, result, fetched_at, expires_at)
    values (${tenantId}, ${brandKey || ''}, ${codeKey}, ${status}, ${sql.json(result)}, now(), now() + make_interval(days => ${ttlDays}))
    on conflict (tenant_id, brand_key, code_key) do update
      set status = excluded.status, result = excluded.result, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`;
}

module.exports = {
  TENANT_SLUG,
  resolveTenant,
  listItems,
  getItem,
  listMovements,
  recentForActor,
  getMovement,
  getOperation,
  movementsSinceVersion,
  itemEvents,
  recordMovement,
  recordCount,
  reverseMovement,
  createItemWithOpening,
  identifierOwners,
  updateItem,
  setArchived,
  addIdentifier,
  retireIdentifier,
  recordVerification,
  insertPhoto,
  setPhotoReading,
  getPhotoForServing,
  replaceItemPhoto,
  expiredPhotos,
  markPhotoDeleted,
  consumeUsage,
  getCachedLookup,
  putCachedLookup,
};
