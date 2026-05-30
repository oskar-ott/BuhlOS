// Seed QA fixture accounts into the users.json blob for E2E (Playwright) runs.
//
// These accounts log in through the REAL /api/auth flow with a real bcrypt
// hash — there is no auth bypass and no backdoor. The script is additive and
// idempotent: it only ever creates or updates usernames prefixed "qa." and
// refuses to modify any other (real) account. Nothing is ever deleted.
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │  PREVIEW / STAGING ONLY. Never run this against the production     │
//   │  Blob store — standing known-PIN accounts in prod are a backdoor.  │
//   └──────────────────────────────────────────────────────────────────┘
//
// Run (point BLOB_READ_WRITE_TOKEN at a PREVIEW store):
//   QA_SEED_ALLOW=yes \
//   BLOB_READ_WRITE_TOKEN=<preview-token> \
//   E2E_ADMIN_PIN='choose-6+chars' E2E_TRADIE_PIN='1234' E2E_LH_PIN='5678' \
//   node scripts/seed-qa-accounts.js
//
// Optional:
//   E2E_TRADIE_USER / E2E_ADMIN_USER / E2E_LH_USER  override the default
//     usernames (must still start with "qa."). Defaults: qa.tradie / qa.admin
//     / qa.lh — set the same values for the Playwright helper (tests/helpers/
//     auth.ts) so login matches.
//   E2E_SEED_JOB_IDS='j1,j2'  assignedJobIds for the tradie + LH fixtures
//     (drives leading-hand own-crew visibility tests). Default: none.
//
// Notes:
//   - Secrets are read from env so they never hit shell history or logs.
//   - The script prints usernames + PIN length only — never the PIN itself.
//   - Re-uses the same hash format + record shape as api/users.js (bcryptjs,
//     10 salt rounds; role/passwordHash/assignedJobIds/createdAt).

const { put, list } = require('@vercel/blob');
const bcrypt = require('bcryptjs');

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const ALLOW = process.env.QA_SEED_ALLOW;

if (ALLOW !== 'yes') {
  console.error('Refusing to run: set QA_SEED_ALLOW=yes to confirm this writes QA accounts to the TARGET blob.');
  console.error('Point BLOB_READ_WRITE_TOKEN at a PREVIEW/STAGING store — never production.');
  process.exit(1);
}
if (!TOKEN) {
  console.error('Set BLOB_READ_WRITE_TOKEN in env first (use a preview/staging token).');
  process.exit(1);
}

function newId() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Mirrors api/users.js validateSecret(): admin >= 6 chars, others a 4-digit PIN.
function validateSecret(role, secret) {
  if (!secret) return 'secret required';
  if (role === 'admin') {
    if (String(secret).length < 6) return 'admin password must be at least 6 chars';
  } else if (!/^\d{4}$/.test(String(secret))) {
    return 'PIN must be exactly 4 digits';
  }
  return null;
}

const jobIds = (process.env.E2E_SEED_JOB_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FIXTURES = [
  {
    username: process.env.E2E_TRADIE_USER || 'qa.tradie',
    role: 'tradie',
    secret: process.env.E2E_TRADIE_PIN,
    assignedJobIds: jobIds,
  },
  {
    username: process.env.E2E_ADMIN_USER || 'qa.admin',
    role: 'admin',
    secret: process.env.E2E_ADMIN_PIN,
    assignedJobIds: [],
  },
  {
    username: process.env.E2E_LH_USER || 'qa.lh',
    role: 'leadingHand',
    secret: process.env.E2E_LH_PIN,
    assignedJobIds: jobIds,
  },
];

// Guard: every fixture username must be namespaced so we can never collide
// with — let alone overwrite — a real account.
for (const f of FIXTURES) {
  if (!/^qa\./i.test(f.username)) {
    console.error(`Fixture username "${f.username}" must start with "qa." (got role ${f.role}).`);
    process.exit(1);
  }
  const err = validateSecret(f.role, f.secret);
  if (err) {
    console.error(`Fixture ${f.username} (${f.role}): ${err}. Set its E2E_*_PIN env var.`);
    process.exit(1);
  }
}

(async function main() {
  console.log('── Seed QA accounts (preview/staging only) ──');
  for (const f of FIXTURES) {
    console.log(`  ${f.username.padEnd(12)} role=${f.role.padEnd(12)} pin=<${String(f.secret).length} chars, hidden>`);
  }
  if (jobIds.length) console.log(`  assignedJobIds → ${jobIds.join(', ')}`);

  // 1. Locate the users.json blob.
  const { blobs } = await list({ prefix: 'users.json', token: TOKEN, limit: 5 });
  const match = blobs.find((b) => b.pathname === 'users.json');
  if (!match) {
    console.error('users.json blob not found in this store.');
    process.exit(1);
  }

  // 2. Read current contents.
  const res = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) {
    console.error('Failed to read users.json:', res.status);
    process.exit(1);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.users)) {
    console.error('users.json is not in the expected { users: [...] } shape.');
    process.exit(1);
  }

  // 3. Upsert each fixture (additive — only ever touches qa.* records).
  let created = 0;
  let updated = 0;
  for (const f of FIXTURES) {
    const passwordHash = await bcrypt.hash(String(f.secret), 10);
    const existing = data.users.find(
      (u) => (u.username || '').toLowerCase() === f.username.toLowerCase()
    );
    if (existing) {
      const isFixture = existing.qaFixture === true || /^qa\./i.test(existing.username || '');
      if (!isFixture) {
        console.error(`Refusing to overwrite non-fixture account "${existing.username}". Aborting before any write.`);
        process.exit(1);
      }
      existing.role = f.role;
      existing.passwordHash = passwordHash;
      existing.assignedJobIds = f.assignedJobIds;
      existing.qaFixture = true;
      if (f.role === 'tradie' || f.role === 'leadingHand') {
        if (typeof existing.hourlyRate !== 'number') existing.hourlyRate = 0;
      }
      updated += 1;
    } else {
      const user = {
        id: newId(),
        username: f.username,
        role: f.role,
        passwordHash,
        assignedJobIds: f.assignedJobIds,
        qaFixture: true,
        createdAt: new Date().toISOString(),
      };
      if (f.role === 'tradie' || f.role === 'leadingHand') user.hourlyRate = 0;
      data.users.push(user);
      created += 1;
    }
  }

  // 4. Write back. addRandomSuffix:false + same key = overwrite the blob.
  await put('users.json', JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: TOKEN,
  });

  console.log('');
  console.log(`✓ QA accounts seeded — ${created} created, ${updated} updated.`);
  console.log('  Export the matching E2E_*_USER / E2E_*_PIN and PLAYWRIGHT_BASE_URL (preview) to run the authed specs.');
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
