#!/usr/bin/env node
// Restore a canonical JSON store from a snapshot (#151).
//
// DRY-RUN BY DEFAULT — nothing is written without --apply, and an --apply
// always copies the current live document to backups/pre-restore-<ts>/…
// before overwriting, so a restore is itself restorable.
//
// Usage (needs BLOB_READ_WRITE_TOKEN in the environment):
//   node scripts/backup-restore.js --list
//   node scripts/backup-restore.js --date 2026-06-11 --docs
//   node scripts/backup-restore.js --date 2026-06-11 --doc users.json
//   node scripts/backup-restore.js --date 2026-06-11 --doc users.json --apply
//   node scripts/backup-restore.js --date 2026-06-11 --all            (dry-run the full set)
//   node scripts/backup-restore.js --date 2026-06-11 --all --apply
//
// Runbook + drill notes: docs/backups.md. Note the 5s cross-instance read
// cache in api/_lib/blob.js — running app instances may serve the pre-restore
// document for up to ~5 seconds after an apply.

const {
  listSnapshotDates,
  listSnapshotDocuments,
  restoreDocument,
} = require('../api/_lib/backup');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    fail('BLOB_READ_WRITE_TOKEN is not set (pull it with `vercel env pull` or export it).');
  }

  if (arg('list')) {
    const dates = await listSnapshotDates();
    if (!dates.length) return console.log('No snapshots found under backups/.');
    console.log('Snapshots:');
    for (const d of dates) console.log(`  ${d}`);
    return;
  }

  const date = arg('date');
  if (!date || date === true) fail('--date YYYY-MM-DD is required (or --list).');

  if (arg('docs')) {
    const docs = await listSnapshotDocuments(date);
    if (!docs.length) return console.log(`No documents in snapshot ${date}.`);
    console.log(`Documents in ${date} (${docs.length}):`);
    for (const d of docs) console.log(`  ${d}`);
    return;
  }

  const apply = !!arg('apply');
  const docs = arg('all') ? await listSnapshotDocuments(date) : [arg('doc')];
  if (!docs[0] || docs[0] === true) fail('--doc <pathname> or --all is required.');

  if (apply) {
    console.log(`!! APPLY mode — ${docs.length} document(s) will be overwritten`);
    console.log('!! current versions are first copied to backups/pre-restore-<ts>/…\n');
  }

  let restored = 0;
  for (const doc of docs) {
    try {
      const r = await restoreDocument({ date, pathname: doc, apply });
      const d = r.diff;
      const cur = d.current.exists
        ? `current ${d.current.bytes}B ${JSON.stringify(d.current.shape)}`
        : 'current MISSING';
      const mark = r.applied ? 'RESTORED' : d.identical ? 'identical (no-op)' : 'DRY-RUN';
      console.log(`${mark}  ${doc}`);
      console.log(`         backup  ${d.backup.bytes}B ${JSON.stringify(d.backup.shape)}`);
      console.log(`         ${cur}`);
      if (d.preRestoreCopy) console.log(`         safety  ${d.preRestoreCopy}`);
      if (r.applied) restored += 1;
    } catch (e) {
      console.error(`FAILED   ${doc} — ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(
    apply
      ? `\nDone — ${restored}/${docs.length} restored.`
      : `\nDry run only — re-run with --apply to write.`,
  );
}

main().catch((e) => fail(e.message));
