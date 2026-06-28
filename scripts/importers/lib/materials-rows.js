// Material-requests row builder (#152) — PURE. No I/O, no Supabase, no Blob.
//
// Maps the org-wide blob material requests (material-requests.json {requests:[]})
// into public.material_requests (header) + public.material_request_items (lines).
// The blob carries a SINGLE item/quantity/unit per request, so each request yields
// one header row + one item row (sort_order 0). Re-keys the legacy coordinate via
// the SAME shared proof-projection the evidence/snags/observations importers use:
//   areaId                → site_area_id   (composite area legacy → uuid)
//   (areaId,stage,taskId)  → task_id        (the tasks_area_stage_template_uq bridge)
//   requested/approved/ordered/delivered/cancelled/created ById → user uuids (nullable)
//   linkedObservationId    → linked_observation_id (best-effort via obsMap; dangling → null)
//
// Fail-closed, no coercion:
//   * job_id is NOT NULL — a request with no jobId → QUARANTINE.
//   * an unresolvable jobId/areaId, a taskId without a full/resolvable coordinate,
//     or any status/urgency/source/stage outside the schema CHECK → QUARANTINE.
//   * the LINE is required (a material request with no valid item is meaningless):
//     a missing/over-length item, a quantity not in (0, 10,000,000], or a
//     missing/over-length unit → QUARANTINE the whole request.
//   * a missing created_at → QUARANTINE.
//   * linked_observation_id is best-effort (a dangling link nulls).
//
// items have NO natural unique key, so the WRITER reconciles them per request
// (canonical compare → replace only when changed), exactly like time-entry
// allocations. canonicaliseItems is the stable serialiser for that compare.

const { taskBridgeKey, areaCompositeKey } = require('./proof-projection');

const VALID_STATUSES = ['requested', 'approved', 'ordered', 'delivered', 'cancelled'];
const VALID_URGENCIES = ['low', 'normal', 'high', 'urgent'];
const VALID_SOURCES = ['observation', 'buhlos', 'system'];
const VALID_STAGES = ['roughIn', 'fitOff'];
const DESC_MAX = 2000;
const SUPPLIER_MAX = 120;
const ORDER_REF_MAX = 60;
const ITEM_MAX = 200;
const UNIT_MAX = 24;
const ITEM_NOTE_MAX = 1000;
const MAX_QTY = 10000000;

function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function tsOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}
function qty3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

const REQUEST_INSERT_COLS = [
  'tenant_id', 'job_id', 'legacy_id', 'status', 'urgency', 'source', 'stage', 'site_area_id', 'task_id',
  'description', 'linked_observation_id', 'requested_by', 'requested_at', 'approved_by', 'approved_at',
  'ordered_by', 'ordered_at', 'supplier', 'supplier_note', 'order_ref', 'delivered_by', 'delivered_at',
  'delivery_note', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'created_at', 'updated_at',
  'created_by', 'updated_by',
];
const REQUEST_MUTABLE_COLS = REQUEST_INSERT_COLS.filter(
  (c) => !['tenant_id', 'job_id', 'legacy_id', 'created_at'].includes(c)
);
// Columns inserted per item row (tenant_id + material_request_id added at write).
const ITEM_INSERT_COLS = ['tenant_id', 'material_request_id', 'item', 'quantity', 'unit', 'note', 'sort_order'];

/**
 * Stable, order-independent string for an item set — the reconcile compare key.
 * quantity via Number(...).toFixed(3) so a JS number and a numeric(12,3) string
 * canonicalise identically; JSON.stringify keeps null distinct from "null".
 */
function canonicaliseItems(rows) {
  const tuples = (rows || []).map((r) => [r.item, Number(r.quantity).toFixed(3), r.unit, r.note ?? null, r.sort_order]);
  tuples.sort(
    (a, b) => a[4] - b[4] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || String(a[3]).localeCompare(String(b[3]))
  );
  return JSON.stringify(tuples);
}

/**
 * @param {{ materials?: {requests?: object[]} }} sources
 * @param {object} ctx { tenantId, jobMap, areaMap, taskMap, userMap, obsMap }
 * @returns {{ requestRows: object[], itemsByLegacy: Array<{legacyId:string,rows:object[],canonical:string}>, quarantine: Array<{table:string,id:string,reason:string}>, byGranularity: {task:number,area:number,job:number} }}
 */
function buildMaterialRequestRows(sources = {}, ctx = {}) {
  const { jobMap, areaMap, taskMap, userMap, obsMap } = ctx;
  const list = (sources.materials && Array.isArray(sources.materials.requests) ? sources.materials.requests : []) || [];

  const requestRows = [];
  const itemsByLegacy = [];
  const quarantine = [];
  const byGranularity = { task: 0, area: 0, job: 0 };
  const seen = new Set();
  const user = (id) => (id && userMap && userMap.get(id)) || null;

  for (const m of list) {
    const Q = (reason) => quarantine.push({ table: 'material_requests', id: (m && m.id) || '(no id)', reason });
    if (!m || !m.id) { Q('material request requires an id'); continue; }
    if (seen.has(m.id)) { Q(`duplicate material request id "${m.id}"`); continue; }
    if (!m.jobId) { Q('material request has no jobId (job_id is NOT NULL)'); continue; }
    const job_id = jobMap.get(m.jobId);
    if (!job_id) { Q(`job "${m.jobId}" not found in Postgres`); continue; }

    if (!VALID_STATUSES.includes(m.status)) { Q(`status "${m.status}" outside CHECK`); continue; }
    if (!VALID_URGENCIES.includes(m.urgency)) { Q(`urgency "${m.urgency}" outside CHECK`); continue; }
    if (!VALID_SOURCES.includes(m.source)) { Q(`source "${m.source}" outside CHECK (observation/buhlos/system)`); continue; }
    if (m.stage != null && !VALID_STAGES.includes(m.stage)) { Q(`stage "${m.stage}" outside CHECK`); continue; }
    const description = strOrNull(m.description);
    if (description && description.length > DESC_MAX) { Q(`description exceeds ${DESC_MAX} chars`); continue; }
    const supplier = strOrNull(m.supplier);
    if (supplier && supplier.length > SUPPLIER_MAX) { Q(`supplier exceeds ${SUPPLIER_MAX} chars`); continue; }
    const order_ref = strOrNull(m.orderRef);
    if (order_ref && order_ref.length > ORDER_REF_MAX) { Q(`order_ref exceeds ${ORDER_REF_MAX} chars`); continue; }
    const created_at = tsOrNull(m.createdAt) || tsOrNull(m.requestedAt);
    if (!created_at) { Q('created_at/requestedAt missing/invalid (NOT NULL column)'); continue; }

    // The line is required and must satisfy the item CHECKs (fail closed — a
    // material request with no valid item is meaningless).
    const item = strOrNull(m.item);
    if (!item) { Q('item missing (a material request needs a line item)'); continue; }
    if (item.length > ITEM_MAX) { Q(`item exceeds ${ITEM_MAX} chars`); continue; }
    const quantity = qty3(m.quantity);
    if (!(quantity > 0) || quantity > MAX_QTY) { Q(`quantity ${quantity} outside (0, ${MAX_QTY}]`); continue; }
    const unit = strOrNull(m.unit);
    if (!unit) { Q('unit missing (NOT NULL column)'); continue; }
    if (unit.length > UNIT_MAX) { Q(`unit exceeds ${UNIT_MAX} chars`); continue; }
    const itemNote = strOrNull(m.itemNote);
    if (itemNote && itemNote.length > ITEM_NOTE_MAX) { Q(`item note exceeds ${ITEM_NOTE_MAX} chars`); continue; }

    // Re-key area (fail closed on an unresolvable areaId).
    let site_area_id = null;
    if (m.areaId) {
      site_area_id = areaMap.get(areaCompositeKey(m.jobId, m.areaId));
      if (!site_area_id) { Q(`areaId "${m.areaId}" does not resolve to a site_area`); continue; }
    }
    // Re-key task — ONLY a full coordinate, ONLY to an existing task.
    let task_id = null;
    if (m.taskId) {
      const key = taskBridgeKey(m.jobId, m.areaId, m.stage, m.taskId);
      if (!key) { Q(`taskId "${m.taskId}" without a full (areaId,stage) coordinate`); continue; }
      task_id = taskMap.get(key);
      if (!task_id) { Q(`taskId "${m.taskId}" (${key}) does not resolve to a task`); continue; }
    }

    seen.add(m.id);
    byGranularity[task_id ? 'task' : site_area_id ? 'area' : 'job'] += 1;
    requestRows.push({
      tenant_id: ctx.tenantId,
      job_id,
      legacy_id: m.id,
      status: m.status,
      urgency: m.urgency,
      source: m.source,
      stage: m.stage || null,
      site_area_id,
      task_id,
      description,
      // best-effort: a dangling observation link nulls (the request is still valid).
      linked_observation_id: (m.linkedObservationId && obsMap && obsMap.get(m.linkedObservationId)) || null,
      requested_by: user(m.requestedById),
      requested_at: tsOrNull(m.requestedAt) || created_at,
      approved_by: user(m.approvedById),
      approved_at: tsOrNull(m.approvedAt),
      ordered_by: user(m.orderedById),
      ordered_at: tsOrNull(m.orderedAt),
      supplier,
      supplier_note: strOrNull(m.supplierNote),
      order_ref,
      delivered_by: user(m.deliveredById),
      delivered_at: tsOrNull(m.deliveredAt),
      delivery_note: strOrNull(m.deliveryNote),
      cancelled_by: user(m.cancelledById),
      cancelled_at: tsOrNull(m.cancelledAt),
      cancel_reason: strOrNull(m.cancelReason),
      created_at,
      updated_at: tsOrNull(m.updatedAt) || created_at,
      created_by: user(m.createdById) || user(m.requestedById),
      updated_by: null,
    });
    const itemRows = [{ item, quantity, unit, note: itemNote, sort_order: 0 }];
    itemsByLegacy.push({ legacyId: m.id, rows: itemRows, canonical: canonicaliseItems(itemRows) });
  }
  return { requestRows, itemsByLegacy, quarantine, byGranularity };
}

module.exports = {
  buildMaterialRequestRows,
  canonicaliseItems,
  REQUEST_INSERT_COLS,
  REQUEST_MUTABLE_COLS,
  ITEM_INSERT_COLS,
};
