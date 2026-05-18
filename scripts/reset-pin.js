// Reset a user's PIN (passwordHash) in the users.json blob.
// Use only when you're locked out and have no other admin account to log in with.
//
// Run:
//   USERNAME=admin NEW_PIN='something-strong' BLOB_READ_WRITE_TOKEN=<token> \
//     node scripts/reset-pin.js
//
// Notes:
//   - NEW_PIN is read from env var so it never appears in shell history or logs.
//   - The script prints the username and NEW PIN length only — never the PIN itself.
//   - Re-uses the same hash format as api/users.js (bcryptjs, 10 salt rounds).
//   - Keeps the rest of the user record intact (role, assignedJobIds, email, etc.).

const { put, list } = require('@vercel/blob');
const bcrypt = require('bcryptjs');

const TOKEN    = process.env.BLOB_READ_WRITE_TOKEN;
const USERNAME = process.env.USERNAME || 'admin';
const NEW_PIN  = process.env.NEW_PIN;

if (!TOKEN)   { console.error('Set BLOB_READ_WRITE_TOKEN in env first.'); process.exit(1); }
if (!NEW_PIN) { console.error('Set NEW_PIN in env first (the new password to set).'); process.exit(1); }
if (NEW_PIN.length < 6) { console.error('NEW_PIN must be at least 6 characters.'); process.exit(1); }

(async function main() {
  console.log('── Reset PIN ──');
  console.log(`Username:  ${USERNAME}`);
  console.log(`New PIN:   <${NEW_PIN.length} chars, hidden>`);

  // 1. Locate the users.json blob
  const { blobs } = await list({ prefix: 'users.json', token: TOKEN, limit: 5 });
  const match = blobs.find(b => b.pathname === 'users.json');
  if (!match) { console.error('users.json blob not found.'); process.exit(1); }

  // 2. Read current contents
  const res = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) { console.error('Failed to read users.json:', res.status); process.exit(1); }
  const data = await res.json();
  if (!data || !Array.isArray(data.users)) {
    console.error('users.json is not in the expected { users: [...] } shape.');
    process.exit(1);
  }

  // 3. Find the user (case-insensitive, matching api/auth.js behaviour)
  const user = data.users.find(u =>
    (u.username || '').toLowerCase() === USERNAME.toLowerCase()
  );
  if (!user) {
    console.error(`No user with username "${USERNAME}" — found ${data.users.length} users:`);
    data.users.forEach(u => console.error(`  - ${u.username} (${u.role})`));
    process.exit(1);
  }

  console.log(`Found user: ${user.username} (id=${user.id}, role=${user.role})`);

  // 4. Hash + replace
  const newHash = await bcrypt.hash(NEW_PIN, 10);
  user.passwordHash = newHash;

  // 5. Write back. addRandomSuffix:false + same key = overwrite.
  await put('users.json', JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: TOKEN,
  });

  console.log('');
  console.log(`✓ PIN reset for "${user.username}".`);
  const loginUrl = (process.env.NEXT_PUBLIC_BUHLOS_URL || process.env.BUHLOS_URL || 'https://buhlos.com').replace(/\/+$/, '') + '/login';
  console.log(`  Try logging in at ${loginUrl} with the new PIN.`);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
