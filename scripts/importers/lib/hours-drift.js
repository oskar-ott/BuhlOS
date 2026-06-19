// Hours Blob↔Postgres drift check — PURE. No I/O, no Supabase, no Blob.
//
// Why this exists: the hours dual-write pilot (#152) on the single seam
// api/_lib/time-entries.js has one non-negotiable acceptance criterion
// (migration roadmap, P7): an HONEST drift alarm — "did the Postgres mirror
// actually match the Blob source of truth?". This module is that alarm's
// engine, built read-only and AHEAD of the first writer so it can be trusted
// before anything writes. It also powers the read-only hours proving slice:
// run it against an empty dev Postgres and it honestly reports "Postgres is
// behind by everything" — it never pretends parity it cannot see (P7).
//
// Source of truth = Vercel Blob (users/<id>/time-entries/<date>.json), one
// entry per user per day. Mirror = Postgres public.time_entries. The two sides
// are matched on the BUSINESS key (userKey, work_date) — NOT on a surrogate
// uuid: Blob keys on the legacy user id, Postgres on a minted uuid, so the
// caller resolves each Postgres row back to its legacy user id (via
// user_profiles.legacy_user_id) BEFORE handing rows here. Matching on legacy_id
// alone would miss pre-id legacy entries; (userKey, date) is the one key both
// stores share.
//
// Caller normalises each side to records of:
//   { userKey, date, totalHours, ordinaryHours, overtimeHours, status,
//     entryLegacyId? }
// userKey: legacy user id (string); date: 'YYYY-MM-DD'; hours: numbers;
// status: one of draft|submitted|approved|rejected.

// Hours agree within the same tolerance the schema CHECK uses
// (abs((ordinary+overtime)-total) < 0.011), so numeric(4,2) rounding on the
// Postgres side never reads as drift.
const HOURS_TOLERANCE = 0.011;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function keyOf(rec) {
  return `${rec && rec.userKey}|${rec && rec.date}`;
}

function hoursDiffer(a, b) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) >= HOURS_TOLERANCE;
}

// Index records by business key; collect duplicates defensively. The Blob path
// (one file per user+day) and the Postgres unique index
// (tenant_id,user_id,work_date) should each guarantee uniqueness, so a
// duplicate here is itself a drift signal worth surfacing, never silently
// collapsing.
function indexByKey(records) {
  const map = new Map();
  const duplicates = [];
  for (const r of records) {
    const k = keyOf(r);
    if (map.has(k)) duplicates.push({ key: k, record: r });
    else map.set(k, r);
  }
  return { map, duplicates };
}

function sumTotalHours(records) {
  return round2(records.reduce((s, r) => s + (Number(r && r.totalHours) || 0), 0));
}

/**
 * Compare a Blob snapshot of hours against a Postgres snapshot and report the
 * drift. Pure and deterministic — the same two inputs always give the same
 * report.
 *
 * @param {{ blobEntries?: Array<object>, pgEntries?: Array<object> }} input
 * @returns {{
 *   onlyInBlob: Array<object>,   // in Blob, missing in Postgres (mirror behind)
 *   onlyInPg: Array<object>,     // in Postgres, missing in Blob (orphan / deleted in Blob)
 *   mismatched: Array<object>,   // same key, field values disagree
 *   duplicateBlobKeys: Array<object>,
 *   duplicatePgKeys: Array<object>,
 *   summary: object,
 * }}
 */
function buildHoursDriftReport({ blobEntries = [], pgEntries = [] } = {}) {
  const blob = indexByKey(blobEntries);
  const pg = indexByKey(pgEntries);

  const onlyInBlob = [];
  const onlyInPg = [];
  const mismatched = [];
  let matchedCount = 0;

  for (const [k, b] of blob.map) {
    const p = pg.map.get(k);
    if (!p) {
      onlyInBlob.push(b);
      continue;
    }
    const diffs = {};
    if (hoursDiffer(b.totalHours, p.totalHours)) {
      diffs.totalHours = { blob: round2(b.totalHours), pg: round2(p.totalHours) };
    }
    if (hoursDiffer(b.ordinaryHours, p.ordinaryHours)) {
      diffs.ordinaryHours = { blob: round2(b.ordinaryHours), pg: round2(p.ordinaryHours) };
    }
    if (hoursDiffer(b.overtimeHours, p.overtimeHours)) {
      diffs.overtimeHours = { blob: round2(b.overtimeHours), pg: round2(p.overtimeHours) };
    }
    if ((b.status || null) !== (p.status || null)) {
      diffs.status = { blob: b.status || null, pg: p.status || null };
    }
    if (Object.keys(diffs).length) {
      mismatched.push({ key: k, userKey: b.userKey, date: b.date, diffs });
    } else {
      matchedCount += 1;
    }
  }

  for (const [k, p] of pg.map) {
    if (!blob.map.has(k)) onlyInPg.push(p);
  }

  const blobTotalHours = sumTotalHours(blobEntries);
  const pgTotalHours = sumTotalHours(pgEntries);

  const summary = {
    blobCount: blobEntries.length,
    pgCount: pgEntries.length,
    matchedCount,
    onlyInBlobCount: onlyInBlob.length,
    onlyInPgCount: onlyInPg.length,
    mismatchedCount: mismatched.length,
    duplicateBlobKeys: blob.duplicates.length,
    duplicatePgKeys: pg.duplicates.length,
    blobTotalHours,
    pgTotalHours,
    // positive = Blob ahead (Postgres behind); negative = Postgres ahead.
    driftHours: round2(blobTotalHours - pgTotalHours),
    inSync:
      onlyInBlob.length === 0 &&
      onlyInPg.length === 0 &&
      mismatched.length === 0 &&
      blob.duplicates.length === 0 &&
      pg.duplicates.length === 0,
  };

  return {
    onlyInBlob,
    onlyInPg,
    mismatched,
    duplicateBlobKeys: blob.duplicates,
    duplicatePgKeys: pg.duplicates,
    summary,
  };
}

module.exports = { buildHoursDriftReport, HOURS_TOLERANCE };
