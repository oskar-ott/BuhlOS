// Shared observations writer (#152) — the ONE idempotent upsert of observations
// (public.observations) from the org-wide blob. Same shape as evidence/snags
// writers so a future best-effort dual-write mirror and this operator importer can
// share ONE writer.
//
// Maps: reuses evidence-writer.resolveMaps (jobs/areas/users + the task bridge —
// the SAME proof-coordinate resolver) PLUS a snagMap (legacy snag id → uuid) so an
// observation's linked_snag_id resolves to the canonical snag (best-effort; a
// dangling link nulls). linked_material_request_id stays null until materials land.
//
// QUARANTINE: buildObservationRows fail-closes office items (no jobId), unresolvable
// coordinates and out-of-CHECK values. writeObservations NEVER coerces; the importer
// ABORTS on any quarantine.

const { buildObservationRows, OBSERVATION_INSERT_COLS, OBSERVATION_MUTABLE_COLS } = require('./observations-rows');
const { resolveMaps, legacyIdMap, setExcluded, distinctFromExcluded, tally } = require('./evidence-writer');

class ObservationQuarantineError extends Error {
  constructor(quarantine) { super('quarantined observations'); this.quarantine = quarantine; }
}

// The shared proof maps PLUS a snagMap for linked_snag_id resolution.
async function resolveObservationMaps(sql, tenantId) {
  const maps = await resolveMaps(sql, tenantId);
  const snagMap = await legacyIdMap(sql, 'snags', tenantId);
  return { ...maps, snagMap };
}

async function currentObservationCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.observations where deleted_at is null) as observations
  `;
  return { observations: c.observations };
}

/**
 * Upsert all observations for the tenant from `sources` (blob observations.json).
 * ONE transaction. Throws ObservationQuarantineError (rollback) on ANY quarantine.
 * Idempotent.
 * @param {any} sql postgres.js client (write)
 * @param {{observations:any}} sources
 */
async function writeObservations(sql, sources) {
  return sql.begin(async (sql) => {
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const maps = await resolveObservationMaps(sql, tenantId);
    const { observationRows, quarantine, byGranularity } = buildObservationRows(sources, { tenantId, ...maps });
    if (quarantine.length) throw new ObservationQuarantineError(quarantine);

    const ret = observationRows.length
      ? await sql`
          insert into public.observations ${sql(observationRows, ...OBSERVATION_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcluded(sql, OBSERVATION_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'observations', OBSERVATION_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    const after = await currentObservationCounts(sql);
    return { tenantId, observations: tally(ret, observationRows.length), byGranularity, after };
  });
}

module.exports = { writeObservations, ObservationQuarantineError, resolveObservationMaps, currentObservationCounts };
