#!/usr/bin/env node
// Hours parity dry-run importer (scaffold) — READ-ONLY by construction.
//
//   node scripts/importers/hours-dry-run.js [--from-dir <dir>] [--json] [--write]
//
// Reads users.json + jobs.json + every users/<id>/time-entries/<date>.json +
// payroll-runs.json (live Vercel Blob via list+fetch / readBlob, or a local
// key-for-key snapshot) and prints the proposed hours-slice import plan +
// payroll-critical parity numbers (hours by user/week, allocation totals,
// status splits) and quarantine buckets. Exit 0 clean, 1 on hard validation.
//
// Safety:
//   * NEVER writes to Supabase — no client exists; the planner is pure.
//   * NEVER writes to Vercel Blob — only the read-only `list` (enumeration)
//     and `fetch`/`readBlob` (reads) are used; no write helpers are imported.
//   * --write must pass the Supabase environment guard and even then throws
//     WRITE_NOT_IMPLEMENTED (this scaffold is dry-run only).
//   * Not wired to any API route, deploy hook or cron. Operator-run only.
//
// Contract: docs/supabase-importer-plan.md · usage: scripts/importers/README.md

const fs = require('node:fs');
const path = require('node:path');

const { buildHoursImportPlan } = require('./lib/hours-plan');
const { resolveRunMode, describeTarget } = require('./lib/run-mode');
const supabaseEnvGuard = require('../../api/_lib/supabase-env');

const FETCH_CONCURRENCY = 8;

function parseArgs(argv) {
  const args = { fromDir: null, json: false, write: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-dir') args.fromDir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--write') args.write = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`malformed JSON at ${filePath}: ${err.message}`);
  }
}

// Authoritative user+date come from the blob KEY: users/<id>/time-entries/<date>.json
const ENTRY_KEY_RE = /^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/;

// ── local snapshot loader (no tokens needed) ───────────────────────────────
function loadFromDir(dir) {
  const users = readJsonFile(path.join(dir, 'users.json'));
  const jobs = readJsonFile(path.join(dir, 'jobs.json'));
  const payrollRuns = readJsonFile(path.join(dir, 'payroll-runs.json'));
  const entries = [];
  const usersDir = path.join(dir, 'users');
  if (fs.existsSync(usersDir)) {
    for (const userId of fs.readdirSync(usersDir)) {
      const teDir = path.join(usersDir, userId, 'time-entries');
      if (!fs.existsSync(teDir)) continue;
      for (const file of fs.readdirSync(teDir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
        if (!m) continue;
        entries.push({ userId, date: m[1], entry: readJsonFile(path.join(teDir, file)) });
      }
    }
  }
  return { users, jobs, entries, payrollRuns };
}

// ── live Blob loader — READ-ONLY (list + fetch + readBlob) ──────────────────
async function loadFromBlob() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set — export it (read access) or use --from-dir <snapshot>'
    );
  }
  const { list } = require('@vercel/blob'); // read-only enumeration; no put/del
  const { readBlob } = require('../../api/_lib/blob');

  const users = await readBlob('users.json', null);
  const jobs = await readBlob('jobs.json', null);
  const payrollRuns = await readBlob('payroll-runs.json', null);

  // Enumerate every day blob under users/, excluding the per-user audit logs.
  const dayBlobs = [];
  let cursor;
  do {
    const res = await list({ prefix: 'users/', token, limit: 1000, cursor });
    for (const b of res.blobs || []) {
      const m = ENTRY_KEY_RE.exec(b.pathname);
      if (m) dayBlobs.push({ userId: m[1], date: m[2], url: b.url });
    }
    cursor = res.cursor;
  } while (cursor);

  const entries = [];
  for (let i = 0; i < dayBlobs.length; i += FETCH_CONCURRENCY) {
    const chunk = dayBlobs.slice(i, i + FETCH_CONCURRENCY);
    const fetched = await Promise.all(
      chunk.map(async (b) => {
        try {
          const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
          if (!r.ok) return null;
          return await r.json();
        } catch {
          return null;
        }
      })
    );
    chunk.forEach((b, idx) => entries.push({ userId: b.userId, date: b.date, entry: fetched[idx] }));
  }
  return { users, jobs, entries, payrollRuns };
}

function printSection(title, rows, cap = 25) {
  if (!rows || !rows.length) return;
  console.log(`\n${title} (${rows.length})`);
  for (const row of rows.slice(0, cap)) {
    console.log(`  - ${typeof row === 'string' ? row : JSON.stringify(row)}`);
  }
  if (rows.length > cap) console.log(`  … and ${rows.length - cap} more`);
}

function printPlan(plan) {
  const s = plan.summary;
  console.log('\nProposed hours import (dry-run — nothing was written)');
  console.log('table                     inserts  updates');
  for (const [t, c] of Object.entries(plan.tables)) {
    const note = c.note ? `  (${c.note})` : '';
    console.log(`${t.padEnd(26)}${String(c.inserts).padStart(7)}${String(c.updates).padStart(9)}${note}`);
  }
  console.log(`\nnote: ${s.updatesNote}`);
  console.log(
    `sources: ${s.sources.users} users, ${s.sources.jobs} jobs, ` +
      `${s.sources.entryBlobs} time-entry blobs, ${s.sources.payrollRuns} payroll runs`
  );
  console.log(
    `discovered: ${s.usersWithEntries}/${s.usersDiscovered} users with entries · ` +
      `${s.datesDiscovered} dates · ${s.weekStartsDiscovered} week-starts`
  );
  console.log(
    `status counts: draft ${s.entriesByStatus.draft}, submitted ${s.entriesByStatus.submitted}, ` +
      `approved ${s.entriesByStatus.approved}, rejected ${s.entriesByStatus.rejected}`
  );
  console.log(
    `hours: total ${s.totalHours} = ordinary ${s.ordinaryHours} + overtime ${s.overtimeHours}`
  );
  console.log(
    `allocations: total ${s.allocationTotal} (internal/no-job ${s.internalAllocationTotal}) · ` +
      `entry-total vs alloc-total delta ${round(s.totalHours - s.allocationTotal)}`
  );
  console.log(`hours by user×week: ${JSON.stringify(s.hoursByUserWeek)}`);
  console.log(`hours by job×week:  ${JSON.stringify(s.hoursByJobWeek)}`);
  console.log(`status hours by week: ${JSON.stringify(s.statusHoursByWeek)}`);
  console.log(`payroll runs: ${s.payrollRunCount} (rowCount total ${s.payrollRunRowCountTotal})`);

  printSection('HARD ERRORS', plan.hardErrors);
  printSection('Quarantined entries', plan.quarantined);
  printSection('Missing user refs', plan.missingUserRefs);
  printSection('Missing job refs', plan.missingJobRefs);
  printSection('Duplicate user+date', plan.duplicateUserDate);
  printSection('Invalid dates', plan.invalidDates);
  printSection('Invalid statuses', plan.invalidStatuses);
  printSection('Invalid hour totals', plan.invalidHourTotals);
  printSection('ordinary+overtime != total', plan.ordinaryOvertimeMismatch);
  printSection('Over-16h days', plan.over16Violations);
  printSection('Allocation sum != total', plan.allocationSumMismatch);
  printSection('Week-start not Monday', plan.weekStartNonMonday);
  printSection('Reopen/approval inconsistencies (warnings)', plan.reopenApprovalInconsistencies);
  printSection('Warnings', plan.warnings);

  console.log(`\nresult: ${plan.summary.clean ? 'CLEAN' : 'NOT CLEAN — fix before any real import'}`);
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'usage: node scripts/importers/hours-dry-run.js [--from-dir <dir>] [--json] [--write]'
    );
    process.exitCode = process.argv.length > 3 ? 1 : 0;
    return;
  }

  // Mode first: --write must fail loudly BEFORE any source is read.
  const runMode = resolveRunMode(process.argv.slice(2), process.env, supabaseEnvGuard);
  console.log(`mode: ${runMode.mode}`);
  for (const line of describeTarget(process.env)) console.log(line);

  const sources = args.fromDir ? loadFromDir(args.fromDir) : await loadFromBlob();
  const plan = buildHoursImportPlan(sources);

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printPlan(plan);
  }
  process.exitCode = plan.summary.clean ? 0 : 1;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
