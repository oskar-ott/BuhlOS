// Migrate legacy per-job hours into the new per-user time-entries shape.
//
// Legacy:    jobs/<jobId>/hours.json
//            { entries: [{ id, date, crew: [{userId, name, hours: <decimal>}], notes }] }
//
// New:       users/<userId>/time-entries/<date>.json
//            { id, userId, userName, userRole, date, totalHours, ordinaryHours,
//              overtimeHours, allocations: [{jobId, hours, notes, sortOrder}],
//              status: 'approved', approvedBy, approvedAt, ... }
//
// Run:
//   BLOB_READ_WRITE_TOKEN=<token> node scripts/migrate-hours.js                 # live
//   DRY_RUN=1 BLOB_READ_WRITE_TOKEN=<token> node scripts/migrate-hours.js       # preview
//   ADMIN_USER_ID=oskar ...                                                     # override approvedBy stamp
//
// Idempotent strategy:
//   - If a target entry already exists for (user, date), legacy crew rows are
//     ADDED as new allocations (no duplication if the migration is re-run AND
//     the legacy file is unchanged — re-running creates the same allocations
//     a second time, so re-runs are NOT safe. Preview with DRY_RUN=1 first).
//   - The migrated entries are stamped status:'approved', approvedBy:<admin>,
//     notes prefixed '[migrated]' for traceability.
//
// Notes:
//   - Legacy stores decimal hours only. Any "rest day" / "overtime" granularity
//     was not captured upstream — we apply the standard 8-hr split per entry.
//   - Tradies' hourlyRate is intentionally NOT used. The legacy data is a record
//     of hours, not pay; payroll downstream reads time-entries directly.

const { put, list } = require('@vercel/blob');

const DRY_RUN = process.env.DRY_RUN === '1';
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || 'admin';

if (!TOKEN) {
  console.error('Set BLOB_READ_WRITE_TOKEN in your env first.');
  process.exit(1);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function autoSplit(total) {
  return {
    ordinary: Math.round(Math.min(total, 8) * 100) / 100,
    overtime: Math.round(Math.max(0, total - 8) * 100) / 100,
  };
}
async function readJsonFromBlob(b) {
  const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  return await r.json();
}
async function readUsersBlob() {
  const { blobs } = await list({ prefix: 'users.json', token: TOKEN, limit: 5 });
  const m = blobs.find(b => b.pathname === 'users.json');
  if (!m) return { users: [] };
  return (await readJsonFromBlob(m)) || { users: [] };
}
async function readTargetEntry(userId, date) {
  const path = `users/${userId}/time-entries/${date}.json`;
  const { blobs } = await list({ prefix: path, token: TOKEN, limit: 5 });
  const m = blobs.find(b => b.pathname === path);
  if (!m) return null;
  return await readJsonFromBlob(m);
}
async function writeTargetEntry(entry) {
  const path = `users/${entry.userId}/time-entries/${entry.date}.json`;
  await put(path, JSON.stringify(entry, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    token: TOKEN,
  });
}

(async function main () {
  console.log(DRY_RUN ? '── DRY RUN — no writes ──' : '── LIVE MIGRATION ──');

  // Index users by id so we can stamp role/name
  const usersBlob = await readUsersBlob();
  const userById = {};
  (usersBlob.users || []).forEach(u => { userById[u.id] = u; });
  console.log(`Loaded ${(usersBlob.users || []).length} users.`);

  // Find every legacy hours blob: jobs/<jobId>/hours.json
  const { blobs } = await list({ prefix: 'jobs/', token: TOKEN, limit: 5000 });
  const hoursBlobs = blobs.filter(b => /^jobs\/[^/]+\/hours\.json$/.test(b.pathname));
  console.log(`Found ${hoursBlobs.length} legacy hours blob(s).`);

  let totalCrewRows = 0, written = 0, skipped = 0, mergedIntoExisting = 0;
  const now = new Date().toISOString();

  for (const hb of hoursBlobs) {
    const m = hb.pathname.match(/^jobs\/([^/]+)\/hours\.json$/);
    const jobId = m && m[1];
    if (!jobId) continue;
    const data = await readJsonFromBlob(hb);
    if (!data) { console.warn(`Could not read ${hb.pathname}`); continue; }
    const dayEntries = Array.isArray(data) ? data : (data.entries || []);

    for (const day of dayEntries) {
      const date = day && day.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }
      const crew = Array.isArray(day.crew) ? day.crew : [];
      for (const c of crew) {
        totalCrewRows++;
        const userId = c.userId;
        const hours = Number(c.hours) || 0;
        if (!userId || hours <= 0) { skipped++; continue; }

        const existing = await readTargetEntry(userId, date);
        if (existing) {
          // Merge as an additional allocation. Preserves earlier migration writes.
          const newTotal = Math.round((Number(existing.totalHours || 0) + hours) * 100) / 100;
          const split = autoSplit(newTotal);
          const merged = {
            ...existing,
            totalHours: newTotal,
            ordinaryHours: split.ordinary,
            overtimeHours: split.overtime,
            otOverridden: false,
            allocations: [
              ...(existing.allocations || []),
              {
                jobId,
                hours,
                notes: c.name ? `[migrated] ${c.name}` : '[migrated]',
                sortOrder: (existing.allocations || []).length,
              },
            ],
            updatedAt: now,
          };
          if (DRY_RUN) console.log(`would MERGE ${userId}/${date} += ${hours.toFixed(2)} hrs on ${jobId}`);
          else await writeTargetEntry(merged);
          mergedIntoExisting++;
        } else {
          const split = autoSplit(hours);
          const u = userById[userId];
          const entry = {
            id: newId(),
            userId,
            userName: (u && u.username) || c.name || userId,
            userRole: (u && u.role) || 'tradie',
            date,
            startTime: null,
            endTime: null,
            breakMinutes: 30,
            totalHours: hours,
            ordinaryHours: split.ordinary,
            overtimeHours: split.overtime,
            otOverridden: false,
            notes: '[migrated]',
            status: 'approved',
            submittedAt: now,
            approvedBy: ADMIN_USER_ID,
            approvedAt: now,
            rejectedReason: null,
            allocations: [{ jobId, hours, notes: c.name ? `[migrated] ${c.name}` : '[migrated]', sortOrder: 0 }],
            createdAt: day.createdAt || now,
            updatedAt: now,
          };
          if (DRY_RUN) console.log(`would WRITE ${userId}/${date} = ${hours.toFixed(2)} hrs on ${jobId}`);
          else await writeTargetEntry(entry);
          written++;
        }
      }
    }
  }

  console.log('');
  console.log('── Summary ──');
  console.log(`  Crew rows scanned:   ${totalCrewRows}`);
  console.log(`  New entries written: ${written}`);
  console.log(`  Merged into existing: ${mergedIntoExisting}`);
  console.log(`  Skipped (bad rows):  ${skipped}`);
  console.log('');
  console.log(DRY_RUN
    ? 'Dry run complete. Re-run without DRY_RUN=1 to write.'
    : 'Migration complete. Legacy jobs/<id>/hours.json kept in place — delete after verification.');
})().catch(e => { console.error(e); process.exit(1); });
