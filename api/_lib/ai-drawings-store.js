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

module.exports = {
  OVERRIDE_FIELDS,
  SHEET_TYPES,
  LEGEND_CATEGORIES,
  LEGEND_TRANSITIONS,
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
