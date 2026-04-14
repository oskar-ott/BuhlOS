#!/usr/bin/env node
// seed-birdwood-checklist.js
// Sets Birdwood's roughInTasks to ['Mark out core hole'].
// Dry-run by default; pass --apply to write.
//
// Usage:
//   node seed-birdwood-checklist.js
//   node seed-birdwood-checklist.js --apply

// Load production env vars (BLOB_READ_WRITE_TOKEN) from Vercel's pulled env file
try {
  const fs = require('fs');
  const envFile = '.vercel/.env.production.local';
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
  }
} catch (e) { /* ignore */ }

const { readBlob, writeBlob } = require('./api/_lib/blob');

// 8-char base36 id generator
function nanoid(prefix) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * 36)];
  return prefix + s;
}

async function main() {
  const apply = process.argv.includes('--apply');
  // Accept job ID as argument, or fall back to finding any job with "birdwood" in name/id
  const argId = process.argv.find(a => !a.startsWith('-') && !a.includes('seed') && !a.includes('node'));
  const data = await readBlob('jobs.json', { jobs: [] });
  const job = argId
    ? (data.jobs || []).find(j => j.id === argId)
    : (data.jobs || []).find(j => j.id.includes('birdwood') || (j.name||'').toLowerCase().includes('birdwood'));

  if (!job) {
    console.error('\n❌  Job "birdwood" not found in jobs.json');
    process.exit(1);
  }

  const taskId = nanoid('rt_');
  const roughInTasks = [{ id: taskId, name: 'Mark out core hole' }];

  // Count dwellings with data
  const dwData = await readBlob(`jobs/${job.id}/data.json`, { dwellings: {} });
  const dwKeys = Object.keys(dwData.dwellings || {});

  console.log('\n' + '='.repeat(60));
  console.log('  Birdwood Checklist Seed' + (apply ? ' — APPLYING' : ' — DRY RUN'));
  console.log('='.repeat(60));
  console.log('\nJob          :', job.name, `(${job.id})`);
  console.log('Status       :', job.status || 'active');
  console.log('\nCurrent roughInTasks :', JSON.stringify(job.roughInTasks || []));
  console.log('Current fitOffTasks  :', JSON.stringify(job.fitOffTasks || []));
  console.log('\nProposed roughInTasks:', JSON.stringify(roughInTasks));
  console.log('Proposed fitOffTasks :', '[] (unchanged)');
  console.log('\nDwellings in data.json:', dwKeys.length || '0 (none recorded yet)');

  console.log('\n' + '!'.repeat(60));
  console.log('  ⚠️  WARNING: 0% progress after seeding');
  console.log('!'.repeat(60));
  console.log('\n  After seeding, ALL dwellings show 0% rough-in progress.');
  console.log('  The single task "Mark out core hole" is unchecked for every');
  console.log('  dwelling until a tradie ticks it in the app.');
  if (dwKeys.length) {
    console.log(`\n  ${dwKeys.length} dwelling(s) with existing data:`);
    dwKeys.forEach(k => console.log('    •', k));
    console.log('\n  Their existing legacy stage data is PRESERVED (lazy migration).');
    console.log('  The new roughIn.tasks field will be independent of old data.');
  }
  console.log('\n' + '!'.repeat(60));

  if (!apply) {
    console.log('\n✅  Dry run complete. Run with --apply to write to Blob storage.\n');
    return;
  }

  // Apply
  job.roughInTasks = roughInTasks;
  if (!job.fitOffTasks) job.fitOffTasks = [];
  await writeBlob('jobs.json', data);

  console.log('\n✅  Applied. Birdwood roughInTasks updated in jobs.json.');
  console.log('    Task ID:', taskId, '— "Mark out core hole"\n');
}

main().catch(e => {
  console.error('\n❌  Error:', e.message);
  process.exit(1);
});
