#!/usr/bin/env node
/**
 * Provision a dedicated OWNER-role login for the Owner Console
 * (docs/owner-console.md).
 *
 * Creates (or rotates the password of) a `users.json` account with
 * `role: 'owner'`, so signing in with it lands STRAIGHT on the Owner Console
 * (`/owner`) via `landingFor('owner')`, completely separate from your normal
 * work account.
 *
 * SAFETY
 *  - Requires BLOB_READ_WRITE_TOKEN in the env (the **production** Vercel Blob
 *    token — it touches prod `users.json`). Get it from the Vercel dashboard
 *    (Storage → your Blob store → token) or `vercel env pull`.
 *  - The password is read from a HIDDEN prompt (or the OWNER_PASSWORD env for
 *    non-interactive use). It is never echoed, never logged, never an argv.
 *  - Reuses `api/_lib/blob` writeBlob, which runs the `users.json` shrink guard
 *    (a write that drops accounts is refused). Adding one account only grows
 *    the array, so the guard passes.
 *  - Refuses to overwrite an existing NON-owner account that shares the username.
 *
 * NOTE: `owner` is an admin-tier role, so this account also has full admin
 * access — it simply LANDS on `/owner`. To ROTATE its password later, re-run
 * this script; do NOT use the in-app "change password" (its format policy would
 * force a 4-digit PIN for any non-`admin` role).
 *
 * USAGE
 *   BLOB_READ_WRITE_TOKEN=<prod-token> node scripts/provision-owner-user.js [username] [email]
 *     # defaults: username "owner", email "" (the role alone grants access)
 *   # non-interactive:
 *   OWNER_PASSWORD=… BLOB_READ_WRITE_TOKEN=… node scripts/provision-owner-user.js owner
 *   # preview only (no write):
 *   … node scripts/provision-owner-user.js owner --dry-run
 */
'use strict';

const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const blob = require('../api/_lib/blob');
const readFresh = blob.readBlobFresh || blob.readBlob;
const { writeBlob } = blob;

const DRY = process.argv.includes('--dry-run');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const username = String(args[0] || 'owner').trim();
const email = String(args[1] || '').trim();

function readPasswordHidden(promptText) {
  // Non-interactive path: take it from the env (CI / one-liner).
  if (process.env.OWNER_PASSWORD) return Promise.resolve(process.env.OWNER_PASSWORD);
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error('No TTY for a hidden prompt. Pass the password via the OWNER_PASSWORD env var.'),
    );
  }
  // readline handles line-editing (backspace) + Ctrl-C natively; muting
  // `_writeToOutput` stops the typed characters echoing to the terminal.
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};
    process.stdout.write(promptText);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('✗ BLOB_READ_WRITE_TOKEN is not set.');
    console.error('  Set it to the PRODUCTION Vercel Blob token (Vercel → Storage → Blob → token,');
    console.error('  or run `vercel env pull` and source the value) before running this script.');
    process.exit(1);
  }

  const password = String(await readPasswordHidden(`Owner password for "${username}": `)).trim();
  if (password.length < 8) {
    console.error('✗ Password must be at least 8 characters. Aborting (nothing written).');
    process.exit(1);
  }

  const doc = await readFresh('users.json', { users: [] });
  if (!doc || !Array.isArray(doc.users)) {
    console.error('✗ users.json is missing or malformed — refusing to write.');
    process.exit(1);
  }

  const lc = username.toLowerCase();
  const existing = doc.users.find((u) => String(u.username || '').toLowerCase() === lc);
  const passwordHash = await bcrypt.hash(password, 10);

  let action;
  if (existing) {
    if (String(existing.role || '').toLowerCase() !== 'owner') {
      console.error(`✗ A non-owner account already uses username "${username}" (role "${existing.role}").`);
      console.error('  Refusing to hijack it — pick a different username.');
      process.exit(1);
    }
    existing.passwordHash = passwordHash;
    existing.role = 'owner';
    if (email) existing.email = email;
    existing.disabled = false;
    existing.archived = false;
    action = 'rotated password for the existing owner account';
  } else {
    const user = {
      id: 'usr_owner_' + crypto.randomBytes(6).toString('hex'),
      username,
      role: 'owner',
      passwordHash,
      assignedJobIds: [],
      createdAt: new Date().toISOString(),
    };
    if (email) user.email = email;
    doc.users.push(user);
    action = 'created a new owner account';
  }

  if (DRY) {
    console.log(`[dry-run] would ${action}: username="${username}", role=owner. users.json would have ${doc.users.length} accounts. Nothing written.`);
    process.exit(0);
  }

  await writeBlob('users.json', doc);
  console.log(`✓ ${action}.`);
  console.log(`  username : ${username}`);
  console.log('  role     : owner  →  sign-in lands on /owner (Owner Console)');
  console.log(`  accounts : ${doc.users.length} total in users.json`);
  console.log('  Sign in at /v2/login with this username + the password you just set.');
})().catch((e) => {
  console.error('✗ failed:', e && e.message ? e.message : e);
  process.exit(1);
});
