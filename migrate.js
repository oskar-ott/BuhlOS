// One-shot migration: run locally once with BLOB_READ_WRITE_TOKEN set.
// - Copies legacy *.json files into jobs/birdwood-iv3232/*
// - Creates jobs.json with the Birdwood job entry
// - Creates users.json with the seed admin user (user / buhlisbest)
//
// Legacy photo blobs at birdwood-photos/*.jpg are left in place — the index
// just stores their URLs so they keep working. Only the INDEX file is moved.
//
// Usage:
//   BLOB_READ_WRITE_TOKEN=xxx node migrate.js

const { put, list } = require('@vercel/blob');
const bcrypt = require('bcryptjs');

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) { console.error('BLOB_READ_WRITE_TOKEN required'); process.exit(1); }

const JOB_ID = 'birdwood-iv3232';
const JOB_NAME = '19-23 Birdwood Ave Lane Cove';

async function readLegacy(key, fallback) {
  try {
    const { blobs } = await list({ prefix: key, token: TOKEN });
    const match = blobs.find(b => b.pathname === key);
    if (!match) return fallback;
    const r = await fetch(match.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) {
    console.warn('legacy read failed for', key, '-', e.message);
    return fallback;
  }
}

async function write(key, data) {
  await put(key, JSON.stringify(data), {
    access: 'public', contentType: 'application/json',
    addRandomSuffix: false, token: TOKEN,
  });
  console.log('wrote', key);
}

(async () => {
  // 1. Migrate legacy JSON blobs into jobs/birdwood-iv3232/*
  const legacyMap = [
    ['birdwood-data.json',         `jobs/${JOB_ID}/data.json`,   { dwellings: {}, snags: [] }],
    ['birdwood-tags.json',         `jobs/${JOB_ID}/tags.json`,   { tags: [] }],
    ['birdwood-temps.json',        `jobs/${JOB_ID}/temps.json`,  { temps: [] }],
    ['birdwood-hours.json',        `jobs/${JOB_ID}/hours.json`,  { entries: [] }],
    ['birdwood-photos-index.json', `jobs/${JOB_ID}/photos-index.json`, {}],
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
        roughIn: ['AC Rough-In', 'Lighting Rough-In', 'Power Rough-In', 'NBN', 'Rough-In Inspection'],
        fitOff: ['AC Fit-Off', 'GPO / Switch Install', 'Lighting Install', 'Switchboard Fit-Off', 'Final Test & Commission', 'Certificate of Compliance', 'Handover'],
      },
      layout: { units: 15, townhouses: 7 },
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

  console.log('\nmigration complete');
})().catch(e => { console.error(e); process.exit(1); });
