// Structure import row builder — PURE. No I/O, no Supabase, no Blob.
//
// Turns the legacy Blob sources (users.json, jobs.json) into the row payloads
// the structure importer upserts. Slices:
//   * FK-root slice (PR #585): tenant → user_profiles → jobs.
//   * J1 (this slice): site_area_groups → site_areas (the place facets).
//
// J1 group/area identity (docs/audits/jobs-tasks-supabase-j0-audit.md):
//   * legacy_id is a JOB-SCOPED composite (compositeLegacyId) — blob group/area
//     ids are per-job-local, but the PG uniqueness index is tenant-wide, so the
//     raw id is unsafe. Composite collisions (the same blob id twice within one
//     job, incl. a live + archived reuse the tenant-wide index can't hold) are
//     QUARANTINED — fail closed, never remapped silently.
//   * archived → deleted_at (proxy = import time; the blob carries no deletion
//     timestamp). deleted_by stays NULL — there is no system-actor user, and the
//     column is nullable, so a NULL honestly records "actor unknown" rather than
//     fabricating a fake user. The writer's upsert preserves an already-set
//     deleted_at so re-runs do not churn (the proxy timestamp is only stamped on
//     first archival).
//
// Deliberately NOT in this slice (each is its own follow-up):
//   * job_members — additive later.
//   * job_task_templates / tasks — task identity must bind to the canonical
//     task index (roadmap risk: "importer forks task identity"); governed
//     separately, never minted blind here.
//
// Per-job columns that need cross-table resolution are deferred and left NULL
// (the schema makes them nullable): jobs.client_user_id / created_by / updated_by
// (would resolve a legacy user id to a minted uuid) and jobs.modules (jsonb;
// per-job toggles, blob-authoritative until the jobs domain cutover —
// data-ownership-map §3). Nothing reads these from Postgres yet.
//
// Soft-delete is also deferred: this slice maps users.json `disabled`→is_active
// but does NOT map `archived`→deleted_at (a later slice). So every imported user
// is live (deleted_at NULL) — a later importer must not assume archived users
// were filtered here, and the username collision check above is over live rows.
//
// Validation rules are NOT reinvented — the role/status value-lists come from
// scripts/importers/lib/structure-plan.js (the schema CHECKs). An unknown role
// or status QUARANTINES the record (never guessed/coerced), exactly like the
// dry-run planner.

const { VALID_USER_ROLES, VALID_JOB_STATUSES } = require('./structure-plan');
const { compositeLegacyId } = require('./structure-legacy-id');

function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null;
}
function intOrNull(v) {
  return Number.isFinite(v) ? Math.trunc(v) : null;
}
// sort_order is NOT NULL default 0 — a missing/invalid blob `order` → 0.
function intOrZero(v) {
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}
// A date column wants 'YYYY-MM-DD' or null. Validate CALENDAR validity (not
// just shape) via a UTC round-trip, so a malformed value like '2026-13-45'
// becomes null instead of a date the INSERT would reject and abort on.
function dateOrNull(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const ymd = v.slice(0, 10);
  const d = new Date(ymd + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd ? ymd : null;
}
// created_at is NOT NULL — preserve the blob timestamp when it is a real,
// parseable ISO string, else stamp import time (passed in, so the builder
// stays pure). A malformed timestamp falls back rather than reaching the column.
function tsOrDefault(v, fallbackIso) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))
    ? v
    : fallbackIso;
}

/**
 * @param {object} sources { users: {users:[]}, jobs: {jobs:[]} }
 * @param {object} [options]
 * @param {string} [options.tenantSlug] stable slug → the upsert conflict key
 * @param {string} [options.tenantName]
 * @param {string} [options.nowIso] import-time ISO stamp for created_at fallback
 * @returns {{ tenantRow, userRows, jobRows, quarantine }}
 */
function buildStructureRows(sources, options = {}) {
  const tenantSlug = options.tenantSlug || 'buhl';
  const tenantName = options.tenantName || 'Buhl Electrical';
  const nowIso = options.nowIso || '1970-01-01T00:00:00.000Z';

  const quarantine = [];
  const tenantRow = { slug: tenantSlug, name: tenantName };

  const userRows = [];
  const seenUser = new Set();
  // user_profiles_username_uq is a partial unique index on
  // (tenant_id, lower(username)) where deleted_at is null. Quarantine a
  // case-insensitive username collision rather than let it abort the whole
  // transaction with a raw DB error — keeps every uniqueness invariant on the
  // clean pre-write quarantine path. (Scoped to imported/live rows; this slice
  // never sets deleted_at — archived→deleted_at is deferred, see header.)
  const seenUsername = new Set();
  for (const u of (sources && sources.users && sources.users.users) || []) {
    if (!u || !u.id || !(u.username || u.name)) {
      quarantine.push({ table: 'user_profiles', id: (u && u.id) || '(no id)', reason: 'requires id and username/name' });
      continue;
    }
    if (seenUser.has(u.id)) {
      quarantine.push({ table: 'user_profiles', id: u.id, reason: 'duplicate legacy id' });
      continue;
    }
    if (!VALID_USER_ROLES.includes(u.role)) {
      quarantine.push({ table: 'user_profiles', id: u.id, reason: `role "${u.role}" fails the schema CHECK — needs an explicit normalisation mapping` });
      continue;
    }
    const usernameKey = String(u.username || u.name).trim().toLowerCase();
    if (seenUsername.has(usernameKey)) {
      quarantine.push({ table: 'user_profiles', id: u.id, reason: `duplicate username "${u.username || u.name}" (case-insensitive) — violates user_profiles_username_uq` });
      continue;
    }
    seenUser.add(u.id);
    seenUsername.add(usernameKey);
    userRows.push({
      legacy_user_id: u.id,
      username: u.username || u.name,
      display_name: strOrNull(u.displayName) || strOrNull(u.name),
      email: strOrNull(u.email),
      phone: strOrNull(u.phone),
      role: u.role,
      is_active: u.disabled === true ? false : true,
      created_at: tsOrDefault(u.createdAt, nowIso),
    });
  }

  const jobRows = [];
  const validJobs = []; // blob job objects that passed — only these get groups/areas walked
  const seenJob = new Set();
  for (const j of (sources && sources.jobs && sources.jobs.jobs) || []) {
    if (!j || !j.id || !j.name) {
      quarantine.push({ table: 'jobs', id: (j && j.id) || '(no id)', reason: 'requires id and name' });
      continue;
    }
    if (seenJob.has(j.id)) {
      quarantine.push({ table: 'jobs', id: j.id, reason: 'duplicate legacy id' });
      continue;
    }
    const status = j.status || 'draft';
    if (!VALID_JOB_STATUSES.includes(status)) {
      quarantine.push({ table: 'jobs', id: j.id, reason: `status "${status}" fails the schema CHECK — needs an explicit mapping` });
      continue;
    }
    seenJob.add(j.id);
    validJobs.push(j);
    jobRows.push({
      legacy_id: j.id,
      name: j.name,
      ref: strOrNull(j.ref),
      status,
      job_type_label: strOrNull(j.type),
      external_ref: strOrNull(j.serviceM8JobId),
      site_address: strOrNull(j.siteAddress),
      site_contact_name: strOrNull(j.siteContactName),
      site_contact_phone: strOrNull(j.siteContactPhone),
      access_notes: strOrNull(j.accessNotes),
      parking_notes: strOrNull(j.parkingNotes),
      safety_notes: strOrNull(j.safetyNotes),
      induction_required: boolOrNull(j.inductionRequired),
      start_date: dateOrNull(j.startDate),
      due_date: dateOrNull(j.dueDate),
      programmed_duration_days: intOrNull(j.programmedDurationDays),
      created_at: tsOrDefault(j.createdAt, nowIso),
    });
  }

  // ── site_area_groups → site_areas (J1) ──────────────────────────────────
  // Walk ONLY valid jobs (a quarantined job aborts the whole run before any
  // write, so its place-tree is never imported). Composite legacy_ids are
  // deduped tenant-wide via their own Sets; a collision is a TRUE data error
  // (same blob id twice within a job, incl. a live+archived reuse) → quarantine.
  const groupRows = [];
  const areaRows = [];
  const seenGroupLegacy = new Set();
  const seenAreaLegacy = new Set();
  for (const job of validJobs) {
    for (const group of Array.isArray(job.areaGroups) ? job.areaGroups : []) {
      if (!group || !group.id || !group.name) {
        quarantine.push({ table: 'site_area_groups', id: (group && group.id) || `(job ${job.id})`, reason: 'group requires id and name' });
        continue;
      }
      const groupLegacy = compositeLegacyId(job.id, group.id);
      if (seenGroupLegacy.has(groupLegacy)) {
        quarantine.push({ table: 'site_area_groups', id: groupLegacy, reason: `duplicate group id "${group.id}" within job ${job.id} — composite legacy_id collision (tenant-wide unique)` });
        continue;
      }
      seenGroupLegacy.add(groupLegacy);
      const groupArchived = group.archived === true;
      groupRows.push({
        legacy_id: groupLegacy,
        job_legacy_id: job.id,
        name: group.name,
        sort_order: intOrZero(group.order),
        deleted_at: groupArchived ? nowIso : null,
        deleted_by: null,
        created_at: nowIso,
      });

      for (const area of Array.isArray(group.areas) ? group.areas : []) {
        if (!area || !area.id || !area.name) {
          quarantine.push({ table: 'site_areas', id: (area && area.id) || `(group ${group.id})`, reason: 'area requires id and name' });
          continue;
        }
        const areaLegacy = compositeLegacyId(job.id, area.id);
        if (seenAreaLegacy.has(areaLegacy)) {
          quarantine.push({ table: 'site_areas', id: areaLegacy, reason: `duplicate area id "${area.id}" within job ${job.id} — composite legacy_id collision (tenant-wide unique)` });
          continue;
        }
        seenAreaLegacy.add(areaLegacy);
        const areaArchived = area.archived === true;
        areaRows.push({
          legacy_id: areaLegacy,
          job_legacy_id: job.id,
          group_legacy_id: groupLegacy,
          name: area.name,
          space_type: strOrNull(area.spaceType),
          sort_order: intOrZero(area.order),
          deleted_at: areaArchived ? nowIso : null,
          deleted_by: null,
          created_at: nowIso,
        });
      }
    }
  }

  return { tenantRow, userRows, jobRows, groupRows, areaRows, quarantine };
}

// The mutable columns the upsert overwrites on conflict (everything except the
// identity/legacy key and created_at, which is insert-only). Kept here so the
// importer's SET and the IS-DISTINCT-FROM idempotency guard stay in lock-step.
const USER_MUTABLE_COLS = ['username', 'display_name', 'email', 'phone', 'role', 'is_active'];
const JOB_MUTABLE_COLS = [
  'name', 'ref', 'status', 'job_type_label', 'external_ref', 'site_address',
  'site_contact_name', 'site_contact_phone', 'access_notes', 'parking_notes',
  'safety_notes', 'induction_required', 'start_date', 'due_date',
  'programmed_duration_days',
];
const USER_INSERT_COLS = ['tenant_id', 'legacy_user_id', ...USER_MUTABLE_COLS, 'created_at'];
const JOB_INSERT_COLS = ['tenant_id', 'legacy_id', ...JOB_MUTABLE_COLS, 'created_at'];

// J1 place facets. deleted_at is handled SPECIALLY by the upsert (a CASE that
// preserves an already-set timestamp so re-runs of an archived row don't churn),
// so it is NOT in the plain *_MUTABLE_COLS list — see structure-import.js.
const GROUP_MUTABLE_COLS = ['name', 'sort_order'];
const AREA_MUTABLE_COLS = ['name', 'space_type', 'sort_order', 'group_id'];
const GROUP_INSERT_COLS = ['tenant_id', 'job_id', 'legacy_id', 'name', 'sort_order', 'deleted_at', 'deleted_by', 'created_at'];
const AREA_INSERT_COLS = ['tenant_id', 'job_id', 'group_id', 'legacy_id', 'name', 'space_type', 'sort_order', 'deleted_at', 'deleted_by', 'created_at'];

module.exports = {
  buildStructureRows,
  USER_MUTABLE_COLS,
  JOB_MUTABLE_COLS,
  USER_INSERT_COLS,
  JOB_INSERT_COLS,
  GROUP_MUTABLE_COLS,
  AREA_MUTABLE_COLS,
  GROUP_INSERT_COLS,
  AREA_INSERT_COLS,
};
