# Blob backups & restore (#151)

Every piece of business state lives in mutable whole-document JSON blobs that
are overwritten in place on every write. Vercel Blob durability protects
against infrastructure loss — **not against us**. This system makes a bad
write cost at most one day of changes instead of the whole business state.

## What runs

A Vercel cron hits `GET /api/backup-snapshot?action=run` **daily at 16:00 UTC
(2am Sydney)**. Each run:

1. Enumerates every canonical JSON store from the **manifest**
   ([api/_lib/backup-manifest.js](../api/_lib/backup-manifest.js)) — exact
   top-level documents (`users.json`, `jobs.json`, `observations.json`, …) plus
   prefix stores (`jobs/`, `users/` time-entries, `audit/`, `quotes/`,
   `suppliers/`, …).
2. Server-side-copies each document to an immutable, never-overwritten path:
   `backups/<yyyy-mm-dd>/<original-path>`.
3. Prunes old snapshots: keeps the **newest 14 daily** sets plus **Monday sets
   within 8 weeks**; anything it doesn't recognise (e.g. `pre-restore-*`
   safety copies) is never deleted.
4. Writes a `backup.completed` audit entry (action visible in the activity
   feed as "Ran data backup") with counts in metadata — success **and**
   failure, so a quiet cron can't hide a broken backup. Any copy failure makes
   the run return HTTP 500, which shows red in Vercel's cron log.

**Exclusions (deliberate):** binaries (evidence / snag / ITP / office photos)
are write-once under fresh keys — they are never overwritten in place, so the
clobber risk doesn't apply and they'd dwarf the snapshots. The `backups/`
prefix itself is never re-snapshotted and never read by the app.

**Auth:** the cron authenticates with `CRON_SECRET` (Bearer or
`x-cron-secret`). Deliberately stricter than other crons: a **missing**
`CRON_SECRET` does not open the endpoint — manual runs then require an
admin-tier login (`?action=run` from a logged-in admin works for a pre-deploy
safety snapshot).

## The manifest guard

`npm run check:backup-manifest` (runs in CI) statically extracts every
`writeBlob` key in `api/` — literals, template prefixes, key-builder
functions — and **fails the build** if the app writes a store the manifest
doesn't cover. Adding a store means adding a manifest line in the same PR.
(The guard found a real gap on day one: `suppliers/<id>/products.json`.)

## Restore — runbook

Restores live in [scripts/backup-restore.js](../scripts/backup-restore.js),
deliberately NOT exposed over HTTP. You need `BLOB_READ_WRITE_TOKEN`
(`vercel env pull`, or copy from the Vercel dashboard).

```bash
# 1. What snapshots exist?
node scripts/backup-restore.js --list

# 2. What's inside one?
node scripts/backup-restore.js --date 2026-06-11 --docs

# 3. ALWAYS dry-run first — shows backup vs current size + shape, writes nothing
node scripts/backup-restore.js --date 2026-06-11 --doc users.json

# 4. Apply — copies the CURRENT doc to backups/pre-restore-<ts>/… first,
#    then writes the snapshot content back to the canonical key
node scripts/backup-restore.js --date 2026-06-11 --doc users.json --apply

# Whole-set restore (use sparingly; dry-run prints every document first)
node scripts/backup-restore.js --date 2026-06-11 --all
node scripts/backup-restore.js --date 2026-06-11 --all --apply
```

Notes:

- Every `--apply` is itself restorable: the pre-restore copy preserves the
  state you replaced.
- **Cache staleness:** `api/_lib/blob.js` has a ~5s cross-instance read cache;
  running app instances may serve the pre-restore document for up to ~5
  seconds after an apply. Restores write through `writeBlob`, so the writing
  instance is consistent immediately.
- Restoring `users.json` logs nobody out (sessions are HMAC cookies), but
  role/assignment changes made after the snapshot are rolled back — check the
  audit feed for writes made between snapshot and restore.

## The restore drill

The drill required by #151 runs **on every CI build** against a
non-production (in-memory harness) store:
[src/domains/backups/backup-api.test.ts](../src/domains/backups/backup-api.test.ts)
→ *"restore drill"*: snapshot → clobber `users.json` → dry-run (asserted to
write nothing) → apply → **byte-identical recovery**, with the pre-restore
safety copy verified. If a refactor ever breaks the restore path, CI goes red
— the drill can't be forgotten.

For a production drill (recommended once after first deploy): run step 3
above against a real snapshot (dry-run only) and confirm the shape summary
matches expectations; the write path is already CI-proven.

## Failure detection

- Failed run → HTTP 500 → red in the Vercel cron dashboard.
- Every run (ok or failed) → `backup.completed` audit entry with
  `metadata.ok`, copy/failure counts and pruned dates.
- A *missed* run leaves no entry — heartbeat alerting lands with the
  monitoring issue (#159).
