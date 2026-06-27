// Shared evidence writer (#152) — the ONE idempotent upsert of evidence metadata
// (public.evidence_files + public.evidence_links) from blob sources. Extracted
// VERBATIM from scripts/importers/evidence-import.js so the operator importer and
// the best-effort dual-write mirror (api/_lib/evidence-mirror.js) share ONE writer
// and can never diverge (the structure-writer.js / jobs-mirror.js pattern).
//
// READ of the Blob is the CALLER's job (sources are passed in). The ONLY writes
// are the two upserts, in ONE transaction:
//   * evidence_files  upsert on (tenant, legacy_id) with IS DISTINCT FROM
//   * evidence_links  upsert on the dedupe index DO NOTHING
// Re-run with no change writes 0 rows. metadata only — binaries stay in Blob.
//
// QUARANTINE: buildEvidenceRows fail-closes any unresolvable coordinate / out-of-
// CHECK value. writeEvidence NEVER coerces; the caller decides what to do with the
// quarantine list — the importer ABORTS (all-or-nothing), the mirror reports it
// and skips that run (best-effort, Blob authoritative).

const {
  buildEvidenceRows, buildEvidenceLinkRows,
  EVIDENCE_INSERT_COLS, EVIDENCE_MUTABLE_COLS, EVIDENCE_LINK_INSERT_COLS,
} = require('./evidence-rows');

class QuarantineError extends Error {
  constructor(quarantine) { super('quarantined evidence'); this.quarantine = quarantine; }
}

function setExcluded(sql, cols) {
  return cols.map((c) => sql`${sql(c)} = excluded.${sql(c)}`).reduce((a, b) => sql`${a}, ${b}`);
}
function distinctFromExcluded(sql, table, cols) {
  return cols.map((c) => sql`${sql(table)}.${sql(c)} is distinct from excluded.${sql(c)}`).reduce((a, b) => sql`${a} or ${b}`);
}
function tally(returned, total) {
  const inserted = returned.filter((r) => r.inserted).length;
  return { inserted, updated: returned.length - inserted, unchanged: total - returned.length, total };
}

async function legacyIdMap(sql, table, tenantId, col = 'legacy_id') {
  const rows = await sql`select id, ${sql(col)} as legacy from ${sql(table)} where tenant_id = ${tenantId} and ${sql(col)} is not null`;
  return new Map(rows.map((r) => [r.legacy, r.id]));
}

async function resolveMaps(sql, tenantId) {
  const jobMap = await legacyIdMap(sql, 'jobs', tenantId);
  const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);
  const userMap = await legacyIdMap(sql, 'user_profiles', tenantId, 'legacy_user_id');
  // taskMap keyed by the proof bridge `${areaLegacy}|${stage}|${legacy_template_id}`.
  const taskRows = await sql`
    select t.id, ar.legacy_id as area_legacy, t.stage, t.legacy_template_id
    from public.tasks t
    join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.site_area_id is not null and t.legacy_template_id is not null
  `;
  const taskMap = new Map(taskRows.map((r) => [`${r.area_legacy}|${r.stage}|${r.legacy_template_id}`, r.id]));
  return { jobMap, areaMap, userMap, taskMap };
}

async function currentCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.evidence_files where deleted_at is null) as evidence_files,
           (select count(*)::int from public.evidence_links)                          as evidence_links
  `;
  return { evidence_files: c.evidence_files, evidence_links: c.evidence_links };
}

/**
 * Upsert all evidence metadata for the tenant from `sources` (blob jobs+jobData).
 * ONE transaction. Throws QuarantineError (rollback, nothing written) on ANY
 * quarantine — the caller chooses whether to surface or tolerate it. Idempotent.
 * @param {any} sql postgres.js client (write)
 * @param {{jobs:any, jobData:object}} sources blob jobs.json + per-job data.json
 */
async function writeEvidence(sql, sources) {
  return sql.begin(async (sql) => {
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const maps = await resolveMaps(sql, tenantId);
    const { evidenceRows, quarantine, byGranularity } = buildEvidenceRows(sources, { tenantId, ...maps });
    if (quarantine.length) throw new QuarantineError(quarantine);

    const evRet = evidenceRows.length
      ? await sql`
          insert into public.evidence_files ${sql(evidenceRows, ...EVIDENCE_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcluded(sql, EVIDENCE_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'evidence_files', EVIDENCE_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Task-proof links for EVERY task-resolved evidence file (not just changed
    // ones), so the link exists even when the evidence row was unchanged. Dedupe
    // index makes this idempotent.
    const taskEvidence = await sql`
      select id, task_id from public.evidence_files
      where tenant_id = ${tenantId} and task_id is not null and deleted_at is null
    `;
    const linkRows = buildEvidenceLinkRows(tenantId, [...taskEvidence]);
    const linkRet = linkRows.length
      ? await sql`
          insert into public.evidence_links ${sql(linkRows, ...EVIDENCE_LINK_INSERT_COLS)}
          on conflict (evidence_file_id, linked_entity_type, linked_entity_id, link_role) do nothing
          returning (xmax = 0) as inserted
        `
      : [];

    const after = await currentCounts(sql);
    return {
      tenantId,
      evidence: tally(evRet, evidenceRows.length),
      links: { inserted: linkRet.length, candidates: linkRows.length },
      byGranularity,
      after,
    };
  });
}

module.exports = {
  writeEvidence, QuarantineError,
  resolveMaps, currentCounts, legacyIdMap, setExcluded, distinctFromExcluded, tally,
};
