'use strict';

// Hours mirror REPAIR sweep (#152 trust layer) — makes the Postgres copy of the
// hours equal the Blob truth again after a live mirror write was lost.
//
// Why it exists (production, 2026-10-11): the daily hours sync-check had failed
// every day since mid-September — 67 approved days still "submitted" in PG and a
// split day with no allocations. The live mirror is best-effort and one-shot: in
// the app's own error journal, 17 approvals "timed out after 12000ms" and two
// split days hit a job that wasn't in PG yet ("not imported"); nothing ever
// retried them. The sync-check reports drift by design and never repairs; the
// jobs mirror already has a reconcile sweep (jobs-reconcile.js) — hours had none.
//
// What it does, per run:
//   1. snapshot every hours day-file from Blob (raw body + uploadedAt) and the
//      whole PG copy, and diff them with the SAME report the sync-check records;
//   2. re-mirror each mismatched / Blob-only day through the LIVE mirror write
//      (mirrorTimeEntry — same row builder, same allocation reconcile), and
//      soft-delete each PG-only day through the live delete mirror.
//
// Safety (Blob is authoritative; this only ever moves PG TOWARD Blob):
//   * SETTLING — a day whose blob was uploaded within SETTLE_MS is skipped: its
//     CDN copy may still be the pre-save version, and writing that over a fresh
//     PG row would move PG AWAY from the truth. The next run picks it up.
//   * UNREADABLE — a listed day whose body couldn't be fetched is unknown, never
//     "absent": it is never repaired and never counted as PG-only.
//   * DELETE BREAKER — more than MAX_DELETES PG-only days in one run means the
//     listing itself is suspect; the run deletes NOTHING and reports it.
//   * CAP — at most MAX_REPAIRS (40) writes per run, inside the 60 s budget; the rest wait for the next run.
//   * DRY RUN — `apply: false` writes nothing; it returns the plan.

const { buildHoursSyncReport, normaliseEntry } = require('./hours-sync-report');
const { loadAllHoursFromPg } = require('./hours-read');
const { loadBlobHoursSnapshot } = require('./hours-sync');
const { mirrorTimeEntry, mirrorTimeEntryDelete } = require('./hours-mirror');

const SETTLE_MS = 5 * 60 * 1000;
const MAX_REPAIRS = 40; // sequential live-mirror writes inside the 60 s function budget
const MAX_DELETES = 5;
const REPAIR_TIMEOUT_MS = 20000;

function splitKey(key) {
  const i = key.lastIndexOf('|');
  return { userId: key.slice(0, i), date: key.slice(i + 1) };
}

/**
 * @param {any} sql   Postgres.js client (caller-owned; the route reuses the warm singleton)
 * @param {{ apply?: boolean, deps?: object, now?: number }} [options]
 * @returns {Promise<object>} plan + outcome summary (never throws for a per-day failure)
 */
async function repairHoursMirror(sql, { apply = false, deps = {}, now = Date.now() } = {}) {
  const {
    loadBlob = loadBlobHoursSnapshot,
    loadPg = loadAllHoursFromPg,
    buildReport = buildHoursSyncReport,
    normalise = normaliseEntry,
    mirror = (userId, entry) => mirrorTimeEntry(userId, entry, { timeoutMs: REPAIR_TIMEOUT_MS }),
    mirrorDelete = (userId, date) => mirrorTimeEntryDelete(userId, date, { timeoutMs: REPAIR_TIMEOUT_MS }),
  } = deps;

  const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!tenant.length) throw new Error('no tenant (slug "buhl")');
  const tenantId = tenant[0].id;

  const [snap, pgRaw] = await Promise.all([loadBlob(), loadPg(sql, tenantId)]);
  const pgEntries = pgRaw.map((e) => normalise(e.userId, e.date, e));
  const report = buildReport({ blobEntries: snap.entries, pgEntries });
  const unreadable = new Set(snap.unreadable || []);
  const listed = new Set(snap.listedKeys || []);

  const settling = [];
  const toWrite = [];
  for (const key of [...report.keys.mismatched, ...report.keys.onlyInBlob]) {
    const day = snap.byKey.get(key);
    if (!day) continue; // unreadable — never repaired
    const up = day.uploadedAt ? Date.parse(day.uploadedAt) : NaN;
    if (Number.isFinite(up) && now - up < SETTLE_MS) {
      settling.push(key);
      continue;
    }
    toWrite.push(key);
  }
  // PG-only = listed nowhere in Blob AND not merely unreadable.
  const toDelete = report.keys.onlyInPg.filter((k) => !unreadable.has(k) && !listed.has(k));
  const deleteBreaker = toDelete.length > MAX_DELETES;

  const plan = {
    status: report.status,
    blobCount: report.blobCount,
    pgCount: report.pgCount,
    mismatched: report.keys.mismatched.length,
    onlyInBlob: report.keys.onlyInBlob.length,
    onlyInPg: report.keys.onlyInPg.length,
    unreadable: unreadable.size,
    settling: settling.length,
    toWrite: toWrite.length,
    toDelete: deleteBreaker ? 0 : toDelete.length,
    deleteBreaker,
    deleteCandidates: toDelete.length,
    capped: toWrite.length > MAX_REPAIRS,
    apply,
  };
  if (!apply) {
    return { ...plan, keys: { write: toWrite.slice(0, 200), delete: toDelete.slice(0, 50), settling } };
  }

  let repaired = 0;
  const failed = [];
  for (const key of toWrite.slice(0, MAX_REPAIRS)) {
    const day = snap.byKey.get(key);
    const out = await mirror(day.userId, day.raw);
    if (out && out.mirrored) repaired += 1;
    else failed.push({ key, reason: (out && (out.error || out.reason)) || 'unknown' });
  }
  let deleted = 0;
  if (!deleteBreaker) {
    for (const key of toDelete) {
      const { userId, date } = splitKey(key);
      const out = await mirrorDelete(userId, date);
      if (out && out.mirrored) deleted += 1;
      else failed.push({ key, reason: (out && (out.error || out.reason)) || 'unknown', delete: true });
    }
  }
  return { ...plan, repaired, deleted, failed: failed.slice(0, 50), failedCount: failed.length };
}

module.exports = { repairHoursMirror, SETTLE_MS, MAX_REPAIRS, MAX_DELETES };
