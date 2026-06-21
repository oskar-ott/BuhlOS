// Structure UPSERT writer — shared by the bulk importer (structure-import.js)
// AND the J8 dual-write mirror (api/_lib/jobs-mirror.js), so a live mirror and a
// bulk import can never diverge (same rows in, same ON CONFLICT upserts out).
//
// PURE w.r.t. the DB: takes a postgres.js `sql` client + the row payloads from
// buildStructureRows (lib/structure-rows.js), runs the idempotent upserts in ONE
// transaction, and returns per-table tallies. The IS DISTINCT FROM guards mean an
// unchanged re-run writes ZERO rows; the archive-aware deleted_at handling means
// an already-archived row never churns. See structure-import.js for the contract.

const {
  USER_MUTABLE_COLS,
  JOB_MUTABLE_COLS,
  USER_INSERT_COLS,
  JOB_INSERT_COLS,
  GROUP_MUTABLE_COLS,
  AREA_MUTABLE_COLS,
  GROUP_INSERT_COLS,
  AREA_INSERT_COLS,
  TEMPLATE_MUTABLE_COLS,
  TEMPLATE_INSERT_COLS,
} = require('./structure-rows');

// SET fragment "col = excluded.col, …" for an ON CONFLICT DO UPDATE.
function setExcluded(sql, cols) {
  if (!cols.length) throw new Error('setExcluded: no mutable columns');
  return cols.map((c) => sql`${sql(c)} = excluded.${sql(c)}`).reduce((a, b) => sql`${a}, ${b}`);
}
// WHERE fragment "<table>.col IS DISTINCT FROM excluded.col OR …" — the update
// fires only when something changed. The target column MUST be table-qualified
// (unqualified it is ambiguous between the target row and EXCLUDED), and
// `table` MUST equal the table named in the enclosing `insert into public.<table>`.
function distinctFromExcluded(sql, table, cols) {
  if (!cols.length) throw new Error('distinctFromExcluded: no mutable columns');
  return cols
    .map((c) => sql`${sql(table)}.${sql(c)} is distinct from excluded.${sql(c)}`)
    .reduce((a, b) => sql`${a} or ${b}`);
}

// Archive-aware variants for site_area_groups / site_areas / job_task_templates.
// SET deleted_at: unarchive → NULL; newly-archived → stamp; still-archived → keep.
// WHERE: compare the archive STATE (deleted_at NULL-ness), not the proxy timestamp.
function setExcludedArchiveAware(sql, table, plainCols) {
  const plain = setExcluded(sql, plainCols);
  const del = sql`deleted_at = case
      when excluded.deleted_at is null then null
      when ${sql(table)}.deleted_at is null then excluded.deleted_at
      else ${sql(table)}.deleted_at end`;
  return sql`${plain}, ${del}`;
}
function distinctArchiveAware(sql, table, plainCols) {
  const plain = distinctFromExcluded(sql, table, plainCols);
  return sql`${plain} or (${sql(table)}.deleted_at is null) is distinct from (excluded.deleted_at is null)`;
}

// inserted/updated/unchanged from the RETURNING rows. (xmax = 0) marks an insert;
// a DO UPDATE whose IS DISTINCT FROM is false returns no row → `unchanged`. The
// xmax heuristic is reliable for THIS single-transaction, single-writer path.
function tally(returned, total) {
  const inserted = returned.filter((r) => r.inserted).length;
  const updated = returned.length - inserted;
  return { inserted, updated, unchanged: total - returned.length, total };
}

// Build a legacy_id → uuid map from a table, INSIDE the transaction. Needed
// because the IS-DISTINCT-FROM upserts only RETURN changed rows.
async function legacyIdMap(sql, table, tenantId) {
  const rows = await sql`select id, legacy_id from ${sql(table)} where tenant_id = ${tenantId} and legacy_id is not null`;
  return new Map(rows.map((r) => [r.legacy_id, r.id]));
}

// One round-trip (a single connection — safe inside a transaction too).
async function currentCounts(sql) {
  const [c] = await sql`
    select (select count(*)::int from public.tenants)                                    as tenants,
           (select count(*)::int from public.user_profiles where deleted_at is null)     as user_profiles,
           (select count(*)::int from public.jobs where deleted_at is null)              as jobs,
           (select count(*)::int from public.site_area_groups where deleted_at is null)  as site_area_groups,
           (select count(*)::int from public.site_areas where deleted_at is null)        as site_areas,
           (select count(*)::int from public.job_task_templates where deleted_at is null) as job_task_templates,
           (select count(*)::int from public.tasks)                                      as tasks
  `;
  return {
    tenants: c.tenants, user_profiles: c.user_profiles, jobs: c.jobs,
    site_area_groups: c.site_area_groups, site_areas: c.site_areas,
    job_task_templates: c.job_task_templates, tasks: c.tasks,
  };
}

/**
 * Upsert a structure row set (tenant → users → jobs → groups → areas → templates)
 * in ONE transaction. Idempotent. opts.counts (default true) appends a `after`
 * snapshot via currentCounts — the bulk importer wants it; the dual-write mirror
 * passes { counts:false } to avoid an extra round-trip on the hot write path.
 */
async function writeAll(sql, { tenantRow, userRows, jobRows, groupRows, areaRows, templateRows }, opts = {}) {
  const withCounts = opts.counts !== false;
  return sql.begin(async (sql) => {
    // Tenant: insert once, then read its id — fully idempotent (no re-touch).
    let rows = await sql`
      insert into public.tenants ${sql([tenantRow], 'slug', 'name')}
      on conflict (slug) do nothing
      returning id
    `;
    if (!rows.length) {
      rows = await sql`select id from public.tenants where slug = ${tenantRow.slug}`;
    }
    const tenantId = rows[0].id;

    const userRowsT = userRows.map((r) => ({ ...r, tenant_id: tenantId }));
    const jobRowsT = jobRows.map((r) => ({ ...r, tenant_id: tenantId }));

    const userRet = userRowsT.length
      ? await sql`
          insert into public.user_profiles ${sql(userRowsT, ...USER_INSERT_COLS)}
          on conflict (tenant_id, legacy_user_id) where legacy_user_id is not null
          do update set ${setExcluded(sql, USER_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'user_profiles', USER_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    const jobRet = jobRowsT.length
      ? await sql`
          insert into public.jobs ${sql(jobRowsT, ...JOB_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcluded(sql, JOB_MUTABLE_COLS)}
          where ${distinctFromExcluded(sql, 'jobs', JOB_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Resolve job uuids (reuses the existing 'buhl' jobs, matched on legacy_id).
    const jobMap = await legacyIdMap(sql, 'jobs', tenantId);
    const groupRowsT = (groupRows || []).map((r) => {
      const job_id = jobMap.get(r.job_legacy_id);
      if (!job_id) throw new Error(`group ${r.legacy_id}: job legacy_id ${r.job_legacy_id} not found in Postgres`);
      return {
        tenant_id: tenantId, job_id, legacy_id: r.legacy_id, name: r.name,
        sort_order: r.sort_order, deleted_at: r.deleted_at, deleted_by: r.deleted_by, created_at: r.created_at,
      };
    });

    const groupRet = groupRowsT.length
      ? await sql`
          insert into public.site_area_groups ${sql(groupRowsT, ...GROUP_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'site_area_groups', GROUP_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'site_area_groups', GROUP_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Resolve group uuids (after the group upsert) for the area FK.
    const groupMap = await legacyIdMap(sql, 'site_area_groups', tenantId);
    const areaRowsT = (areaRows || []).map((r) => {
      const job_id = jobMap.get(r.job_legacy_id);
      if (!job_id) throw new Error(`area ${r.legacy_id}: job legacy_id ${r.job_legacy_id} not found in Postgres`);
      let group_id = null;
      if (r.group_legacy_id) {
        group_id = groupMap.get(r.group_legacy_id);
        if (!group_id) throw new Error(`area ${r.legacy_id}: group legacy_id ${r.group_legacy_id} not found in Postgres`);
      }
      return {
        tenant_id: tenantId, job_id, group_id, legacy_id: r.legacy_id, name: r.name,
        space_type: r.space_type, sort_order: r.sort_order, deleted_at: r.deleted_at,
        deleted_by: r.deleted_by, created_at: r.created_at,
      };
    });

    const areaRet = areaRowsT.length
      ? await sql`
          insert into public.site_areas ${sql(areaRowsT, ...AREA_INSERT_COLS)}
          on conflict (tenant_id, legacy_id) where legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'site_areas', AREA_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'site_areas', AREA_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    // Resolve area uuids (after the area upsert) for per-area override templates.
    // Split by level: job-level (site_area_id NULL) and area-level rows target
    // DIFFERENT partial unique indexes, so they need separate ON CONFLICT upserts.
    const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);
    const tplJobLevel = [];
    const tplAreaLevel = [];
    for (const r of templateRows || []) {
      const job_id = jobMap.get(r.job_legacy_id);
      if (!job_id) throw new Error(`template ${r.legacy_id}: job legacy_id ${r.job_legacy_id} not found in Postgres`);
      let site_area_id = null;
      if (r.site_area_legacy_id) {
        site_area_id = areaMap.get(r.site_area_legacy_id);
        if (!site_area_id) throw new Error(`template ${r.legacy_id}: site_area legacy_id ${r.site_area_legacy_id} not found in Postgres`);
      }
      const row = {
        tenant_id: tenantId, job_id, site_area_id, stage: r.stage, legacy_id: r.legacy_id,
        name: r.name, sort_order: r.sort_order, deleted_at: r.deleted_at, deleted_by: r.deleted_by, created_at: r.created_at,
      };
      (site_area_id === null ? tplJobLevel : tplAreaLevel).push(row);
    }

    const tplJobRet = tplJobLevel.length
      ? await sql`
          insert into public.job_task_templates ${sql(tplJobLevel, ...TEMPLATE_INSERT_COLS)}
          on conflict (tenant_id, job_id, stage, legacy_id) where site_area_id is null and legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    const tplAreaRet = tplAreaLevel.length
      ? await sql`
          insert into public.job_task_templates ${sql(tplAreaLevel, ...TEMPLATE_INSERT_COLS)}
          on conflict (tenant_id, site_area_id, stage, legacy_id) where site_area_id is not null and legacy_id is not null
          do update set ${setExcludedArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
          where ${distinctArchiveAware(sql, 'job_task_templates', TEMPLATE_MUTABLE_COLS)}
          returning (xmax = 0) as inserted
        `
      : [];

    const result = {
      tenantId,
      users: tally(userRet, userRowsT.length),
      jobs: tally(jobRet, jobRowsT.length),
      site_area_groups: tally(groupRet, groupRowsT.length),
      site_areas: tally(areaRet, areaRowsT.length),
      job_task_templates: tally([...tplJobRet, ...tplAreaRet], tplJobLevel.length + tplAreaLevel.length),
    };
    // Count INSIDE the transaction — on a max:1 pool a post-commit query would
    // wait forever for the single connection the transaction just released.
    if (withCounts) result.after = await currentCounts(sql);
    return result;
  });
}

module.exports = {
  writeAll, currentCounts, tally, legacyIdMap,
  setExcluded, distinctFromExcluded, setExcludedArchiveAware, distinctArchiveAware,
};
