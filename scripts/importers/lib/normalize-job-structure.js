// J8.75 — legacy job structure NORMALIZER (pure). Canonicalises a Blob job's
// *representation* so the J6/J7 read overlays serve it from Postgres, WITHOUT
// changing its data.
//
// Why this is needed (J8.5 finding): the read overlays use an order-sensitive,
// byte-identical parity gate. Legacy jobs are data-equivalent to PG (the
// structure sync-check is IN SYNC) but representation-drifted:
//   * header strings stored as "" where the importer/reconstruction use null;
//   * sparse area/group/template records missing the canonical defaults
//     (order:0, archived:false, spaceType:null, roughInTasks:[], fitOffTasks:[]);
//   * arrays not in the reconstruction's (sort_order, legacy_id) order.
// So they conservatively fall back to Blob. This canonicalises them once.
//
// SAFE BY CONSTRUCTION. The canonical structure is taken from the PG
// reconstruction (which is the blob's OWN data, imported then reconstructed —
// in-sync), overlaid onto the Blob spine so every Blob-only field is preserved.
// Three guards must ALL pass or the job is left untouched (Blob-served, safe):
//   (1) byte-faithful: the result hashes equal to the PG reconstruction → the
//       read overlay will serve it from PG (the whole point);
//   (2) data unchanged: the importer-projection of the result equals that of the
//       original blob → no migrated value changed (catches a job whose data
//       genuinely drifted from PG since import — never overwrite real data);
//   (3) no field dropped: the blob's structural objects use only canonical keys →
//       a job carrying nested Blob-only fields (e.g. area customFields,
//       archivedAt/By) is skipped rather than have them dropped.

const crypto = require('node:crypto');
const { buildStructureRows } = require('./structure-rows');
const { migratedFieldsHash, MIGRATED_JOB_FIELDS } = require('../../../api/_lib/job-read-projection');

// Pick the migrated fields the PG reconstruction owns (header scalars + the
// canonical areaGroups/roughInTasks/fitOffTasks). Adopting these from PG is the
// canonicalisation; every other (Blob-only) field is preserved by the caller's spread.
function pickMigrated(job) {
  const out = {};
  for (const f of MIGRATED_JOB_FIELDS) if (job[f] !== undefined) out[f] = job[f];
  return out;
}

// The exact key sets the PG reconstruction (reconstructFromPg) produces. A blob
// structural object using any other key would lose that key if we adopted the
// canonical shape → guard (3) skips the job instead.
const GROUP_KEYS = new Set(['id', 'name', 'order', 'archived', 'areas']);
const AREA_KEYS = new Set(['id', 'name', 'spaceType', 'order', 'archived', 'roughInTasks', 'fitOffTasks']);
const TEMPLATE_KEYS = new Set(['id', 'name', 'order', 'archived']);

function extra(obj, allowed) {
  return Object.keys(obj || {}).filter((k) => !allowed.has(k));
}

// Guard (3): keys in the blob's groups/areas/templates that are NOT canonical
// (adopting the canonical shape would drop them → unsafe to normalize).
function droppedStructuralKeys(job) {
  const out = new Set();
  for (const g of job.areaGroups || []) {
    extra(g, GROUP_KEYS).forEach((k) => out.add('group.' + k));
    for (const a of g.areas || []) {
      extra(a, AREA_KEYS).forEach((k) => out.add('area.' + k));
      for (const t of a.roughInTasks || []) extra(t, TEMPLATE_KEYS).forEach((k) => out.add('areaTemplate.' + k));
      for (const t of a.fitOffTasks || []) extra(t, TEMPLATE_KEYS).forEach((k) => out.add('areaTemplate.' + k));
    }
  }
  for (const t of job.roughInTasks || []) extra(t, TEMPLATE_KEYS).forEach((k) => out.add('jobTemplate.' + k));
  for (const t of job.fitOffTasks || []) extra(t, TEMPLATE_KEYS).forEach((k) => out.add('jobTemplate.' + k));
  return [...out];
}

// Guard (2): an order-independent fingerprint of the MIGRATED data (what the
// importer would write to PG). Two jobs with the same fingerprint carry the same
// migrated data regardless of representation (order / sparse fields / "" vs null).
const FIXED_NOW = '2000-01-01T00:00:00.000Z';
function migratedDataFingerprint(job) {
  const r = buildStructureRows({ users: { users: [] }, jobs: { jobs: [job] } }, { nowIso: FIXED_NOW });
  if (r.quarantine && r.quarantine.length) return null; // can't project → treat as not-equivalent
  const jr = (r.jobRows[0]) || {};
  const jobSemantic = {
    name: jr.name ?? null, status: jr.status ?? null, ref: jr.ref ?? null,
    job_type_label: jr.job_type_label ?? null, external_ref: jr.external_ref ?? null,
    site_address: jr.site_address ?? null, site_contact_name: jr.site_contact_name ?? null,
    site_contact_phone: jr.site_contact_phone ?? null, access_notes: jr.access_notes ?? null,
    parking_notes: jr.parking_notes ?? null, safety_notes: jr.safety_notes ?? null,
    induction_required: jr.induction_required ?? null, start_date: jr.start_date ?? null,
    due_date: jr.due_date ?? null, programmed_duration_days: jr.programmed_duration_days ?? null,
  };
  const arch = (row) => row.deleted_at != null;
  const groups = (r.groupRows || []).map((g) => ({ legacy_id: g.legacy_id, name: g.name, sort_order: g.sort_order, archived: arch(g) }));
  const areas = (r.areaRows || []).map((a) => ({ legacy_id: a.legacy_id, group_legacy_id: a.group_legacy_id ?? null, name: a.name, space_type: a.space_type ?? null, sort_order: a.sort_order, archived: arch(a) }));
  const templates = (r.templateRows || []).map((t) => ({ legacy_id: t.legacy_id, site_area_legacy_id: t.site_area_legacy_id ?? null, stage: t.stage, name: t.name, sort_order: t.sort_order, archived: arch(t) }));
  const sortKey = (x) => JSON.stringify([x.legacy_id, x.site_area_legacy_id, x.group_legacy_id, x.stage]);
  const canon = { job: jobSemantic, groups: groups.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)), areas: areas.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)), templates: templates.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)) };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/**
 * Normalise ONE blob job's representation to the canonical (PG-reconstruction)
 * shape, safely. PURE. Returns { job, normalized, reason }:
 *   - normalized:false + the ORIGINAL job when already faithful or any guard fails;
 *   - normalized:true + the canonicalised job when all guards pass.
 * @param {object} blobJob   the job as it lives in jobs.json
 * @param {object} pgReconJob the SAME job reconstructed from Postgres (reconstructFromPg)
 */
function normalizeJobStructure(blobJob, pgReconJob) {
  if (!blobJob) return { job: blobJob, normalized: false, reason: 'no blob job' };
  if (!pgReconJob) return { job: blobJob, normalized: false, reason: 'no pg reconstruction (job not in PG)' };
  if (migratedFieldsHash(blobJob) === migratedFieldsHash(pgReconJob)) {
    return { job: blobJob, normalized: false, reason: 'already faithful' };
  }
  const dropped = droppedStructuralKeys(blobJob);
  if (dropped.length) return { job: blobJob, normalized: false, reason: 'skipped — would drop blob-only fields: ' + dropped.join(', ') };

  // Adopt PG's canonical migrated fields onto the Blob spine; every Blob-only
  // field (modules/customFields/scopeOfWork/clientUserId/createdAt/…) is preserved.
  const candidate = { ...blobJob, ...pickMigrated(pgReconJob) };

  // Guard (1) — byte-faithful (true by construction; assert it so a future change
  // to MIGRATED_JOB_FIELDS can't silently produce a still-drifted result).
  if (migratedFieldsHash(candidate) !== migratedFieldsHash(pgReconJob)) {
    return { job: blobJob, normalized: false, reason: 'skipped — not byte-faithful after normalize (unexpected)' };
  }
  // Guard (2) — migrated DATA unchanged: catches a job whose data genuinely drifted
  // from PG since import (never overwrite real data with a stale mirror), and any
  // scalar that would be lost by adopting PG's value.
  const fp = migratedDataFingerprint(blobJob);
  if (fp === null || fp !== migratedDataFingerprint(candidate)) {
    return { job: blobJob, normalized: false, reason: 'skipped — migrated data differs from PG (real drift, not representational)' };
  }
  return { job: candidate, normalized: true, reason: 'normalized' };
}

module.exports = { normalizeJobStructure, droppedStructuralKeys, migratedDataFingerprint, GROUP_KEYS, AREA_KEYS, TEMPLATE_KEYS };
