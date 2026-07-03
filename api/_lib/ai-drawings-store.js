// Epic 5 (#197) — Supabase extraction store for plan-sheet page understanding.
//
// Pure SQL seam: every function takes the postgres.js `sql` client as its
// first argument, so the handler owns connection/guard concerns
// (api/_lib/supabase-db.js getDb + its fail-closed env gate) and tests can
// inject a fake without faking tagged-template SQL parsing.
//
// Tables (supabase/migrations/20260702190000_epic5_plan_sheet_extractions.sql):
//   plan_sheet_extractions — append-only raw AI run log (full provenance)
//   plan_sheets            — current projection per (job, plan, page)
//   plan_sheet_overrides   — human corrections, win on read, survive re-runs
//
// job_id / plan_id are the app's legacy text ids (plans are Blob-only; the
// jobs PG mirror is dark) — documented in the migration header.

// The five override-able fields, in the exact camelCase spelling the app
// writes (mirrors the DB CHECK constraint).
const OVERRIDE_FIELDS = ['sheetType', 'sheetNumber', 'sheetTitle', 'revision', 'scale'];

// Sheet-type vocabulary (#197 AC fixed set — mirrors the DB CHECK constraint).
const SHEET_TYPES = ['floorPlan', 'schematic', 'schedule', 'legend', 'titleCover', 'detail', 'other'];

async function resolveTenantId(sql) {
  const slug = process.env.SUPABASE_TENANT_SLUG || 'buhl';
  const rows = await sql`select id from public.tenants where slug = ${slug}`;
  if (!rows.length) throw new Error('[ai-drawings-store] tenant not found: ' + slug);
  return rows[0].id;
}

// Cache lookup: an unchanged page analysed with the same kind/prompt/model
// never runs twice. Returns the extraction row or null.
async function findCachedExtraction(sql, tenantId, key) {
  const rows = await sql`
    select * from public.plan_sheet_extractions
    where tenant_id = ${tenantId}
      and job_id = ${key.jobId} and plan_id = ${key.planId}
      and page_index = ${key.pageIndex} and page_sha256 = ${key.pageSha256}
      and kind = ${key.kind} and prompt_version = ${key.promptVersion}
      and model = ${key.model}
    limit 1`;
  return rows.length ? rows[0] : null;
}

// Append one raw AI run. Returns the inserted row (with id).
async function insertExtraction(sql, tenantId, row) {
  const rows = await sql`
    insert into public.plan_sheet_extractions (
      tenant_id, job_id, plan_id, page_index, page_sha256, kind, model,
      prompt_version, raw,
      sheet_type, sheet_type_confidence,
      sheet_number, sheet_number_confidence,
      sheet_title, sheet_title_confidence,
      revision, revision_confidence,
      scale, scale_confidence,
      region, input_tokens, output_tokens, created_by_label
    ) values (
      ${tenantId}, ${row.jobId}, ${row.planId}, ${row.pageIndex}, ${row.pageSha256},
      ${row.kind}, ${row.model}, ${row.promptVersion}, ${sql.json(row.raw)},
      ${row.sheetType}, ${row.sheetTypeConfidence},
      ${row.sheetNumber}, ${row.sheetNumberConfidence},
      ${row.sheetTitle}, ${row.sheetTitleConfidence},
      ${row.revision}, ${row.revisionConfidence},
      ${row.scale}, ${row.scaleConfidence},
      ${row.region === null ? null : sql.json(row.region)},
      ${row.inputTokens}, ${row.outputTokens}, ${row.createdByLabel}
    )
    returning *`;
  return rows[0];
}

// Upsert the current projection for a page from an extraction row.
async function upsertPlanSheet(sql, tenantId, e) {
  await sql`
    insert into public.plan_sheets (
      tenant_id, job_id, plan_id, page_index, extraction_id, page_sha256,
      sheet_type, sheet_type_confidence,
      sheet_number, sheet_number_confidence,
      sheet_title, sheet_title_confidence,
      revision, revision_confidence,
      scale, scale_confidence,
      model, prompt_version, updated_at
    ) values (
      ${tenantId}, ${e.job_id}, ${e.plan_id}, ${e.page_index}, ${e.id}, ${e.page_sha256},
      ${e.sheet_type}, ${e.sheet_type_confidence},
      ${e.sheet_number}, ${e.sheet_number_confidence},
      ${e.sheet_title}, ${e.sheet_title_confidence},
      ${e.revision}, ${e.revision_confidence},
      ${e.scale}, ${e.scale_confidence},
      ${e.model}, ${e.prompt_version}, now()
    )
    on conflict (tenant_id, job_id, plan_id, page_index) do update set
      extraction_id = excluded.extraction_id,
      page_sha256 = excluded.page_sha256,
      sheet_type = excluded.sheet_type,
      sheet_type_confidence = excluded.sheet_type_confidence,
      sheet_number = excluded.sheet_number,
      sheet_number_confidence = excluded.sheet_number_confidence,
      sheet_title = excluded.sheet_title,
      sheet_title_confidence = excluded.sheet_title_confidence,
      revision = excluded.revision,
      revision_confidence = excluded.revision_confidence,
      scale = excluded.scale,
      scale_confidence = excluded.scale_confidence,
      model = excluded.model,
      prompt_version = excluded.prompt_version,
      updated_at = now()`;
}

async function listPlanSheets(sql, tenantId, jobId) {
  return await sql`
    select * from public.plan_sheets
    where tenant_id = ${tenantId} and job_id = ${jobId}
    order by plan_id, page_index`;
}

async function listOverrides(sql, tenantId, jobId) {
  return await sql`
    select * from public.plan_sheet_overrides
    where tenant_id = ${tenantId} and job_id = ${jobId}
    order by plan_id, page_index, field`;
}

async function upsertOverride(sql, tenantId, o) {
  await sql`
    insert into public.plan_sheet_overrides (
      tenant_id, job_id, plan_id, page_index, field, value,
      corrected_by, corrected_by_user_id, corrected_at
    ) values (
      ${tenantId}, ${o.jobId}, ${o.planId}, ${o.pageIndex}, ${o.field}, ${o.value},
      ${o.correctedBy}, ${o.correctedByUserId}, now()
    )
    on conflict (tenant_id, job_id, plan_id, page_index, field) do update set
      value = excluded.value,
      corrected_by = excluded.corrected_by,
      corrected_by_user_id = excluded.corrected_by_user_id,
      corrected_at = now()`;
}

async function deleteOverride(sql, tenantId, jobId, planId, pageIndex, field) {
  const rows = await sql`
    delete from public.plan_sheet_overrides
    where tenant_id = ${tenantId} and job_id = ${jobId}
      and plan_id = ${planId} and page_index = ${pageIndex} and field = ${field}
    returning field`;
  return rows.length > 0;
}

// ─── #201: legend vocabulary ────────────────────────────────────────────────

// Category vocabulary (mirrors the DB CHECK; from the Phase-9 legend taxonomy).
const LEGEND_CATEGORIES = ['Power', 'Lighting', 'Switch', 'Data', 'Comms', 'Safety', 'Mechanical', 'EV', 'Appliance', 'Other'];

// Review-state machine for vocabulary rows. Follows the house
// api/_lib/ai-suggestions.js machine with ONE documented extension: a live
// (accepted|edited) entry may still be rejected later — bogus vocabulary must
// be removable after acceptance or #204 recognition would keep consuming it.
// The AI payload itself is never rewritten; rejection is a review action with
// its own audit row.
const LEGEND_TRANSITIONS = {
  suggested: ['accepted', 'edited', 'rejected'],
  accepted: ['rejected'],
  edited: ['rejected'],
  rejected: [],
  superseded: [],
};

// Dedupe key: one live entry per normalised label per job.
function normalizeLabel(label) {
  return String(label || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

async function listLegendEntries(sql, tenantId, jobId) {
  return await sql`
    select * from public.legend_entries
    where tenant_id = ${tenantId} and job_id = ${jobId}
      and status <> 'superseded'
    order by category nulls last, normalized_label`;
}

// The reviewed vocabulary downstream consumers (#204/#205) read.
async function acceptedLegendEntries(sql, tenantId, jobId) {
  return await sql`
    select * from public.legend_entries
    where tenant_id = ${tenantId} and job_id = ${jobId}
      and status in ('accepted', 'edited')
    order by category nulls last, normalized_label`;
}

// Labels a human explicitly rejected — a re-run must not resurrect them.
async function rejectedLegendLabels(sql, tenantId, jobId) {
  const rows = await sql`
    select distinct normalized_label from public.legend_entries
    where tenant_id = ${tenantId} and job_id = ${jobId} and status = 'rejected'`;
  return rows.map((r) => r.normalized_label);
}

// Merge one extraction's entries into the vocabulary. The partial unique
// index (one live entry per normalised label) makes duplicates no-ops —
// multiple legend sheets/blocks converge on ONE vocabulary (#201 AC).
// Returns { inserted: rows[], duplicates: number }.
async function insertLegendSuggestions(sql, tenantId, rows) {
  const inserted = [];
  let duplicates = 0;
  for (const row of rows) {
    const out = await sql`
      insert into public.legend_entries (
        tenant_id, job_id, origin, status, label, normalized_label,
        description, category, symbol_text, crop_region,
        source_plan_id, source_page_index, source_page_sha256,
        extraction_id, confidence, model, prompt_version, created_by_label
      ) values (
        ${tenantId}, ${row.jobId}, 'ai', 'suggested', ${row.label}, ${normalizeLabel(row.label)},
        ${row.description}, ${row.category}, ${row.symbolText},
        ${row.cropRegion === null ? null : sql.json(row.cropRegion)},
        ${row.sourcePlanId}, ${row.sourcePageIndex}, ${row.sourcePageSha256},
        ${row.extractionId}, ${row.confidence}, ${row.model}, ${row.promptVersion}, ${row.createdByLabel}
      )
      on conflict (tenant_id, job_id, normalized_label)
        where status in ('suggested', 'accepted', 'edited')
      do nothing
      returning *`;
    if (out.length) inserted.push(out[0]);
    else duplicates += 1;
  }
  return { inserted, duplicates };
}

async function getLegendEntry(sql, tenantId, jobId, entryId) {
  const rows = await sql`
    select * from public.legend_entries
    where tenant_id = ${tenantId} and job_id = ${jobId} and id = ${entryId}`;
  return rows.length ? rows[0] : null;
}

// Apply a review transition. Guarded by the machine above; the WHERE clause
// re-checks the from-status so concurrent reviews can't double-apply.
async function reviewLegendEntry(sql, tenantId, jobId, entry, next) {
  const rows = await sql`
    update public.legend_entries set
      status = ${next.status},
      human_label = ${next.humanLabel === undefined ? entry.human_label : next.humanLabel},
      review_note = ${next.note === undefined ? entry.review_note : next.note},
      reviewed_at = now(),
      reviewed_by_label = ${next.reviewedByLabel}
    where tenant_id = ${tenantId} and job_id = ${jobId} and id = ${entry.id}
      and status = ${entry.status}
    returning *`;
  return rows.length ? rows[0] : null;
}

// Human-added entry: pre-accepted, no model provenance to invent (P7).
// Returns null when a live entry already holds the label.
async function addHumanLegendEntry(sql, tenantId, row) {
  const out = await sql`
    insert into public.legend_entries (
      tenant_id, job_id, origin, status, label, normalized_label,
      description, category, created_by_label, reviewed_at, reviewed_by_label
    ) values (
      ${tenantId}, ${row.jobId}, 'human', 'accepted', ${row.label}, ${normalizeLabel(row.label)},
      ${row.description}, ${row.category}, ${row.createdByLabel}, now(), ${row.createdByLabel}
    )
    on conflict (tenant_id, job_id, normalized_label)
      where status in ('suggested', 'accepted', 'edited')
    do nothing
    returning *`;
  return out.length ? out[0] : null;
}

async function setLegendCrop(sql, tenantId, jobId, entryId, url) {
  const rows = await sql`
    update public.legend_entries
    set symbol_crop_url = ${url}
    where tenant_id = ${tenantId} and job_id = ${jobId} and id = ${entryId}
    returning *`;
  return rows.length ? rows[0] : null;
}

// ─── #202/#207: schedule tables (table-type-agnostic machinery) ─────────────

// Canonical column vocabularies per table kind. The model maps each raw
// header it reads onto one of these (or keeps it as an extra column keyed by
// its raw header). #207's switchboard set is named for compatibility with
// the circuitBoards vocabulary in api/job-circuits.js.
const SCHEDULE_COLUMNS = {
  lighting: ['typeCode', 'description', 'manufacturer', 'model', 'lamp', 'wattage', 'qty'],
  switchboard: ['circuitRef', 'description', 'protection', 'cableSize', 'phase', 'load'],
};

// Row review machine — same grammar as legend entries: live rows are still
// rejectable (a bad row must be removable before takeoff consumes it).
const SCHEDULE_ROW_TRANSITIONS = {
  suggested: ['accepted', 'edited', 'rejected'],
  accepted: ['rejected', 'edited'],
  edited: ['rejected', 'edited'],
  rejected: [],
};

async function listScheduleTables(sql, tenantId, jobId) {
  return await sql`
    select * from public.schedule_tables
    where tenant_id = ${tenantId} and job_id = ${jobId} and status = 'live'
    order by table_kind, plan_id, page_index, created_at`;
}

async function listScheduleRowsForTables(sql, tenantId, tableIds) {
  if (!tableIds.length) return [];
  return await sql`
    select * from public.schedule_rows
    where tenant_id = ${tenantId} and table_id = any(${tableIds})
    order by table_id, row_index`;
}

// Insert one extraction's tables + rows, superseding any live tables for the
// same (job, plan, page, kind) — reviewed history is never rewritten.
async function insertScheduleTables(sql, tenantId, ctx, tables) {
  const insertedTables = [];
  for (const t of tables) {
    const rows = await sql`
      insert into public.schedule_tables (
        tenant_id, job_id, plan_id, page_index, page_sha256, table_kind,
        board_identifier, region, headers, column_map, extraction_id,
        row_count, model, prompt_version, created_by_label
      ) values (
        ${tenantId}, ${ctx.jobId}, ${ctx.planId}, ${ctx.pageIndex}, ${ctx.pageSha256},
        ${ctx.tableKind}, ${t.boardIdentifier},
        ${t.region === null ? null : sql.json(t.region)},
        ${sql.json(t.headers)}, ${sql.json(t.columnMap)}, ${ctx.extractionId},
        ${t.rows.length}, ${ctx.model}, ${ctx.promptVersion}, ${ctx.createdByLabel}
      ) returning *`;
    const table = rows[0];
    for (let i = 0; i < t.rows.length; i += 1) {
      const r = t.rows[i];
      await sql`
        insert into public.schedule_rows (
          tenant_id, table_id, job_id, row_index, cells, row_region
        ) values (
          ${tenantId}, ${table.id}, ${ctx.jobId}, ${i}, ${sql.json(r.cells)},
          ${r.rowRegion === null ? null : sql.json(r.rowRegion)}
        )`;
    }
    insertedTables.push(table);
  }
  // Supersede the previously-live tables for this page+kind (not the ones we
  // just inserted). Pointing at the first new table is enough lineage.
  const newIds = insertedTables.map((t) => t.id);
  if (newIds.length) {
    await sql`
      update public.schedule_tables
      set status = 'superseded', superseded_by = ${newIds[0]}
      where tenant_id = ${tenantId} and job_id = ${ctx.jobId}
        and plan_id = ${ctx.planId} and page_index = ${ctx.pageIndex}
        and table_kind = ${ctx.tableKind} and status = 'live'
        and id <> all(${newIds})`;
  }
  return insertedTables;
}

// Live tables already produced by a cached extraction run (idempotent
// re-click) — matched by extraction id.
async function liveTablesForExtraction(sql, tenantId, extractionId) {
  return await sql`
    select * from public.schedule_tables
    where tenant_id = ${tenantId} and extraction_id = ${extractionId} and status = 'live'`;
}

async function getScheduleRow(sql, tenantId, jobId, rowId) {
  const rows = await sql`
    select * from public.schedule_rows
    where tenant_id = ${tenantId} and job_id = ${jobId} and id = ${rowId}`;
  return rows.length ? rows[0] : null;
}

async function reviewScheduleRow(sql, tenantId, jobId, row, next) {
  const rows = await sql`
    update public.schedule_rows set
      status = ${next.status},
      human_cells = ${next.humanCells === undefined ? row.human_cells : (next.humanCells === null ? null : sql.json(next.humanCells))},
      review_note = ${next.note === undefined ? row.review_note : next.note},
      reviewed_at = now(),
      reviewed_by_label = ${next.reviewedByLabel}
    where tenant_id = ${tenantId} and job_id = ${jobId} and id = ${row.id}
      and status = ${row.status}
    returning *`;
  return rows.length ? rows[0] : null;
}

// ─── #203: revision diffs ───────────────────────────────────────────────────

// Review state is human bookkeeping (who walked which region) — flippable,
// unlike the AI-provenance machines above.
const DIFF_REGION_TRANSITIONS = {
  pending: ['reviewed', 'dismissed'],
  reviewed: ['dismissed'],
  dismissed: ['reviewed'],
};

async function findLiveDiff(sql, tenantId, jobId, baseSha, headSha, algoVersion) {
  const rows = await sql`
    select * from public.page_diffs
    where tenant_id = ${tenantId} and job_id = ${jobId}
      and base_page_sha256 = ${baseSha} and head_page_sha256 = ${headSha}
      and algo_version = ${algoVersion} and status = 'live'`;
  return rows.length ? rows[0] : null;
}

// Insert a diff + its regions, superseding any live diff for the same
// sha pair (an older algo run) — reviewed regions stay on the old row.
async function insertPageDiff(sql, tenantId, d, regions) {
  const rows = await sql`
    insert into public.page_diffs (
      tenant_id, job_id,
      base_plan_id, base_page_index, base_page_sha256,
      head_plan_id, head_page_index, head_page_sha256,
      algo_version, identical, alignment, basis, region_count, created_by_label
    ) values (
      ${tenantId}, ${d.jobId},
      ${d.basePlanId}, ${d.basePageIndex}, ${d.basePageSha256},
      ${d.headPlanId}, ${d.headPageIndex}, ${d.headPageSha256},
      ${d.algoVersion}, ${d.identical},
      ${d.alignment === null ? null : sql.json(d.alignment)},
      ${sql.json(d.basis)}, ${regions.length}, ${d.createdByLabel}
    ) returning *`;
  const diff = rows[0];
  for (let i = 0; i < regions.length; i += 1) {
    const r = regions[i];
    await sql`
      insert into public.diff_regions (
        tenant_id, diff_id, job_id, region_index, bbox, area_cells
      ) values (
        ${tenantId}, ${diff.id}, ${d.jobId}, ${i}, ${sql.json(r.bbox)}, ${r.areaCells}
      )`;
  }
  await sql`
    update public.page_diffs
    set status = 'superseded', superseded_by = ${diff.id}
    where tenant_id = ${tenantId} and job_id = ${d.jobId}
      and base_page_sha256 = ${d.basePageSha256}
      and head_page_sha256 = ${d.headPageSha256}
      and status = 'live' and id <> ${diff.id}`;
  return diff;
}

async function listPageDiffs(sql, tenantId, jobId) {
  return await sql`
    select * from public.page_diffs
    where tenant_id = ${tenantId} and job_id = ${jobId} and status = 'live'
    order by head_plan_id, head_page_index, created_at`;
}

async function listDiffRegionsForDiffs(sql, tenantId, diffIds) {
  if (!diffIds.length) return [];
  return await sql`
    select * from public.diff_regions
    where tenant_id = ${tenantId} and diff_id = any(${diffIds})
    order by diff_id, region_index`;
}

async function getDiffRegion(sql, tenantId, jobId, regionId) {
  const rows = await sql`
    select * from public.diff_regions
    where tenant_id = ${tenantId} and job_id = ${jobId} and id = ${regionId}`;
  return rows.length ? rows[0] : null;
}

async function reviewDiffRegion(sql, tenantId, jobId, region, next) {
  const rows = await sql`
    update public.diff_regions set
      status = ${next.status},
      review_note = ${next.note === undefined ? region.review_note : next.note},
      reviewed_at = now(),
      reviewed_by_label = ${next.reviewedByLabel}
    where tenant_id = ${tenantId} and job_id = ${jobId} and id = ${region.id}
      and status = ${region.status}
    returning *`;
  return rows.length ? rows[0] : null;
}

// ─── #204: locational device detection ──────────────────────────────────────

// Intersection-over-union of two normalised boxes — the seam-dedup measure.
function boxIoU(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  // clamp — float error can push identical boxes a hair over 1
  return union > 0 ? Math.min(1, Math.max(0, inter / union)) : 0;
}

function tileKeyOf(region) {
  const f = (n) => n.toFixed(4);
  return `${f(region.x)},${f(region.y)},${f(region.w)},${f(region.h)}`;
}

async function findCachedDetectionRun(sql, tenantId, key) {
  const rows = await sql`
    select * from public.detection_runs
    where tenant_id = ${tenantId} and job_id = ${key.jobId}
      and plan_id = ${key.planId} and page_index = ${key.pageIndex}
      and page_sha256 = ${key.pageSha256} and tile_key = ${key.tileKey}
      and prompt_version = ${key.promptVersion} and model = ${key.model}
    limit 1`;
  return rows.length ? rows[0] : null;
}

async function insertDetectionRun(sql, tenantId, run) {
  const rows = await sql`
    insert into public.detection_runs (
      tenant_id, job_id, plan_id, page_index, page_sha256, tile_key,
      tile_region, prompt_version, model, raw, input_tokens, output_tokens,
      created_by_label
    ) values (
      ${tenantId}, ${run.jobId}, ${run.planId}, ${run.pageIndex}, ${run.pageSha256},
      ${run.tileKey}, ${sql.json(run.tileRegion)}, ${run.promptVersion}, ${run.model},
      ${sql.json(run.raw)}, ${run.inputTokens}, ${run.outputTokens}, ${run.createdByLabel}
    ) returning *`;
  return rows[0];
}

async function listDeviceDetectionsForPage(sql, tenantId, jobId, planId, pageIndex, pageSha256) {
  return await sql`
    select * from public.device_detections
    where tenant_id = ${tenantId} and job_id = ${jobId}
      and plan_id = ${planId} and page_index = ${pageIndex}
      and page_sha256 = ${pageSha256}
    order by created_at, id`;
}

async function listDeviceDetections(sql, tenantId, jobId) {
  return await sql`
    select * from public.device_detections
    where tenant_id = ${tenantId} and job_id = ${jobId}
    order by plan_id, page_index, created_at`;
}

// Insert one tile's detections, dropping duplicates: a device candidate that
// overlaps (IoU > threshold) an EXISTING detection of the same legend entry
// on the same raster is the same physical device seen from two tiles; an
// uncertain-region candidate overlapping an existing uncertain region is the
// same flagged area (this is also what makes a cached re-click idempotent).
async function insertDeviceDetections(sql, tenantId, ctx, candidates, iouThreshold) {
  const existing = await listDeviceDetectionsForPage(
    sql, tenantId, ctx.jobId, ctx.planId, ctx.pageIndex, ctx.pageSha256,
  );
  const inserted = [];
  let seamDuplicates = 0;
  const kept = existing.map((e) => ({ bbox: e.bbox, legendEntryId: e.legend_entry_id, kind: e.kind }));
  for (const c of candidates) {
    const dup = kept.some(
      (k) =>
        k.kind === c.kind &&
        (c.kind !== 'device' || k.legendEntryId === c.legendEntryId) &&
        boxIoU(k.bbox, c.bbox) > iouThreshold,
    );
    if (dup) {
      seamDuplicates += 1;
      continue;
    }
    const rows = await sql`
      insert into public.device_detections (
        tenant_id, job_id, plan_id, page_index, page_sha256, run_id, kind,
        legend_entry_id, label, bbox, confidence, note
      ) values (
        ${tenantId}, ${ctx.jobId}, ${ctx.planId}, ${ctx.pageIndex}, ${ctx.pageSha256},
        ${ctx.runId}, ${c.kind}, ${c.legendEntryId}, ${c.label},
        ${sql.json(c.bbox)}, ${c.confidence}, ${c.note}
      ) returning *`;
    inserted.push(rows[0]);
    kept.push({ bbox: c.bbox, legendEntryId: c.legendEntryId, kind: c.kind });
  }
  return { inserted, seamDuplicates };
}

module.exports = {
  OVERRIDE_FIELDS,
  SHEET_TYPES,
  LEGEND_CATEGORIES,
  LEGEND_TRANSITIONS,
  SCHEDULE_COLUMNS,
  SCHEDULE_ROW_TRANSITIONS,
  DIFF_REGION_TRANSITIONS,
  boxIoU,
  tileKeyOf,
  findCachedDetectionRun,
  insertDetectionRun,
  listDeviceDetections,
  listDeviceDetectionsForPage,
  insertDeviceDetections,
  findLiveDiff,
  insertPageDiff,
  listPageDiffs,
  listDiffRegionsForDiffs,
  getDiffRegion,
  reviewDiffRegion,
  listScheduleTables,
  listScheduleRowsForTables,
  insertScheduleTables,
  liveTablesForExtraction,
  getScheduleRow,
  reviewScheduleRow,
  normalizeLabel,
  resolveTenantId,
  findCachedExtraction,
  insertExtraction,
  upsertPlanSheet,
  listPlanSheets,
  listOverrides,
  upsertOverride,
  deleteOverride,
  listLegendEntries,
  acceptedLegendEntries,
  rejectedLegendLabels,
  insertLegendSuggestions,
  getLegendEntry,
  reviewLegendEntry,
  addHumanLegendEntry,
  setLegendCrop,
};
