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

- **Lazy, read-side rebuild.** On a field/LH **list** GET (no `?id`; with or
  without `?withStats`) with the flag on, the handler reads the summary and validates its
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

## `?withStats=1` (the `/phil/jobs` chips)

Served on the summary path too. The field list renders exactly two stats
(`statsSnagsV2Active`, `statsItpsActive` — see `philJobsListSignals`), which
derive from the per-job `data.json` (`snagsV2[]`) and `itps.json` (`instances[]`)
— **not** `areaGroups`. So `readFieldJobStats` reads just those two blobs per
visible job (in parallel, fail-soft → `{0,0}`) and attaches the counts; the
counts come from the SHARED `countActiveSnagsV2` / `countActiveItps` helpers that
the full-read `enrichJobsWithStats` also uses, so the two paths can't diverge.
**Task/area stats (`statsTasksTotal`, `statsPct`, …) are deliberately NOT served**
on this path — they need `areaGroups`, and the field list never reads them.

## Job-detail fast shell (a second consumer)

`/phil/jobs/[jobId]` (`src/app/phil/jobs/[jobId]/page.tsx`) renders a
summary-backed **shell** above the fold while the full job structure streams in
below. It reads the worker's `/api/jobs` list (this summary), finds the job by
id for the header (name/status/ref/site/type — visibility-scoped + redacted by
construction), and renders `PhilJobDetailShell` as the `<Suspense>` fallback; the
existing full read + `PhilJobDetail` render move into a streamed
`PhilJobDetailFull` (authoritative for visibility + full task/stage/proof
structure — **unchanged**). Gated by the **same** `FLAG_PHIL_JOBS_SUMMARY_READ`
env flag: flag-off reverts to the prior single-read behaviour (no shell), so the
flag is a clean rollback for this too. The single-job `?id=` read itself is made
fast by the **job-detail structure projection** below — the slice that makes the
*streamed* detail fast, not just the shell.

## Job-detail structure projection (a third consumer)

The single-job `?id=` GET behind `/phil/jobs/[jobId]` had to read+parse the whole
`jobs.json` monolith (~3.5s) to return ONE job's structure. The structure-bearing
sibling of the list summary — [`api/_lib/job-detail-projection.js`](../../api/_lib/job-detail-projection.js)
— derives a small **per-job** blob `jobs/<id>/field-detail.json` and serves the
field/leading-hand single-job read from it.

- **Same safety contract** as the list summary: lazily rebuilt on read,
  freshness-gated (`builtFromUploadedAt` vs `jobs.json`'s `uploadedAt` via the
  metadata-only `blobUploadedAt`), best-effort persist, full-monolith fallback on
  any miss/stale/error, no write-path change.
- **Stored record = the job MINUS money** (the `adminTier` audience derived from
  `job-redaction.js`'s `FIELD_AUDIENCE`, so it can't drift). All structure +
  `scopeOfWork` are kept; the call site then runs the **same**
  `projectJobStructure` + `effectiveModules` + `redactJobForViewer` pipeline the
  full read runs, on this small record — so the response is **byte-identical** to
  the full path (modulo money, which field/LH never see).
- **Scope:** field/LH, an **assigned** job, and **no** `?withStats` / no
  `?includeArchived` (admin-only knobs → full read). Admin/client, draft/archived,
  unassigned, and any error all **fall through to the authoritative full read**
  (the one place that enforces 404/403 + every visibility rule).
- Gated by the **same** `FLAG_PHIL_JOBS_SUMMARY_READ` env flag (one rollback
  switch for the whole Phil-jobs-read perf family; activated in prod already).
- The key lives under the existing `jobs/` per-job namespace, already covered by
  the backup-manifest `PREFIX_STORES` — no manifest change.

## Scope (what is NOT projection-served)

- Single-job `?id=` GET **with `?withStats=1` or `?includeArchived=1`** — admin/hub
  knobs; kept on the full read.
- Admin and client tiers — different visibility; kept on the full read.

## Coexistence with the Supabase PG read (`supabase_read_phil_jobs`)

The summary path **takes precedence** over the J7 `supabase_read_phil_jobs` PG
overlay for the field plain LIST. Rationale: the overlay rides *on top of* the
full `jobs.json` read (it does not remove the ~3.5s monolith fetch), so it does
not fix LCP; the summary does. This is safe because the summary is built from the
**same Blob spine (`jobs.json`)** the overlay falls back to, and `jobs.json` is
kept current by `supabase_dual_write_jobs` — so the field list reads the
dual-written, drift-alarmed Blob spine via the summary, while **PG remains the
truth for admin reads + dual-write**. The only divergence is the rare
dual-write-failure window (PG truth, Blob stale, drift-alarmed), where the field
list would briefly reflect the Blob spine — the accepted trade for the LCP win.
The **job-detail structure projection** takes the same precedence for the field
single-job read, for the same reason (it rides the dual-written Blob spine; PG
stays truth for admin). Unlike the list summary, the detail path **does** run
`projectJobStructure` + `effectiveModules` on the record (the full structure is
kept), so `modules` is hydrated there exactly as on the full read.

> Note: `modules` is passed through **un-hydrated** on the summary path (no
> `effectiveModules`/`projectJobStructure` applied), unlike the full-read list
> branch. Inert today — no field-list consumer reads `modules` — but a future
> list consumer that does would need it added to `buildJobsSummary`.

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
