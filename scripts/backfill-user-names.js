#!/usr/bin/env node
/**
 * One-off backfill (2026-07-28): stamp a human `name` on users.json rows that
 * have none. Signup-link / invite logins were created with username = email
 * and NO name, so the app-wide `user.name || user.username` display fallback
 * greeted those workers with their raw email address. New accounts now get a
 * name at creation (api/employees.js signup-approve, api/invites.js accept);
 * this closes the gap for rows created before the fix.
 *
 * The name comes from the employee record linked by employee.userId
 * (preferred/display first name + last name — same derivation as the fix).
 * Users with no linked employee are reported and left untouched.
 *
 * SAFE BY DEFAULT: dry-run. Pass --write to apply. Needs BLOB_READ_WRITE_TOKEN
 * (e.g. `vercel env pull --environment=production .env.import` then
 * `set -a; . ./.env.import; set +a`).
 */
const { list } = require('@vercel/blob');
const path = require('path');

// Reuse the app's own blob layer so guards + host learning behave identically.
const { readBlob, writeBlob } = require(path.join(__dirname, '..', 'api', '_lib', 'blob.js'));

const WRITE = process.argv.includes('--write');

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN not set — pull prod env first.');
    process.exit(1);
  }
  // Warm the public-host fast path.
  await list({ prefix: 'users.json', token: process.env.BLOB_READ_WRITE_TOKEN });

  const usersBlob = await readBlob('users.json', { users: [] });
  const empBlob = await readBlob('employees.json', { employees: [] });
  const employees = empBlob.employees || [];

  let changed = 0;
  for (const u of usersBlob.users || []) {
    if (u.name && String(u.name).trim()) continue;
    const emp = employees.find((e) => e.userId === u.id);
    if (!emp) {
      // Admin-created logins use a human username already — only flag the
      // email-shaped ones as needing attention.
      if (String(u.username || '').includes('@')) {
        console.log(`SKIP  ${u.id} (${u.username}) — no linked employee record`);
      }
      continue;
    }
    const name = `${emp.displayName || emp.firstName || ''} ${emp.lastName || ''}`.trim();
    if (!name) {
      console.log(`SKIP  ${u.id} (${u.username}) — employee record has no name`);
      continue;
    }
    console.log(`${WRITE ? 'SET ' : 'PLAN'}  ${u.id} (${u.username}) → name: "${name}"`);
    u.name = name;
    changed += 1;
  }

  if (changed === 0) {
    console.log('Nothing to do.');
    return;
  }
  if (!WRITE) {
    console.log(`\nDry-run: ${changed} user(s) would change. Re-run with --write to apply.`);
    return;
  }
  await writeBlob('users.json', usersBlob);
  console.log(`\nWrote users.json — ${changed} user(s) updated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
