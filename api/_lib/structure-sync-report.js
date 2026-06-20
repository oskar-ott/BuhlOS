// Structure sync-check engine — PURE. The jobs/tasks migration TRUST LAYER (J1+J2):
// does Blob still equal Postgres for the place structure (jobs + site_area_groups
// + site_areas) and the task PLAN (job_task_templates)? Produces a PASS/FAIL report
// with per-section counts, content hashes and the specific drifts, shaped to record
// into public.sync_checks (domain 'structure'). Modelled on
// api/_lib/hours-sync-report.js (#152) — same per-side sha256 dataset hash +
// business-key matching + capped detail lists.
//
// Both sides are normalised by the CALLER (scripts/importers/structure-sync-check.js)
// to a section shape:
//   { jobs: [entity], groups: [entity], areas: [entity], templates: [entity], unmappable: [string] }
// where each entity is { key, ...stableFields } — the key is the business key
// (job legacy_id for jobs; the JOB-SCOPED composite legacy_id for groups/areas;
// the [job, area|null, stage, legacy_id] partial-index tuple for templates). The
// caller compares only the BLOB-MIRRORED SEMANTIC fields (identity + name +
// sort_order + space_type/group_id + the archive STATE). DELIBERATELY EXCLUDED, so
// they can never manufacture false drift:
//   * write-once / metadata the importer sets but that carry no blob meaning —
//     uuid id, tenant_id, revision, created_at/updated_at, the deleted_at TIMESTAMP
//     (the `deleted` boolean is compared instead, so the proxy timestamp can't
//     churn), and deleted_by (always NULL — there is no system actor);
//   * PG-OWNED template capabilities the importer NEVER writes
//     (required_photo_count/requires_note/is_active/description) — comparing these
//     would FAIL the moment an admin authors an evidence requirement.

const crypto = require('node:crypto');

const SECTIONS = ['jobs', 'groups', 'areas', 'templates'];

// Canonical, deterministic serialisation of one entity: keys sorted so field
// order can't forge a diff; null-normalised (undefined would be dropped by
// JSON.stringify and could mismatch a null on the other side).
function canon(entity) {
  const src = entity || {};
  const out = {};
  for (const k of Object.keys(src).sort()) out[k] = src[k] === undefined ? null : src[k];
  return JSON.stringify(out);
}

// sha256 over the sorted array of canonical tuples (order-independent), exactly
// like hours-sync-report.datasetHash.
function datasetHash(entities) {
  const tuples = (entities || []).map(canon).sort();
  return crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
}

function countDeleted(entities) {
  return (entities || []).filter((e) => e && e.deleted === true).length;
}

// Compare one section by business key; mismatched = same key, different tuple.
function compareSection(blobArr = [], pgArr = []) {
  const bByKey = new Map();
  for (const e of blobArr) bByKey.set(e.key, e);
  const pByKey = new Map();
  for (const e of pgArr) pByKey.set(e.key, e);

  const onlyInBlob = [];
  const onlyInPg = [];
  const mismatched = [];
  let matched = 0;

  for (const [k, b] of bByKey) {
    const p = pByKey.get(k);
    if (!p) {
      onlyInBlob.push(k);
      continue;
    }
    if (canon(b) !== canon(p)) mismatched.push({ key: k, blob: b, pg: p });
    else matched += 1;
  }
  for (const k of pByKey.keys()) if (!bByKey.has(k)) onlyInPg.push(k);

  return {
    blobCount: blobArr.length,
    pgCount: pgArr.length,
    matched,
    onlyInBlobCount: onlyInBlob.length,
    onlyInPgCount: onlyInPg.length,
    mismatchedCount: mismatched.length,
    blobHash: datasetHash(blobArr),
    pgHash: datasetHash(pgArr),
    _detail: { onlyInBlob, onlyInPg, mismatched },
  };
}

/**
 * @param {{ blob: object, pg: object }} input section-shaped projections
 * @returns a record-shaped report (aggregate scalars + per-section detail).
 */
function buildStructureSyncReport({ blob = {}, pg = {} } = {}) {
  const sections = {};
  for (const s of SECTIONS) sections[s] = compareSection(blob[s], pg[s]);

  const unmappable = Array.isArray(blob.unmappable) ? blob.unmappable : [];

  const sum = (f) => SECTIONS.reduce((n, s) => n + sections[s][f], 0);
  const blobCount = sum('blobCount');
  const pgCount = sum('pgCount');
  const matched = sum('matched');
  const onlyInBlobCount = sum('onlyInBlobCount');
  const onlyInPgCount = sum('onlyInPgCount');
  const mismatchedCount = sum('mismatchedCount');
  const unmappableCount = unmappable.length;

  const blobDeleted = SECTIONS.reduce((n, s) => n + countDeleted(blob[s]), 0);
  const pgDeleted = SECTIONS.reduce((n, s) => n + countDeleted(pg[s]), 0);

  // Combined hash = sha256 over each section's per-side hash, in fixed section
  // order. An independent cross-check of the per-key verdict (same as hours).
  const blobHash = crypto.createHash('sha256').update(SECTIONS.map((s) => sections[s].blobHash).join('|')).digest('hex');
  const pgHash = crypto.createHash('sha256').update(SECTIONS.map((s) => sections[s].pgHash).join('|')).digest('hex');

  const inSync =
    onlyInBlobCount === 0 && onlyInPgCount === 0 && mismatchedCount === 0 && unmappableCount === 0;

  const sectionSummary = {};
  for (const s of SECTIONS) {
    const c = sections[s];
    sectionSummary[s] = {
      blobCount: c.blobCount, pgCount: c.pgCount, matched: c.matched,
      onlyInBlobCount: c.onlyInBlobCount, onlyInPgCount: c.onlyInPgCount,
      mismatchedCount: c.mismatchedCount,
      blobHash: c.blobHash, pgHash: c.pgHash,
      hashMatch: c.blobHash === c.pgHash,
      onlyInBlob: c._detail.onlyInBlob.slice(0, 100),
      onlyInPg: c._detail.onlyInPg.slice(0, 100),
      mismatched: c._detail.mismatched.slice(0, 100),
    };
  }

  return {
    status: inSync ? 'pass' : 'fail',
    blobCount,
    pgCount,
    blobDeleted,
    pgDeleted,
    matched,
    onlyInBlobCount,
    onlyInPgCount,
    mismatchedCount,
    unmappableCount,
    blobHash,
    pgHash,
    details: {
      hashMatch: blobHash === pgHash,
      sections: sectionSummary,
      unmappable: unmappable.slice(0, 100),
    },
  };
}

module.exports = { buildStructureSyncReport, datasetHash, SECTIONS };
