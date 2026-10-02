# Regression: a new job is missing from the jobs list ("already exists" on re-create)

**Incident (2026-10-01 → 2026-10-02).** "DCA 1 Epping road Lane cove - L4 Lobby
upgrade" (IV3383) was created at 10:48:15 UTC. It was in `jobs.json` and in
Postgres, but missing from `/v2/jobs` for a day, and creating it again said the
job already exists. The owner reported it had happened before.

## Cause

The admin list (`/api/jobs?withStats=1&statsOnly=1`) and the field list read
the derived cache `jobs-summary.json`, validated by comparing its
`builtFromUploadedAt` with `jobs.json`'s current upload time from `list()`
(API-fresh). The rebuild then read the *content* of `jobs.json` through Vercel
Blob's CDN, which can serve the **pre-overwrite** document for up to ~60s after
a write, even with a cache-busting query. The rebuild at 10:48:39 (22s after
the write) got the previous 18-job document and stamped it with the new upload
time, so every later read trusted it until the next `jobs.json` write.

The same flaw was in the per-job detail projection (`jobs/<id>/detail.json`)
and the admin PG extras: either could show pre-edit details after an edit.

## Fix

`api/_lib/source-freshness.js` checks the content's own storage stamp
`__updatedAt` (written by `blob-guards` just before the put) against the
upload time: 15s skew, 5-minute settle window, the same constants as
`api/_lib/payroll-inputs.js`. The summary rebuild retries briefly while the
content is stale. A cache built from stale content is still served for that
request but is **never persisted**, so the next read rebuilds. Tests:
`src/domains/jobs/jobs-summary.test.ts`, `job-detail-projection.test.ts` and
`job-detail-pg.test.ts` ("CDN-stale source content").

## If it happens again

1. Compare `jobs-summary.json`'s `builtFromUploadedAt` and record count with
   `jobs.json` (`list()` uploadedAt + `jobs.length`).
2. The summary is a derived cache, so deleting it is safe: the next list read
   rebuilds it. Back it up first (2026-10-02 backup:
   `backups/jobs-summary-stale-2026-10-02/`).
