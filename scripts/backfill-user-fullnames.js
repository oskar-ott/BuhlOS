#!/usr/bin/env node
// One-off (owner-directed 2026-08-09): users.json `name` becomes the REAL full
// name ("firstName lastName" from the employee record); the "what you go by"
// nickname moves to a new `preferredName` field, which the Phil greeting alone
// prefers. Before this, signup logins carried name = "preferred last" — so the
// hours surfaces greeted the office with nicknames.
//
//   node scripts/backfill-user-fullnames.js            # dry-run (no writes)
//   node scripts/backfill-user-fullnames.js --write    # apply
//
// Scope: only users linked from an employees.json row (employee.userId). The
// pre-signup accounts (no employee record) are untouched. Idempotent: a user
// already carrying the full name and nickname is reported unchanged. The
// original users.json is saved to backups/user-fullnames-<today>.json BEFORE
// any write. Postgres display_name is NOT touched here — re-run
// scripts/importers/structure-import.js --write afterwards (its IS DISTINCT
// FROM upsert refreshes display_name from the new users.json).

const fs = require('fs');
const path = require('path');
const { readBlob, writeBlob } = require('../api/_lib/blob');

const WRITE = process.argv.includes('--write');

(async () => {
  const usersBlob = await readBlob('users.json', { users: [] });
  const empBlob = await readBlob('employees.json', { employees: [] });
  const userById = new Map((usersBlob.users || []).map((u) => [u.id, u]));

  const changes = [];
  for (const e of empBlob.employees || []) {
    if (!e.userId) continue;
    const u = userById.get(e.userId);
    if (!u) continue;
    const full = `${e.firstName || ''} ${e.lastName || ''}`.trim();
    if (!full) continue; // no honest name to write — never guess
    const nickname = (e.displayName || '').trim() || null;
    const next = { name: full, preferredName: nickname };
    const same = u.name === next.name && (u.preferredName || null) === next.preferredName;
    if (same) continue;
    changes.push({ id: u.id, username: u.username, before: { name: u.name, preferredName: u.preferredName || null }, after: next });
  }

  console.log(`${WRITE ? 'APPLY' : 'DRY RUN'} — ${changes.length} user(s) to update (of ${(usersBlob.users || []).length})`);
  for (const c of changes) {
    console.log(`  ${c.id} ${c.username}: "${c.before.name}" → "${c.after.name}"` +
      (c.after.preferredName ? `  (goes by "${c.after.preferredName}")` : ''));
  }
  if (!WRITE || changes.length === 0) {
    if (!WRITE) console.log('\nrun with --write to apply.');
    return;
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `user-fullnames-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(usersBlob, null, 2));
  console.log(`\nBacked up users.json to ${backupPath}`);

  for (const c of changes) {
    const u = userById.get(c.id);
    u.name = c.after.name;
    u.preferredName = c.after.preferredName;
  }
  await writeBlob('users.json', usersBlob);
  console.log(`Applied ${changes.length} update(s).`);
})().catch((e) => { console.error('failed:', e && e.message); process.exit(1); });
