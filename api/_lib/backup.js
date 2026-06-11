// Blob backup core — snapshot, retention, restore (#151).
//
// Why this exists: every canonical store is a mutable whole-document JSON
// blob overwritten in place on every write. Vercel Blob durability protects
// against infrastructure loss, not against US — one buggy handler or bad
// import clobbers users.json and there is no way back. This module gives the
// business a daily, immutable, pruned snapshot set and a tested restore path.
//
// Snapshot scheme:   backups/<yyyy-mm-dd>/<original-path>
// Pre-restore copy:  backups/pre-restore-<iso-ts>/<original-path>
// Retention:         newest KEEP_DAILY dates + Monday dates within
//                    KEEP_WEEKLY_DAYS (so ~8 weekly anchors), pruned by the
//                    same cron that snapshots.
//
// Freshness: snapshots copy straight from the blob listing (list → copy),
// never through api/_lib/blob.js's 5s read cache — fresh by construction.
// Restores write through writeBlob so the canonical put options and the
// same-instance cache stay consistent; cross-instance staleness after a
// restore is bounded by the documented 5s TTL.

const { list, copy, del } = require('@vercel/blob');
const { writeBlob } = require('./blob');
const {
  EXACT_STORES,
  PREFIX_STORES,
  BACKUP_PREFIX,
  isSnapshotTarget,
} = require('./backup-manifest');

const KEEP_DAILY = 14;
const KEEP_WEEKLY_DAYS = 56; // Mondays within 8 weeks
const COPY_CONCURRENCY = 8;
const DEL_CHUNK = 100;

function token() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

/** yyyy-mm-dd in the business day (UTC date — snapshots are anchors, not ledgers). */
function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Paginate a full listing under one prefix. */
async function listAll(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, token: token(), limit: 1000, cursor });
    out.push(...(page.blobs || []));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function mapConcurrent(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Enumerate every snapshot-target blob across the manifest (deduped).
 * Exact stores are listed by their own key as a prefix; prefix stores are
 * walked with pagination. Non-JSON and backups/ paths are excluded.
 */
async function enumerateTargets() {
  const seen = new Map(); // pathname → url
  for (const prefix of [...EXACT_STORES, ...PREFIX_STORES]) {
    const blobs = await listAll(prefix);
    for (const b of blobs) {
      if (!isSnapshotTarget(b.pathname)) continue;
      if (!seen.has(b.pathname)) seen.set(b.pathname, b.url);
    }
  }
  return [...seen.entries()].map(([pathname, url]) => ({ pathname, url }));
}

/**
 * Copy every canonical JSON document to backups/<date>/<path>. Never throws —
 * per-document failures are collected so one bad copy doesn't lose the run.
 */
async function runSnapshot({ date = todayStamp() } = {}) {
  const startedAt = Date.now();
  const targets = await enumerateTargets();
  const failed = [];
  let copied = 0;

  await mapConcurrent(targets, COPY_CONCURRENCY, async (t) => {
    try {
      await copy(t.url, `${BACKUP_PREFIX}${date}/${t.pathname}`, {
        access: 'public',
        token: token(),
        addRandomSuffix: false,
      });
      copied += 1;
    } catch (e) {
      failed.push({ pathname: t.pathname, error: (e && e.message) || 'copy failed' });
    }
  });

  return {
    date,
    targets: targets.length,
    copied,
    failed,
    durationMs: Date.now() - startedAt,
  };
}

/** ISO yyyy-mm-dd → is it a Monday (UTC)? */
function isMonday(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay() === 1;
}

/**
 * PURE retention rule: which snapshot dates survive.
 * Keep the newest KEEP_DAILY dates, plus every Monday within KEEP_WEEKLY_DAYS
 * of `now`. Anything else is pruned. Unparseable folder names are KEPT
 * (never delete what we don't understand — e.g. pre-restore-* safety copies).
 */
function computeRetention(dates, now = new Date()) {
  const valid = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const odd = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  const sorted = [...valid].sort().reverse(); // newest first
  const keep = new Set(sorted.slice(0, KEEP_DAILY));
  const horizon = now.getTime() - KEEP_WEEKLY_DAYS * 24 * 60 * 60 * 1000;
  for (const d of sorted) {
    if (isMonday(d) && new Date(d + 'T00:00:00Z').getTime() >= horizon) keep.add(d);
  }
  for (const d of odd) keep.add(d);
  return {
    keep: [...keep].sort(),
    prune: sorted.filter((d) => !keep.has(d)),
  };
}

/** Folded listing of snapshot dates (folder names under backups/). */
async function listSnapshotDates() {
  const page = await list({
    prefix: BACKUP_PREFIX,
    mode: 'folded',
    token: token(),
    limit: 1000,
  });
  return (page.folders || []).map((f) =>
    f.replace(BACKUP_PREFIX, '').replace(/\/$/, ''),
  );
}

/** Delete every blob under the pruned snapshot dates. */
async function pruneSnapshots({ now = new Date() } = {}) {
  const dates = await listSnapshotDates();
  const { keep, prune } = computeRetention(dates, now);
  let deleted = 0;
  for (const date of prune) {
    const blobs = await listAll(`${BACKUP_PREFIX}${date}/`);
    for (let i = 0; i < blobs.length; i += DEL_CHUNK) {
      const chunk = blobs.slice(i, i + DEL_CHUNK).map((b) => b.url);
      await del(chunk, { token: token() });
      deleted += chunk.length;
    }
  }
  return { kept: keep, pruned: prune, deletedBlobs: deleted };
}

/** Find one blob by exact pathname (list-prefix then exact match), or null. */
async function findBlob(pathname) {
  const blobs = await listAll(pathname);
  return blobs.find((b) => b.pathname === pathname) || null;
}

async function fetchJsonText(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), {
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  return r.text();
}

/** Shallow, honest shape summary for the dry-run diff. */
function shapeSummary(text) {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return { kind: 'array', length: v.length };
    if (v && typeof v === 'object') {
      const summary = { kind: 'object', keys: Object.keys(v).length, arrays: {} };
      for (const [k, val] of Object.entries(v)) {
        if (Array.isArray(val)) summary.arrays[k] = val.length;
      }
      return summary;
    }
    return { kind: typeof v };
  } catch {
    return { kind: 'unparseable' };
  }
}

/**
 * Restore ONE document from a snapshot.
 * Dry-run by default: returns a diff summary and writes NOTHING.
 * With apply=true: copies the current live document to a pre-restore safety
 * path first, then writes the snapshot content back to the canonical key via
 * writeBlob (canonical put options + same-instance cache consistency).
 */
async function restoreDocument({ date, pathname, apply = false, now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('bad date');
  if (!isSnapshotTarget(pathname)) throw new Error(`not a canonical JSON store: ${pathname}`);

  const backup = await findBlob(`${BACKUP_PREFIX}${date}/${pathname}`);
  if (!backup) throw new Error(`no snapshot of ${pathname} on ${date}`);
  const backupText = await fetchJsonText(backup.url);

  const current = await findBlob(pathname);
  const currentText = current ? await fetchJsonText(current.url) : null;

  const diff = {
    pathname,
    snapshotDate: date,
    backup: { bytes: backupText.length, shape: shapeSummary(backupText) },
    current: current
      ? { exists: true, bytes: currentText.length, shape: shapeSummary(currentText) }
      : { exists: false },
    identical: currentText !== null && currentText === backupText,
  };

  if (!apply) return { applied: false, diff };

  if (current) {
    const safety = `${BACKUP_PREFIX}pre-restore-${now.toISOString().replace(/[:.]/g, '-')}/${pathname}`;
    await copy(current.url, safety, {
      access: 'public',
      token: token(),
      addRandomSuffix: false,
    });
    diff.preRestoreCopy = safety;
  }

  const parsed = JSON.parse(backupText); // restores must be valid JSON — fail loudly otherwise
  await writeBlob(pathname, parsed);
  return { applied: true, diff };
}

/** List every document available in one snapshot date. */
async function listSnapshotDocuments(date) {
  const blobs = await listAll(`${BACKUP_PREFIX}${date}/`);
  return blobs.map((b) => b.pathname.replace(`${BACKUP_PREFIX}${date}/`, ''));
}

module.exports = {
  KEEP_DAILY,
  KEEP_WEEKLY_DAYS,
  todayStamp,
  enumerateTargets,
  runSnapshot,
  computeRetention,
  listSnapshotDates,
  listSnapshotDocuments,
  pruneSnapshots,
  restoreDocument,
};
