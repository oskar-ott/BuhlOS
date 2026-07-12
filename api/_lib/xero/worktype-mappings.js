// Work-type ↔ Xero earnings-rate mapping (#611) — the second kind on the
// epic-wide xero_mappings store (#248 designed it; this reuses it verbatim).
//
// The BuhlOS work-type vocabulary is the REAL one: ordinary + overtime, the
// two classifications the hours engine actually produces (autoSplitOT +
// prorateAllocations). Travel (#129) and allowances (expenses #536 direction)
// join this registry when they exist in the hours model — mapping phantom
// categories now would be fake UI (P7). The registry is the single place a
// new work type is added.
//
// Rules (payroll-boundary ADR + #611): a work type NEVER silently defaults to
// ordinary — unmapped is a named export blocker; links are by immutable
// EarningsRateID with confirm-time snapshots; suggestions (by Xero
// EarningsType classification, then exact name) never auto-apply; an admin
// confirm is mandatory. Health: inactive/deleted rates, missing mappings,
// stale reference cache, duplicate targets (two work types → one rate is
// legal but VISIBLE — never silent).

const { getDb } = require('../supabase-db');
const store = require('./token-store');
const { XeroError } = require('./errors');

const KIND = 'worktype_earnings_rate';

// The real hours classifications. key = local_id in xero_mappings.
const WORK_TYPES = [
  {
    key: 'ordinary',
    label: 'Ordinary hours',
    // Xero Payroll AU EarningsType values that make sense for this work type —
    // the suggestion signal, and a confirm-time sanity warning when violated.
    expectedEarningsTypes: ['ORDINARYTIMEEARNINGS'],
  },
  {
    key: 'overtime',
    label: 'Overtime',
    expectedEarningsTypes: ['OVERTIMEEARNINGS'],
  },
];

function db(sql, mode) {
  return sql || getDb({ mode: mode || 'write' });
}

async function currentConnection(deps = {}) {
  const s = deps.store || store;
  const row = await s.getConnection({ sql: deps.sql });
  if (!row) throw new XeroError('not_connected');
  if (row.status === 'pending_selection' || !row.external_tenant_id) {
    throw new XeroError('pending_selection');
  }
  return row;
}

async function loadEarningsRates(sql, conn) {
  const rows = await sql`
    select xero_id, name, active, payload
    from public.xero_reference_items
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and kind = 'earnings_rate'
    order by name
  `;
  return rows.map((r) => ({
    xeroId: r.xero_id,
    name: r.name,
    active: r.active,
    payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
  }));
}

async function lastPayItemsSync(sql, conn) {
  const rows = await sql`
    select status, error_category, created_at
    from public.xero_reference_syncs
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and sync_group = 'pay_items'
    order by created_at desc
    limit 1
  `;
  return rows.length ? rows[0] : null;
}

async function loadMappings(sql, conn) {
  return sql`
    select * from public.xero_mappings
    where tenant_id = ${conn.tenant_id} and kind = ${KIND}
  `;
}

/** Pure suggestion: EarningsType classification first, exact name second. */
function suggestRate(workType, rates) {
  const active = rates.filter((r) => r.active);
  const byType = active.filter((r) =>
    workType.expectedEarningsTypes.includes(String((r.payload && r.payload.earningsType) || ''))
  );
  if (byType.length === 1) {
    return { rateId: byType[0].xeroId, rateName: byType[0].name, reason: 'earnings_type' };
  }
  const nameHit = active.filter((r) => r.name.trim().toLowerCase() === workType.label.trim().toLowerCase());
  if (nameHit.length === 1) {
    return { rateId: nameHit[0].xeroId, rateName: nameHit[0].name, reason: 'name' };
  }
  // Multiple candidates of the right type: suggest nothing rather than guess,
  // but let the UI say the type-matching candidates exist.
  if (byType.length > 1) {
    return null;
  }
  return null;
}

/** The mapping board: work types × link state × health + the rate picker. */
async function getWorktypeMappingBoard(deps = {}) {
  const sql = db(deps.sql, 'read');
  const conn = await currentConnection(deps);
  const [rates, mappings, payItemsSync] = await Promise.all([
    loadEarningsRates(sql, conn),
    loadMappings(sql, conn),
    lastPayItemsSync(sql, conn),
  ]);

  const rateById = new Map(rates.map((r) => [r.xeroId, r]));
  const mappingByType = new Map(mappings.map((m) => [m.local_id, m]));

  // duplicate targets: two work types confirmed onto one rate (legal, visible)
  const targets = new Map();
  for (const m of mappings.filter((x) => x.external_tenant_id === conn.external_tenant_id)) {
    if (!targets.has(m.xero_id)) targets.set(m.xero_id, []);
    targets.get(m.xero_id).push(m.local_id);
  }

  const rows = WORK_TYPES.map((wt) => {
    const m = mappingByType.get(wt.key) || null;
    const cacheRate = m ? rateById.get(m.xero_id) || null : null;
    const sharedWith = m ? (targets.get(m.xero_id) || []).filter((k) => k !== wt.key) : [];
    return {
      workType: wt.key,
      label: wt.label,
      mapping: m
        ? {
            rateId: m.xero_id,
            rateName: m.xero_name_snapshot,
            linkedByName: m.linked_by_name,
            linkedAt: m.created_at,
            orgMismatch: m.external_tenant_id !== conn.external_tenant_id,
            rateMissingFromCache: m.external_tenant_id === conn.external_tenant_id && !cacheRate,
            rateInactive: Boolean(cacheRate && !cacheRate.active),
            typeMismatch: Boolean(
              cacheRate &&
                cacheRate.payload &&
                cacheRate.payload.earningsType &&
                !wt.expectedEarningsTypes.includes(String(cacheRate.payload.earningsType))
            ),
            sharedWith,
          }
        : null,
      suggestion: m ? null : suggestRate(wt, rates),
    };
  });

  return {
    organisationName: conn.external_tenant_name,
    workTypes: rows,
    unmappedCount: rows.filter((r) => !r.mapping).length,
    rates: rates.map((r) => ({
      xeroId: r.xeroId,
      name: r.name,
      active: r.active,
      earningsType: (r.payload && r.payload.earningsType) || null,
      rateType: (r.payload && r.payload.rateType) || null,
    })),
    rateCache: {
      count: rates.length,
      lastSync: payItemsSync
        ? { at: payItemsSync.created_at, status: payItemsSync.status, errorCategory: payItemsSync.error_category }
        : null,
      trustworthy: Boolean(payItemsSync && payItemsSync.status === 'ok'),
    },
  };
}

/** Confirm (or remap) one work type → earnings rate. Admin-confirmed only. */
async function confirmWorktypeMapping({ workType, rateId, actor, deps = {} }) {
  const sql = db(deps.sql, 'write');
  const conn = await currentConnection(deps);
  const wt = WORK_TYPES.find((w) => w.key === workType);
  if (!wt) throw new XeroError('validation', { detail: 'unknown_work_type' });

  const rates = await loadEarningsRates(sql, conn);
  const rate = rates.find((r) => r.xeroId === rateId);
  if (!rate) throw new XeroError('validation', { detail: 'unknown_earnings_rate' });

  const rows = await sql`
    insert into public.xero_mappings (
      tenant_id, external_tenant_id, kind, local_id, xero_id,
      xero_name_snapshot, xero_status_snapshot, source,
      linked_by_legacy_id, linked_by_name
    ) values (
      ${conn.tenant_id}, ${conn.external_tenant_id}, ${KIND}, ${workType}, ${rateId},
      ${rate.name}, ${rate.active ? 'ACTIVE' : 'INACTIVE'}, ${'manual'},
      ${actor ? String(actor.id) : null}, ${actor ? String(actor.name || actor.username || '') : null}
    )
    on conflict (tenant_id, external_tenant_id, kind, local_id) do update set
      xero_id = excluded.xero_id,
      xero_name_snapshot = excluded.xero_name_snapshot,
      xero_status_snapshot = excluded.xero_status_snapshot,
      source = excluded.source,
      linked_by_legacy_id = excluded.linked_by_legacy_id,
      linked_by_name = excluded.linked_by_name
    returning *
  `;
  const typeMismatch = Boolean(
    rate.payload && rate.payload.earningsType &&
    !wt.expectedEarningsTypes.includes(String(rate.payload.earningsType))
  );
  return {
    mapping: rows[0],
    workTypeLabel: wt.label,
    rateName: rate.name,
    rateInactive: !rate.active,
    typeMismatch,
  };
}

async function removeWorktypeMapping({ workType, deps = {} }) {
  const sql = db(deps.sql, 'write');
  const conn = await currentConnection(deps);
  const rows = await sql`
    delete from public.xero_mappings
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and kind = ${KIND}
      and local_id = ${workType}
    returning *
  `;
  return rows.length ? rows[0] : null;
}

/** The #249/#894 seam: current-org work-type mapping state, fresh read. */
async function worktypeReadiness(deps = {}) {
  const sql = db(deps.sql, 'read');
  const conn = await currentConnection(deps);
  const rows = await sql`
    select local_id, xero_id, xero_name_snapshot from public.xero_mappings
    where tenant_id = ${conn.tenant_id}
      and external_tenant_id = ${conn.external_tenant_id}
      and kind = ${KIND}
  `;
  const byType = new Map(rows.map((r) => [r.local_id, r]));
  return WORK_TYPES.map((wt) => ({
    workType: wt.key,
    label: wt.label,
    rateId: byType.has(wt.key) ? byType.get(wt.key).xero_id : null,
    rateName: byType.has(wt.key) ? byType.get(wt.key).xero_name_snapshot : null,
    mapped: byType.has(wt.key),
  }));
}

module.exports = {
  KIND,
  WORK_TYPES,
  suggestRate,
  getWorktypeMappingBoard,
  confirmWorktypeMapping,
  removeWorktypeMapping,
  worktypeReadiness,
};
