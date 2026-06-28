// Shared snags writer (#152) — the ONE idempotent upsert of snags
// (public.snags) from blob sources. Same shape as evidence-writer.js so a future
// best-effort dual-write mirror and this operator importer can share ONE writer
// and never diverge.
//
// REUSES the evidence-writer's shared helpers deliberately: resolveMaps is the
// SAME proof-coordinate resolver (jobs/areas/users + the task bridge) the evidence
// importer uses, so snags and evidence re-key identically (the proof-projection
// "one resolver" rule). setExcluded/distinctFromExcluded/tally are the generic
// upsert helpers.
//
// READ of the Blob is the CALLER's job (sources passed in). The ONLY write is the
// one upsert, in ONE transaction:
//   * snags  upsert on (tenant, legacy_id) with IS DISTINCT FROM
// Re-run with no change writes 0 rows.
//
// QUARANTINE: buildSnagRows fail-closes any unresolvable coordinate / out-of-CHECK
// value. writeSnags NEVER coerces; the caller decides — the importer ABORTS
// (all-or-nothing), a future mirror would report it and skip (Blob authoritative).

const { buildSnagRows, SNAG_INSERT_COLS, SNAG_MUTABLE_COLS } = require('./snags-rows');
const { resolveMaps, setExcluded, distinctFromExcluded, tally } = require('./evidence-writer');

class SnagQuarantineError extends Error {
  constructor(quarantine) { super('quarantined snags'); this.quarantine = quarantine; }
}

async function currentSnagCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.snags where deleted_at is null) as snags
  `;
  return { snags: c.snags };
}

/**
 * Upsert all snags for the tenant from `sources` (blob jobs.json + per-job
 * data.json). ONE transaction. Throws SnagQuarantineError (rollback, nothing
 * written) on ANY quarantine. Idempotent.
 * @param {any} sql postgres.js client (write)
 * @param {{jobs:any, jobData:object}} sources
 */
async function writeSnags(sql, sources) {
  return sql.begin(async (sql) => {
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const maps = await resolveMaps(sql, tenantId);
    const { snagRows, quarantine, byGranularity } = buildSnagRows(sources, { tenantId, ...maps });
    if (quarantine.length) throw new SnagQuarantineError(quarantine);

    const ret = snagRows.length
      ? await sql`
          insert into public.snags ${sql(snagRows, ...SNAG_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcluded(sql, SNAG_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'snags', SNAG_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    const after = await currentSnagCounts(sql);
    return { tenantId, snags: tally(ret, snagRows.length), byGranularity, after };
  });
}

module.exports = { writeSnags, SnagQuarantineError, currentSnagCounts };
