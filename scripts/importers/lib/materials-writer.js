// Shared material-requests writer (#152) — the ONE idempotent write of
// public.material_requests (header) + public.material_request_items (lines) from
// the org-wide blob. Same shape as the evidence/snags/observations writers.
//
// Two-level write in ONE transaction:
//   * material_requests   upsert on (tenant, legacy_id) with IS DISTINCT FROM
//   * material_request_items  RECONCILED per request (items have NO natural key),
//     canonical compare → replace only when changed, exactly like time-entry
//     allocations (api/_lib/alloc-pg.reconcileAllocations). An unchanged re-run
//     writes nothing.
//
// Maps: reuses evidence-writer.resolveMaps (jobs/areas/users + the task bridge —
// the SAME proof resolver) PLUS an obsMap (legacy observation id → uuid) so
// linked_observation_id resolves to the canonical observation (best-effort).
//
// QUARANTINE: buildMaterialRequestRows fail-closes; writeMaterialRequests ABORTS
// (rollback) on any quarantine — header + items only land on a fully-clean set.

const { buildMaterialRequestRows, canonicaliseItems, REQUEST_INSERT_COLS, REQUEST_MUTABLE_COLS, ITEM_INSERT_COLS } = require('./materials-rows');
const { resolveMaps, legacyIdMap, setExcluded, distinctFromExcluded, tally } = require('./evidence-writer');

class MaterialQuarantineError extends Error {
  constructor(quarantine) { super('quarantined material requests'); this.quarantine = quarantine; }
}

async function resolveMaterialMaps(sql, tenantId) {
  const maps = await resolveMaps(sql, tenantId);
  const obsMap = await legacyIdMap(sql, 'observations', tenantId);
  return { ...maps, obsMap };
}

async function currentMaterialCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.material_requests where deleted_at is null) as material_requests,
           (select count(*)::int from public.material_request_items)                     as material_request_items
  `;
  return { material_requests: c.material_requests, material_request_items: c.material_request_items };
}

/**
 * Reconcile each request's item set: replace only when the stored canonical
 * differs from the proposed (unchanged run writes nothing). `sql` is the tx handle.
 * @param {import('postgres').Sql} sql
 * @param {string} tenantId
 * @param {Array<{materialRequestId:string, rows:object[], canonical:string}>} byRequest
 */
async function reconcileMaterialItems(sql, tenantId, byRequest) {
  const ids = byRequest.map((b) => b.materialRequestId);
  if (!ids.length) return { requestsReplaced: 0, requestsUnchanged: 0, itemsInserted: 0 };

  const existing = await sql`
    select material_request_id, item, quantity::text as quantity, unit, note, sort_order
    from public.material_request_items
    where tenant_id = ${tenantId} and material_request_id in ${sql(ids)}
  `;
  const exByReq = new Map();
  for (const r of existing) {
    const arr = exByReq.get(r.material_request_id) || [];
    arr.push(r);
    exByReq.set(r.material_request_id, arr);
  }
  const changed = byRequest.filter(
    (b) => canonicaliseItems(exByReq.get(b.materialRequestId) || []) !== b.canonical
  );

  let itemsInserted = 0;
  if (changed.length) {
    const cids = changed.map((b) => b.materialRequestId);
    await sql`delete from public.material_request_items where tenant_id = ${tenantId} and material_request_id in ${sql(cids)}`;
    const insertRows = changed.flatMap((b) =>
      b.rows.map((r) => ({ tenant_id: tenantId, material_request_id: b.materialRequestId, ...r }))
    );
    if (insertRows.length) {
      await sql`insert into public.material_request_items ${sql(insertRows, ...ITEM_INSERT_COLS)}`;
      itemsInserted = insertRows.length;
    }
  }
  return { requestsReplaced: changed.length, requestsUnchanged: byRequest.length - changed.length, itemsInserted };
}

/**
 * Upsert all material requests + reconcile their items for the tenant from
 * `sources` (blob material-requests.json). ONE transaction. Throws
 * MaterialQuarantineError (rollback) on ANY quarantine. Idempotent.
 * @param {any} sql postgres.js client (write)
 * @param {{materials:any}} sources
 */
async function writeMaterialRequests(sql, sources) {
  return sql.begin(async (sql) => {
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const maps = await resolveMaterialMaps(sql, tenantId);
    const { requestRows, itemsByLegacy, quarantine, byGranularity } = buildMaterialRequestRows(sources, { tenantId, ...maps });
    if (quarantine.length) throw new MaterialQuarantineError(quarantine);

    const ret = requestRows.length
      ? await sql`
          insert into public.material_requests ${sql(requestRows, ...REQUEST_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcluded(sql, REQUEST_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'material_requests', REQUEST_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Resolve the imported legacy ids → material_request uuids for the item reconcile.
    let itemsResult = { requestsReplaced: 0, requestsUnchanged: 0, itemsInserted: 0 };
    if (itemsByLegacy.length) {
      const legacyIds = itemsByLegacy.map((x) => x.legacyId);
      const idRows = await sql`
        select id, legacy_id from public.material_requests
        where tenant_id = ${tenantId} and legacy_id in ${sql(legacyIds)} and deleted_at is null
      `;
      const idByLegacy = new Map(idRows.map((r) => [r.legacy_id, r.id]));
      const byRequest = itemsByLegacy
        .map((x) => ({ materialRequestId: idByLegacy.get(x.legacyId), rows: x.rows, canonical: x.canonical }))
        .filter((x) => x.materialRequestId);
      itemsResult = await reconcileMaterialItems(sql, tenantId, byRequest);
    }

    const after = await currentMaterialCounts(sql);
    return { tenantId, requests: tally(ret, requestRows.length), items: itemsResult, byGranularity, after };
  });
}

module.exports = { writeMaterialRequests, MaterialQuarantineError, reconcileMaterialItems, resolveMaterialMaps, currentMaterialCounts };
