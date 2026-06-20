// Composite legacy-id minting for site_area_groups / site_areas (J1).
//
// WHY: blob group/area ids (e.g. "apt_001") are per-job-LOCAL — the app's
// area-id uniqueness invariant (api/_lib/validation.js findDuplicateLiveAreaId)
// is per-job + live-only. But the Postgres uniqueness index is TENANT-WIDE
// (site_areas_legacy_uq / site_area_groups_legacy_uq on (tenant_id, legacy_id)).
// So two jobs reusing "apt_001" would collide tenant-wide if the raw blob id were
// used as legacy_id. J0 (docs/audits/jobs-tasks-supabase-j0-audit.md, blocker #1)
// decided: mint a JOB-SCOPED composite legacy_id.
//
// Encoding is a JSON 2-tuple, NOT a "jobId::blobId" string — a delimiter string
// can be FORGED (job "a::b" + area "c" vs job "a" + area "b::c" both → "a::b::c").
// JSON.stringify of a fixed-shape 2-string array is deterministic and
// collision-proof (this is the same lesson the hours allocation canonicaliser
// learned — see api/_lib/alloc-pg.js). Jobs themselves keep their RAW id as
// legacy_id (job ids are already tenant-unique); only groups/areas are scoped.
//
// PURE. No I/O. Used by BOTH the row builder (writes legacy_id) and the structure
// sync-check (reconstructs the same key), so the two sides agree by construction.

/**
 * @param {string} jobLegacyId the job's tenant-unique legacy id (raw blob job id)
 * @param {string} localId     the per-job-local blob group/area id
 * @returns {string} a deterministic, tenant-unique, delimiter-safe legacy id
 */
function compositeLegacyId(jobLegacyId, localId) {
  return JSON.stringify([String(jobLegacyId), String(localId)]);
}

/**
 * Inverse of compositeLegacyId — recover the original [jobLegacyId, localId] from a
 * composite. Used by the J5 read projection to reconstruct the per-job-local blob
 * id (group/area) from a tenant-wide composite legacy_id. Returns null if the
 * value is not a well-formed composite (so a raw legacy_id can be told apart).
 */
function decomposeLegacyId(composite) {
  if (typeof composite !== 'string') return null;
  try {
    const parsed = JSON.parse(composite);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((x) => typeof x === 'string')) {
      return { jobLegacyId: parsed[0], localId: parsed[1] };
    }
  } catch {
    // not JSON → not a composite
  }
  return null;
}

module.exports = { compositeLegacyId, decomposeLegacyId };
