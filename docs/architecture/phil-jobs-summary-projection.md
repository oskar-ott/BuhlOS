# Phil jobs-summary read projection

**Status:** shipped dark behind `phil_jobs_summary_read` (default OFF, unset in
prod). Performance read-model only — **not** an architecture change, **not** the
Supabase jobs migration (that remains "MIGRATE-LATER" per
[supabase-migration-roadmap.md](supabase-migration-roadmap.md)).

## Problem

Authenticated mobile measurement proved Phil LCP is server/data-read bound. The
single dominant cost is `GET /api/jobs`: it reads + parses the whole `jobs.json`
monolith (~3.5s uncached — `readBlob` is `list()`+`fetch()` per key, 5s
per-instance cache, cold on a field worker's first load) only to emit a small
per-worker job **list**. The field list consumers (`/phil/my-day`, `/phil/jobs`,
`/phil/hours`) read just `id, name, status, ref, siteAddress` (+ the two live
stats on `withStats`); none read job **structure** (`areaGroups`/tasks) from the
list. The monolith read is the bottleneck gating those routes.

## What this is

A small **derived Blob projection**, `jobs-summary.json`, holding one lightweight
record per job — the field-kept **superset** MINUS heavy structure
(`areaGroups`, `roughInTasks`, `fitOffTasks`, `customFields`, `temps`) and **all
money fields**. `typeName` is pre-resolved at build time. See
[`api/_lib/jobs-summary.js`](../../api/_lib/jobs-summary.js).

Temporary by design: it exists to cut LCP now, on the Blob backend. When the
jobs domain eventually moves to Postgres (roadmap Phase 3), a real PG jobs read
replaces both this and the monolith read, and this projection is deleted.

## How it stays correct (never silently stale)

- **Lazy, read-side rebuild.** On a field/LH **plain list** GET (no `?id`, no
  `?withStats`) with the flag on, the handler reads the summary and validates its
  `builtFromUploadedAt` against `jobs.json`'s **current** blob `uploadedAt` (a
  metadata-only `list()`, no content fetch — `blobUploadedAt`). Match → serve it.
  Mismatch / missing / unreadable → read the full `jobs.json` (the fallback),
  rebuild, best-effort persist, serve the fresh records.
- **No write-path change.** `jobs.json` is written from 8+ places; every one
  advances its `uploadedAt` via `writeBlob`→`put`, so any write invalidates the
  summary on the next read. Nothing maintains the summary on write.
- **Blob stays authoritative.** The summary is a disposable cache; a persist
  failure still serves the freshly-built records, and any error in the summary
  path falls through to the full `jobs.json` read.
- **Parity by construction.** The per-viewer transforms run unchanged on top:
  `assignedJobIds` visibility filter (from `users.json`, never on the job row)
  and `redactJobForViewer(record, role)` — so LH still sees `scopeOfWork`, a
  plain field worker doesn't, and money (already omitted from the record) can
  never leak.

## Scope (what is NOT summary-served)

- `?withStats=1` (`/phil/jobs`) — task stats need `areaGroups`; kept on the full
  read. A follow-up can compute the two live field stats (snags/ITPs) from the
  summary + per-job reads.
- Single-job `?id=` GET (job detail) — needs full structure.
- Admin and client tiers — different visibility; kept on the full read.
- When `supabase_read_phil_jobs` is ON — the two field overlays must not stack;
  the summary path no-ops.

## Read contract (extend the summary if this changes)

The field **list** must return `id, name, status, ref, siteAddress, typeName`
(+ `scopeOfWork` for LH, redacted away for plain field). If a future field-list
consumer needs a job field not in the summary record, **add it to the superset**
in `buildJobsSummary` (or use the `?id=` detail read) — a missing field reads as
`undefined`, it does not fall back per-field.

## Enable / rollback

Enable via the env flag `FLAG_PHIL_JOBS_SUMMARY_READ=true` (Vercel env; preview
scope to verify, then production). Disable by unsetting it — the next request
reverts to the full read (byte-identical to pre-flag behaviour). No deploy or
data change is needed either way.
