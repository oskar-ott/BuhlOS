#!/usr/bin/env node
// recover-birdwood-roughin.js
//
// Reads Birdwood's existing legacy rough-in stage data, seeds roughInTasks
// from the unique stage keys found, appends "Mark out core hole", and converts
// each dwelling's legacy stage statuses to the new roughIn.tasks boolean shape.
//
// Legacy keys are preserved untouched alongside the new tasks object.
//
// Usage:
//   node recover-birdwood-roughin.js          # dry-run
//   node recover-birdwood-roughin.js --apply  # write to Blob storage

// Load BLOB_READ_WRITE_TOKEN from Vercel's pulled env file (no dotenv dependency)
try {
  const fs = require('fs');
  const envFile = '.vercel/.env.production.local';
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
  }
} catch (_) {}

const { readBlob, writeBlob } = require('./api/_lib/blob');

// 8-char base36 id
function nanoid(prefix) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * 36)];
  return prefix + s;
}

// Convert legacy key → human-readable task name.
// Keys here are already human-readable ("AC Rough-In", "Lighting Rough-In"),
// so if a key contains spaces we return it unchanged.
// If it were snake_case we'd convert: underscores→spaces, title-case.
function humanise(k) {
  if (k.includes(' ')) return k;                                         // already readable
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());   // snake_case fallback
}

// Determine whether a legacy stage value counts as "complete".
function isComplete(val) {
  if (!val) return false;
  const s = (val.status || val || '').toString().toLowerCase();
  return ['done', 'complete', 'completed', 'yes', 'true', '1'].includes(s);
}

async function main() {
  const apply = process.argv.includes('--apply');

  // ── Load data ──────────────────────────────────────────────────────────
  const jobsData = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsData.jobs || []).find(
    j => j.id.includes('birdwood') || (j.name || '').toLowerCase().includes('birdwood')
  );
  if (!job) { console.error('\n❌  Birdwood job not found in jobs.json'); process.exit(1); }

  const dwData = await readBlob(`jobs/${job.id}/data.json`, { dwellings: {} });
  const dwellings = dwData.dwellings || {};

  // ── Collect unique legacy stage keys (top-level, non-special) ─────────
  // Special keys to skip: _*, roughIn, fitOff (already-migrated keys)
  const legacyKeySet = new Set();
  Object.values(dwellings).forEach(dw => {
    Object.keys(dw).forEach(k => {
      if (!k.startsWith('_') && k !== 'roughIn' && k !== 'fitOff') {
        legacyKeySet.add(k);
      }
    });
  });
  const legacyKeys = [...legacyKeySet]; // ordered by first appearance

  // ── Build roughInTasks: legacy stages first, then "Mark out core hole" ─
  // We generate IDs now and keep them stable for both the dry-run printout
  // and the --apply write, so the mapping is consistent.
  const legacyTaskDefs = legacyKeys.map(k => ({
    id: nanoid('rt_'),
    name: humanise(k),
    _legacyKey: k,         // internal: which legacy key this task came from
  }));
  const coreHoleTask = { id: nanoid('rt_'), name: 'Mark out core hole', _legacyKey: null };
  const allTaskDefs = [...legacyTaskDefs, coreHoleTask];

  // Build a map: legacyKey → taskDef (for conversion step)
  const keyToTask = {};
  legacyTaskDefs.forEach(t => { keyToTask[t._legacyKey] = t; });

  // ── Collect per-dwelling status values for the dry-run table ──────────
  const dwRows = Object.entries(dwellings).map(([dwId, dw]) => {
    const legacyVals = {};
    legacyKeys.forEach(k => { legacyVals[k] = dw[k] ? (dw[k].status || dw[k]) : '—'; });
    return { dwId, dw, legacyVals };
  });

  // ── Build converted dwellings (roughIn.tasks added) ───────────────────
  const convertedDwellings = {};
  dwRows.forEach(({ dwId, dw, legacyVals }) => {
    const tasks = {};
    allTaskDefs.forEach(t => { tasks[t.id] = false; }); // default: all unchecked
    legacyTaskDefs.forEach(t => {
      const val = dw[t._legacyKey];
      if (val !== undefined) tasks[t.id] = isComplete(val);
    });
    // coreHoleTask always starts false (already set above)
    convertedDwellings[dwId] = {
      ...dw,
      roughIn: { ...(dw.roughIn || {}), tasks },
    };
  });

  // ── Summary counts ─────────────────────────────────────────────────────
  const totalDw = Object.keys(dwellings).length;
  const updatedDw = dwRows.length;
  const dwWithComplete = dwRows.filter(({ dw }) =>
    legacyKeys.some(k => dw[k] && isComplete(dw[k]))
  ).length;

  // ── Print dry-run report ───────────────────────────────────────────────
  console.log('\n' + '='.repeat(65));
  console.log('  Birdwood Rough-In Recovery' + (apply ? ' — APPLYING' : ' — DRY RUN'));
  console.log('='.repeat(65));
  console.log('\nJob: ' + job.name + ' (' + job.id + ')');

  console.log('\n── Legacy rough-in keys found in data.json ──────────────────');
  if (!legacyKeys.length) {
    console.log('  (none — no legacy stage keys found)');
  } else {
    legacyKeys.forEach(k => {
      const dwWithKey = dwRows.filter(r => r.dw[k] !== undefined).length;
      const completedCount = dwRows.filter(r => r.dw[k] && isComplete(r.dw[k])).length;
      const allVals = [...new Set(dwRows.filter(r=>r.dw[k]).map(r=>r.dw[k].status||r.dw[k]))];
      console.log(`  "${k}"  →  ${dwWithKey} dwellings, values: ${JSON.stringify(allVals)}, ${completedCount} complete`);
    });
  }

  console.log('\n── Proposed roughInTasks ────────────────────────────────────');
  allTaskDefs.forEach((t, i) => {
    const src = t._legacyKey ? `← legacy key "${t._legacyKey}"` : '← NEW (starts false everywhere)';
    console.log(`  [${i + 1}] id: ${t.id}  name: "${t.name}"  ${src}`);
  });

  console.log('\n── Per-dwelling conversion preview ──────────────────────────');
  console.log('  ' + ['Dwelling'.padEnd(18), ...allTaskDefs.map(t => t.name.substring(0, 12).padEnd(14))].join(' '));
  dwRows.forEach(({ dwId, dw }) => {
    const cells = allTaskDefs.map(t => {
      if (t._legacyKey === null) return 'false         '; // core hole always false
      const val = dw[t._legacyKey];
      if (val === undefined) return '(no data)     ';
      const done = isComplete(val);
      return (done ? 'true' : 'false') + ' (' + (val.status || val) + ')  ';
    });
    console.log('  ' + dwId.padEnd(18) + ' ' + cells.map(c => c.substring(0, 14).padEnd(14)).join(' '));
  });

  console.log('\n── Summary ──────────────────────────────────────────────────');
  console.log(`  Total dwellings in data.json : ${totalDw}`);
  console.log(`  Dwellings with legacy data   : ${updatedDw}`);
  console.log(`  Tasks to seed                : ${allTaskDefs.length} (${legacyTaskDefs.length} from legacy + 1 new)`);
  console.log(`  Dwellings with ≥1 complete   : ${dwWithComplete}`);

  if (!apply) {
    console.log('\n✅  Dry run complete. Run with --apply to write.\n');
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────
  console.log('\n── Writing ──────────────────────────────────────────────────');

  // 1. Update jobs.json — set roughInTasks (strip internal _legacyKey before writing)
  job.roughInTasks = allTaskDefs.map(({ id, name }) => ({ id, name }));
  if (!job.fitOffTasks) job.fitOffTasks = [];
  await writeBlob('jobs.json', jobsData);
  console.log('  ✓ jobs.json updated (' + job.roughInTasks.length + ' roughInTasks)');

  // 2. Update data.json — write converted dwellings
  const newDwData = { ...dwData, dwellings: { ...dwData.dwellings, ...convertedDwellings } };
  await writeBlob(`jobs/${job.id}/data.json`, newDwData);
  console.log('  ✓ data.json updated (' + Object.keys(convertedDwellings).length + ' dwellings)');

  console.log('\n✅  Applied.');
  console.log(`    ${allTaskDefs.length} tasks seeded, ${updatedDw} dwellings updated, ${dwWithComplete} had ≥1 complete task.\n`);
}

main().catch(e => {
  console.error('\n❌  Error:', e.message);
  process.exit(1);
});
