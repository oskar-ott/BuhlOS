#!/usr/bin/env node
/**
 * One-off data fix (2026-08-09): re-derive the stored ordinary/overtime split
 * for time entries logged BEFORE the OT boundary moved from 8h to the
 * standard day (7.6h — owner-directed, PR #995).
 *
 * Two workers logged real overtime days that stored the OLD split
 * (e.g. 8h 36m → 8h ordinary + 36m OT); the correct classification is
 * 7h 36m ordinary + 1h OT. Totals are untouched — only the split fields.
 *
 * SAFE BY DEFAULT: dry-run. Pass --write to apply. Every changed entry's
 * original JSON is saved to backups/ot-split-fix-<today>.json BEFORE any
 * write. Needs BLOB_READ_WRITE_TOKEN
 * (e.g. `vercel env pull --environment=production .env.import` then
 * `set -a; . ./.env.import; set +a`).
 *
 * Scope + refusals (reported, never silently skipped):
 *   - only entries dated on/after HOURS go-live (2026-08-03)
 *   - only entries whose stored split EXACTLY matches the old 8h rule;
 *     anything else (manual override, otOverridden, already-new-rule,
 *     non-reconciling legacy) is listed and left alone
 */
const { list } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');

// Reuse the app's own blob layer so write guards behave identically.
const { writeBlob } = require(path.join(__dirname, '..', 'api', '_lib', 'blob.js'));

const WRITE = process.argv.includes('--write');

// Load BLOB_READ_WRITE_TOKEN from a `vercel env pull` file when the shell
// didn't export it (some sandboxes can't source env files).
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  for (const candidate of ['.env.import', '.env.production.local']) {
    const p = path.join(__dirname, '..', candidate);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
    break;
  }
}
const GO_LIVE = '2026-08-03';
const STANDARD_DAY = 7.6;

const r2 = (n) => Math.round(n * 100) / 100;
const oldSplit = (t) => ({ ordinary: r2(Math.min(t, 8)), overtime: r2(Math.max(0, t - 8)) });
const newSplit = (t) => ({
  ordinary: r2(Math.min(t, STANDARD_DAY)),
  overtime: r2(Math.max(0, t - STANDARD_DAY)),
});
const eq = (a, b) => Math.abs(a - b) < 0.005;

async function readJson(url) {
  const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  return await r.json();
}

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.error('BLOB_READ_WRITE_TOKEN not set — pull prod env first.');
    process.exit(1);
  }

  // Full entry sweep (same filter the API's own all-entries listing uses).
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: 'users/', token, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const entryBlobs = blobs.filter(
    (b) =>
      b.pathname.includes('/time-entries/') &&
      !b.pathname.includes('/time-entries-audit/') &&
      b.pathname.endsWith('.json'),
  );

  const toFix = [];
  const skipped = [];
  for (const b of entryBlobs) {
    const date = b.pathname.slice(b.pathname.lastIndexOf('/') + 1, -5);
    if (date < GO_LIVE) continue;
    const entry = await readJson(b.url);
    if (!entry || typeof entry.totalHours !== 'number') {
      skipped.push({ path: b.pathname, why: 'unreadable / no totalHours' });
      continue;
    }
    const t = entry.totalHours;
    if (t <= STANDARD_DAY + 0.001) continue; // no OT under either rule
    const oldS = oldSplit(t);
    const newS = newSplit(t);
    const ord = Number(entry.ordinaryHours);
    const ot = Number(entry.overtimeHours);
    if (eq(ord, newS.ordinary) && eq(ot, newS.overtime)) continue; // already right
    if (entry.otOverridden) {
      skipped.push({ path: b.pathname, why: `otOverridden — left alone (${ord}/${ot})` });
      continue;
    }
    if (!eq(ord, oldS.ordinary) || !eq(ot, oldS.overtime)) {
      skipped.push({
        path: b.pathname,
        why: `split matches NEITHER rule (${ord}/${ot} for ${t}h) — left alone`,
      });
      continue;
    }
    toFix.push({ pathname: b.pathname, date, entry, newS });
  }

  console.log(`Entries needing the fix: ${toFix.length}`);
  for (const f of toFix) {
    console.log(
      `  ${f.entry.userName || f.entry.userId}  ${f.date}  total ${f.entry.totalHours}h  ` +
        `[${f.entry.status}]  ${f.entry.ordinaryHours}/${f.entry.overtimeHours}  ->  ` +
        `${f.newS.ordinary}/${f.newS.overtime}`,
    );
  }
  for (const s of skipped) console.log(`  SKIP ${s.path}: ${s.why}`);

  if (!WRITE) {
    console.log('\nDry-run only. Re-run with --write to apply.');
    return;
  }

  // Backup originals BEFORE any write.
  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `ot-split-fix-${new Date().toISOString().slice(0, 10)}.json`,
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify(toFix.map((f) => ({ pathname: f.pathname, original: f.entry })), null, 2),
  );
  console.log(`\nBacked up ${toFix.length} originals to ${backupPath}`);

  for (const f of toFix) {
    const next = {
      ...f.entry,
      ordinaryHours: f.newS.ordinary,
      overtimeHours: f.newS.overtime,
      updatedAt: new Date().toISOString(),
    };
    await writeBlob(f.pathname, next);
    console.log(`  WROTE ${f.pathname}`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
