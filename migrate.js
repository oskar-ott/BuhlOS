// One-shot migration: run locally once with BLOB_READ_WRITE_TOKEN set.
// - Copies legacy birdwood-data.json / birdwood-tags.json / etc into jobs/birdwood-iv3232/*
// - Creates jobs.json with the Birdwood job entry
// - Creates users.json with the seed admin user (user / buhlisbest)
//
// Usage:
//   BLOB_READ_WRITE_TOKEN=xxx SESSION_SECRET=xxx node migrate.js

const { put, list } = require('@vercel/blob');
const bcrypt = require('bcryptjs');

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) { console.error('BLOB_READ_WRITE_TOKEN required'); process.exit(1); }

const JOB_ID = 'birdwood-iv3232';
const JOB_NAME = 'Birdwood IV3232';

async function readLegacy(key, fallback) {
  const { blobs } = await list({ prefix: key, token: TOKEN });
  const match = blobs.find(b => b.pathname === key);
  if (!match) return fallback;
  const r = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
  return await r.json();
}

async function write(key, data) {
  await put(key, JSON.stringify(data), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, token: TOKEN,
  });
  console.log('wrote', key);
}

(async () => {
  // 1. Migrate legacy data into jobs/birdwood-iv3232/*
  const legacyMap = [
    ['birdwood-data.json',  `jobs/${JOB_ID}/data.json`,  { dwellings: {}, snags: [], notes: [] }],
    ['birdwood-tags.json',  `jobs/${JOB_ID}/tags.json`,  { tags: [] }],
    ['birdwood-temps.json', `jobs/${JOB_ID}/temps.json`, { temps: [] }],
    ['birdwood-hours.json', `jobs/${JOB_ID}/hours.json`, { entries: [] }],
  ];
  for (const [oldKey, newKey, fallback] of legacyMap) {
    const data = await readLegacy(oldKey, fallback);
    await write(newKey, data);
  }

  // 2. Seed jobs.json
  await write('jobs.json', {
    jobs: [{
      id: JOB_ID,
      name: JOB_NAME,
      clientUserId: null,
      stages: {
        roughIn: ['Conduit', 'Cables', 'Rough-In Complete'],
        fitOff: ['Fit-Off', 'Test', 'Handover'],
      },
      createdAt: new Date().toISOString(),
      status: 'active',
    }],
  });

  // 3. Seed admin user
  const existingUsers = await readLegacy('users.json', { users: [] });
  if (!existingUsers.users.find(u => u.username === 'user')) {
    const passwordHash = await bcrypt.hash('buhlisbest', 10);
    existingUsers.users.push({
      id: 'u_admin_seed',
      username: 'user',
      role: 'admin',
      passwordHash,
      assignedJobIds: [],
      createdAt: new Date().toISOString(),
    });
    await write('users.json', existingUsers);
    console.log('seeded admin user: user / buhlisbest');
  } else {
    console.log('admin user already exists, skipping seed');
  }

  console.log('migration complete');
})().catch(e => { console.error(e); process.exit(1); });
