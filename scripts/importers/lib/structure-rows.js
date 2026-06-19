// Structure import row builder — PURE. No I/O, no Supabase, no Blob.
//
// Turns the legacy Blob sources (users.json, jobs.json) into the row payloads
// the structure importer upserts, for the FK-root slice of the structure:
//   tenant (one, minted) → user_profiles → jobs.
//
// Deliberately NOT in this slice (each is its own follow-up):
//   * site_area_groups / site_areas / job_members — not needed for the hours
//     FK roots; additive later.
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
// Validation rules are NOT reinvented — the role/status value-lists come from
// scripts/importers/lib/structure-plan.js (the schema CHECKs). An unknown role
// or status QUARANTINES the record (never guessed/coerced), exactly like the
// dry-run planner.

const { VALID_USER_ROLES, VALID_JOB_STATUSES } = require('./structure-plan');

function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null;
}
function intOrNull(v) {
  return Number.isFinite(v) ? Math.trunc(v) : null;
}
// A date column wants 'YYYY-MM-DD' or null — accept an ISO date/datetime prefix.
function dateOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}
// created_at is NOT NULL — preserve the blob timestamp when it is a real ISO
// string, else stamp import time (passed in, so the builder stays pure).
function tsOrDefault(v, fallbackIso) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v : fallbackIso;
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
    seenUser.add(u.id);
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

  return { tenantRow, userRows, jobRows, quarantine };
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

module.exports = {
  buildStructureRows,
  USER_MUTABLE_COLS,
  JOB_MUTABLE_COLS,
  USER_INSERT_COLS,
  JOB_INSERT_COLS,
};
