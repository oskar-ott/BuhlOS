// Hours sync-check engine — PURE. The migration TRUST LAYER (#152): does Blob
// still equal Postgres, INCLUDING per-job allocations? Produces a PASS/FAIL
// report with counts, totals, content hashes and the specific drifts, shaped to
// record into public.sync_checks. (hours-parity.js is the lightweight totals-only
// variant; this is the comprehensive, recorded one.)
//
// Both sides are normalised by the caller to:
//   { userKey, date, totalHours, ordinaryHours, overtimeHours, status,
//     allocations: [{ job_id, hours, notes, sort_order }] }
// Matched on the business key (userKey, date). Allocation sets are compared via
// the shared canonicaliser so a JS number and a numeric(4,2) string agree and a
// notes delimiter can't forge a boundary.

const crypto = require('node:crypto');
const { canonicaliseAllocations } = require('../../../api/_lib/alloc-pg');

const TOLERANCE = 0.011; // matches the schema CHECK
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Normalise a Blob or reconstructed-PG entry to the comparison shape. CRITICAL:
 * the allocation rules must match how alloc-pg.buildAllocationRows WROTE the PG
 * rows, or the check cries drift on genuinely-synced data — notes via strOrNull
 * (whitespace → null) and sort_order falling back to the array index when the
 * blob allocation has no sortOrder. Used for BOTH sides (PG values are already
 * clean, so this is a no-op there). Accepts blob (jobId/sortOrder) and the
 * reconstructed-PG (also jobId/sortOrder) allocation shapes.
 */
function normaliseEntry(userKey, date, e) {
  const src = e || {};
  return {
    userKey,
    date,
    totalHours: src.totalHours,
    ordinaryHours: src.ordinaryHours,
    overtimeHours: src.overtimeHours,
    status: src.status || 'draft',
    allocations: (Array.isArray(src.allocations) ? src.allocations : []).map((a, i) => ({
      job_id: (a && a.jobId) ?? null,
      hours: a && a.hours,
      notes: strOrNull(a && a.notes),
      sort_order: Number.isFinite(a && a.sortOrder) ? Math.trunc(a.sortOrder) : i,
    })),
  };
}
function hoursDiffer(a, b) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) >= TOLERANCE;
}
function keyOf(e) {
  return `${e && e.userKey}|${e && e.date}`;
}
// Canonical per-entry tuple — the unit of both comparison and the dataset hash.
function entryTuple(e) {
  return [
    e.userKey,
    e.date,
    round2(e.totalHours),
    round2(e.ordinaryHours),
    round2(e.overtimeHours),
    e.status || 'draft',
    canonicaliseAllocations(e.allocations || []),
  ];
}
function datasetHash(entries) {
  const tuples = (entries || []).map(entryTuple).sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`));
  return crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
}
function sumTotal(entries) {
  return round2((entries || []).reduce((s, e) => s + (Number(e.totalHours) || 0), 0));
}

/**
 * @param {{ blobEntries?: Array<object>, pgEntries?: Array<object> }} input
 * @returns a record-shaped report: status, counts, totals, hashes, details.
 */
function buildHoursSyncReport({ blobEntries = [], pgEntries = [] } = {}) {
  const blobByKey = new Map();
  for (const e of blobEntries) blobByKey.set(keyOf(e), e);
  const pgByKey = new Map();
  for (const e of pgEntries) pgByKey.set(keyOf(e), e);

  const onlyInBlob = [];
  const onlyInPg = [];
  const mismatched = [];
  let matched = 0;

  for (const [k, b] of blobByKey) {
    const p = pgByKey.get(k);
    if (!p) {
      onlyInBlob.push(k);
      continue;
    }
    const diffs = {};
    if (hoursDiffer(b.totalHours, p.totalHours)) diffs.totalHours = { blob: round2(b.totalHours), pg: round2(p.totalHours) };
    if (hoursDiffer(b.ordinaryHours, p.ordinaryHours)) diffs.ordinaryHours = { blob: round2(b.ordinaryHours), pg: round2(p.ordinaryHours) };
    if (hoursDiffer(b.overtimeHours, p.overtimeHours)) diffs.overtimeHours = { blob: round2(b.overtimeHours), pg: round2(p.overtimeHours) };
    if ((b.status || 'draft') !== (p.status || 'draft')) diffs.status = { blob: b.status || null, pg: p.status || null };
    const ba = canonicaliseAllocations(b.allocations || []);
    const pa = canonicaliseAllocations(p.allocations || []);
    if (ba !== pa) diffs.allocations = { blob: ba, pg: pa };
    if (Object.keys(diffs).length) mismatched.push({ key: k, diffs });
    else matched += 1;
  }
  for (const k of pgByKey.keys()) if (!blobByKey.has(k)) onlyInPg.push(k);

  const blobHash = datasetHash(blobEntries);
  const pgHash = datasetHash(pgEntries);
  const inSync = onlyInBlob.length === 0 && onlyInPg.length === 0 && mismatched.length === 0;

  return {
    status: inSync ? 'pass' : 'fail',
    blobCount: blobEntries.length,
    pgCount: pgEntries.length,
    blobTotal: sumTotal(blobEntries),
    pgTotal: sumTotal(pgEntries),
    allocationsChecked: true,
    matched,
    onlyInBlobCount: onlyInBlob.length,
    onlyInPgCount: onlyInPg.length,
    mismatchedCount: mismatched.length,
    blobHash,
    pgHash,
    // hashMatch is an independent cross-check of inSync (same inputs → same hash).
    details: {
      hashMatch: blobHash === pgHash,
      onlyInBlob: onlyInBlob.slice(0, 100),
      onlyInPg: onlyInPg.slice(0, 100),
      mismatched: mismatched.slice(0, 100),
    },
  };
}

module.exports = { buildHoursSyncReport, normaliseEntry };
