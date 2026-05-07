#!/usr/bin/env node
// unify-birdwood-stages.js
//
// Converts Birdwood's per-dwelling stage data from the interim boolean shape
// to the unified three-state shape ("not_started" | "in_progress" | "complete"),
// and deletes legacy top-level stage keys.
//
// Dry-run by default; pass --apply to write.
//
// Usage:
//   node unify-birdwood-stages.js          # dry-run
//   node unify-birdwood-stages.js --apply  # write to Blob storage

// Load BLOB_READ_WRITE_TOKEN from Vercel's pulled env file
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

// Convert a legacy key → human-readable task name (same logic as recover script)
function humanise(k) {
  if (k.includes(' ')) return k;
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Convert boolean → three-state string
function boolToState(val) {
  if (val === true || val === 'true' || val === 1) return 'complete';
  return 'not_started';
}

// Convert any legacy status string → three-state string
function legacyStatusToState(val) {
  if (!val) return 'not_started';
  const s = (val.status || val || '').toString().toLowerCase();
  if (['done', 'complete', 'completed', 'yes', 'true', '1'].includes(s)) return 'complete';
  if (['in progress', 'in_progress', 'partial'].includes(s)) return 'in_progress';
  return 'not_started';
}

// Special keys to skip when collecting legacy stage keys
const SKIP_KEYS = new Set(['roughIn', 'fitOff', '_id', '_rev']);

async function main() {
  const apply = process.argv.includes('--apply');

  // ── Load data ──────────────────────────────────────────────────────────────
  const jobsData = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsData.jobs || []).find(
    j => j.id.includes('birdwood') || (j.name || '').toLowerCase().includes('birdwood')
  );
  if (!job) { console.error('\n❌  Birdwood job not found in jobs.json'); process.exit(1); }

  const dwData = await readBlob(`jobs/${job.id}/data.json`, { dwellings: {} });
  const dwellings = dwData.dwellings || {};

  // ── Existing task definitions ──────────────────────────────────────────────
  const existingRoughIn = job.roughInTasks || [];
  const existingFitOff  = job.fitOffTasks  || [];

  // Build name → existing task map for each stage
  const roughByName = {};
  existingRoughIn.forEach(t => { roughByName[t.name] = t; });
  const fitByName = {};
  existingFitOff.forEach(t => { fitByName[t.name] = t; });

  // ── Collect legacy keys from dwellings ────────────────────────────────────
  // Split: keys that look like rough-in vs fit-off
  // We'll treat any top-level key not in SKIP_KEYS as potentially legacy
  const legacyRoughKeys = new Set();
  const legacyFitKeys   = new Set();

  Object.values(dwellings).forEach(dw => {
    Object.keys(dw).forEach(k => {
      if (k.startsWith('_') || SKIP_KEYS.has(k)) return;
      // If this key (humanised) is already in roughByName, it's a rough-in legacy key
      if (roughByName[humanise(k)]) {
        legacyRoughKeys.add(k);
      } else {
        // Anything else we don't know about — treat as potential fit-off or unknown
        // For Birdwood we expect no fit-off legacy keys, but collect them anyway
        legacyFitKeys.add(k);
      }
    });
  });

  // ── Resolve final roughInTasks ─────────────────────────────────────────────
  // We keep existing definitions exactly — just verify they're all present
  // No new tasks are added in this script; the recover script already added them
  const finalRoughInTasks = existingRoughIn; // preserve ids and order

  // ── Resolve final fitOffTasks ──────────────────────────────────────────────
  // Start from existing definitions
  let finalFitOffTasks = [...existingFitOff];
  // If any unknown legacy keys were found, add them as new fit-off tasks
  const newFitTaskDefs = [];
  legacyFitKeys.forEach(k => {
    const name = humanise(k);
    if (!fitByName[name]) {
      const t = { id: nanoid('ft_'), name, _legacyKey: k };
      newFitTaskDefs.push(t);
      finalFitOffTasks.push({ id: t.id, name: t.name });
    }
  });

  // ── Convert dwellings ─────────────────────────────────────────────────────
  const convertedDwellings = {};

  // Track per-task status counts for summary
  const roughCounts = {}; // taskId → { not_started, in_progress, complete }
  finalRoughInTasks.forEach(t => { roughCounts[t.id] = { not_started: 0, in_progress: 0, complete: 0 }; });
  const fitCounts = {};
  finalFitOffTasks.forEach(t => { fitCounts[t.id] = { not_started: 0, in_progress: 0, complete: 0 }; });

  const dwIds = Object.keys(dwellings);

  dwIds.forEach(dwId => {
    const dw = dwellings[dwId];

    // ── Convert roughIn.tasks (booleans → three-state) ──────────────────
    const existingRoughTasks = (dw.roughIn && dw.roughIn.tasks) || {};
    const newRoughTasks = {};
    finalRoughInTasks.forEach(t => {
      const cur = existingRoughTasks[t.id];
      if (cur === 'not_started' || cur === 'in_progress' || cur === 'complete') {
        // Already three-state — preserve
        newRoughTasks[t.id] = cur;
      } else if (typeof cur === 'boolean' || cur === true || cur === false) {
        newRoughTasks[t.id] = boolToState(cur);
      } else {
        // No existing value — check if there's a legacy key we can fall back to
        const legacyKey = [...legacyRoughKeys].find(k => humanise(k) === t.name);
        if (legacyKey && dw[legacyKey] !== undefined) {
          newRoughTasks[t.id] = legacyStatusToState(dw[legacyKey]);
        } else {
          newRoughTasks[t.id] = 'not_started';
        }
      }
      roughCounts[t.id][newRoughTasks[t.id]]++;
    });

    // ── Convert fitOff.tasks ──────────────────────────────────────────────
    const existingFitTasks = (dw.fitOff && dw.fitOff.tasks) || {};
    const newFitTasks = {};
    finalFitOffTasks.forEach(t => {
      const cur = existingFitTasks[t.id];
      if (cur === 'not_started' || cur === 'in_progress' || cur === 'complete') {
        newFitTasks[t.id] = cur;
      } else if (typeof cur === 'boolean') {
        newFitTasks[t.id] = boolToState(cur);
      } else {
        const legacyKey = [...legacyFitKeys].find(k => humanise(k) === t.name);
        if (legacyKey && dw[legacyKey] !== undefined) {
          newFitTasks[t.id] = legacyStatusToState(dw[legacyKey]);
        } else {
          newFitTasks[t.id] = 'not_started';
        }
      }
      if (fitCounts[t.id]) fitCounts[t.id][newFitTasks[t.id]]++;
    });

    // ── Build cleaned dwelling (strip legacy top-level keys) ─────────────
    const cleanDw = {};
    Object.keys(dw).forEach(k => {
      if (legacyRoughKeys.has(k) || legacyFitKeys.has(k)) return; // delete legacy
      cleanDw[k] = dw[k];
    });
    cleanDw.roughIn = { ...(dw.roughIn || {}), tasks: newRoughTasks };
    if (finalFitOffTasks.length) {
      cleanDw.fitOff = { ...(dw.fitOff || {}), tasks: newFitTasks };
    }

    convertedDwellings[dwId] = cleanDw;
  });

  // ── Dry-run report ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(65));
  console.log('  Birdwood Stage Unification' + (apply ? ' — APPLYING' : ' — DRY RUN'));
  console.log('='.repeat(65));
  console.log('\nJob: ' + job.name + ' (' + job.id + ')');
  console.log('Dwellings: ' + dwIds.length);

  console.log('\n── Final roughInTasks ────────────────────────────────────────');
  if (!finalRoughInTasks.length) {
    console.log('  (none)');
  } else {
    finalRoughInTasks.forEach((t, i) => {
      const src = legacyRoughKeys.has(t.name)
        ? `← legacy key preserved`
        : existingRoughIn.find(e => e.id === t.id) ? '← existing (no legacy key)' : '← NEW';
      console.log(`  [${i + 1}] id: ${t.id}  name: "${t.name}"  ${src}`);
    });
  }

  console.log('\n── Final fitOffTasks ─────────────────────────────────────────');
  if (!finalFitOffTasks.length) {
    console.log('  (none — fitOffTasks stays empty)');
  } else {
    finalFitOffTasks.forEach((t, i) => {
      const isNew = newFitTaskDefs.find(n => n.id === t.id);
      console.log(`  [${i + 1}] id: ${t.id}  name: "${t.name}"  ${isNew ? '← from legacy key "' + isNew._legacyKey + '"' : '← existing'}`);
    });
  }

  console.log('\n── Legacy keys to DELETE from each dwelling ─────────────────');
  const allLegacyToDelete = [...legacyRoughKeys, ...legacyFitKeys];
  if (!allLegacyToDelete.length) {
    console.log('  (none found)');
  } else {
    allLegacyToDelete.forEach(k => {
      const count = dwIds.filter(id => dwellings[id][k] !== undefined).length;
      console.log(`  "${k}"  (present on ${count} dwelling(s))`);
    });
  }

  // Sample dwelling: first one
  const sampleId = dwIds[0];
  const sampleBefore = dwellings[sampleId];
  const sampleAfter = convertedDwellings[sampleId];
  console.log(`\n── Sample dwelling: ${sampleId} ─────────────────────────────`);
  console.log('  BEFORE:');
  console.log('  ' + JSON.stringify(sampleBefore, null, 2).split('\n').join('\n  '));
  console.log('\n  AFTER:');
  console.log('  ' + JSON.stringify(sampleAfter, null, 2).split('\n').join('\n  '));

  console.log('\n── Per-task status counts (rough-in) ────────────────────────');
  if (!finalRoughInTasks.length) {
    console.log('  (no roughInTasks)');
  } else {
    finalRoughInTasks.forEach(t => {
      const c = roughCounts[t.id] || {};
      console.log(`  "${t.name}" (${t.id}): complete=${c.complete||0}  in_progress=${c.in_progress||0}  not_started=${c.not_started||0}`);
    });
  }

  console.log('\n── Per-task status counts (fit-off) ─────────────────────────');
  if (!finalFitOffTasks.length) {
    console.log('  (no fitOffTasks)');
  } else {
    finalFitOffTasks.forEach(t => {
      const c = fitCounts[t.id] || {};
      console.log(`  "${t.name}" (${t.id}): complete=${c.complete||0}  in_progress=${c.in_progress||0}  not_started=${c.not_started||0}`);
    });
  }

  if (!apply) {
    console.log('\n✅  Dry run complete. Run with --apply to write.\n');
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  console.log('\n── Writing ───────────────────────────────────────────────────');

  // 1. Update jobs.json — set final task lists (no change to roughInTasks, fitOffTasks may gain tasks)
  job.roughInTasks = finalRoughInTasks;
  job.fitOffTasks  = finalFitOffTasks;
  await writeBlob('jobs.json', jobsData);
  console.log('  ✓ jobs.json updated');

  // 2. Update data.json
  const newDwData = { ...dwData, dwellings: { ...dwData.dwellings, ...convertedDwellings } };
  await writeBlob(`jobs/${job.id}/data.json`, newDwData);
  console.log('  ✓ data.json updated (' + Object.keys(convertedDwellings).length + ' dwellings)');

  console.log('\n✅  Applied.');
  console.log(`    ${dwIds.length} dwellings converted, ${allLegacyToDelete.length} legacy key(s) deleted per dwelling.\n`);
}

main().catch(e => {
  console.error('\n❌  Error:', e.message);
  process.exit(1);
});
