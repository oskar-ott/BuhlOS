# J8.75 — Legacy job structure normalization

Part of the Blob→Postgres migration (#152). **J8.5 found the real bottleneck:**
the structure data is in sync (the importer-projection sync-check is IN SYNC), but
the J6/J7 read overlays use an **order-sensitive, byte-identical** parity gate, so
legacy jobs that are *data-equivalent but representation-drifted* fall back to
Blob. J8.75 closes that gap so the already-shipped read overlays become
load-bearing on the existing fleet — **without changing data, schema,
architecture, or task migration.**

> Data parity = good. Representation parity = the bottleneck. J8.75 fixes
> representation parity only.

## What "representation drift" was (measured on dev)

Diagnosed precisely on the 6 non-faithful dev jobs — purely representational, no
genuine value differences and no extra fields:

- **`"" → null`** header scalars (blob empty-string vs the importer's `strOrNull`).
- **missing default fields** — sparse area/group/template records lacking the
  canonical `order:0`, `archived:false`, `spaceType:null`, `roughInTasks:[]`,
  `fitOffTasks:[]` the reconstruction always includes.
- **array order** — blob arrays not in the reconstruction's `(sort_order,
  legacy_id)` order.

## The normalizer (pure + safe)

`scripts/importers/lib/normalize-job-structure.js` — `normalizeJobStructure(blobJob,
pgReconJob)`. It adopts the **canonical migrated fields from the PG reconstruction**
(the blob's own data, imported then reconstructed, proven IN SYNC) onto the **Blob
spine**, so every Blob-only field is preserved. It commits a job only if **all
three guards** pass, else leaves it untouched (Blob-served, safe):

1. **byte-faithful** — the result hashes equal to the PG reconstruction, so the
   read overlay will serve it from PG (the goal);
2. **migrated data unchanged** — the importer-projection fingerprint of the result
   equals the original's, so no migrated value is altered (catches a job whose
   data genuinely drifted from PG, and any scalar that adopting PG's value would
   lose) — never overwrite real data with a stale mirror;
3. **no field dropped** — the blob's structural objects use only canonical keys, so
   a job carrying nested Blob-only fields (area `customFields`, `archivedAt/By`,
   …) is skipped rather than have them dropped.

`scripts/importers/normalize-jobs.js` is the operator runner (dry-run / `--write`
/ `--json`), modelled on the importers — **not wired to any route/deploy/cron**.
The only write is `jobs.json`; Postgres is read-only (the importer-projection is
unchanged, so no re-mirror is needed). Idempotent: a second run normalizes 0 jobs.

## Dev application (proof)

Run against the dev project:

- **Before:** admin read = **3/9** jobs PG-faithful; dry-run = **6 normalizable, 0
  skipped**.
- **After `--write`:** admin read = **9/9** PG-faithful; **sync-check IN SYNC**;
  **blob-only + header fields preserved**; re-run = **0 normalizable** (idempotent).

So the J6/J7 read overlays are now load-bearing on the **entire** dev fleet, not
just the 3 already-canonical jobs — exactly the J8.5 bottleneck, closed. (Cross-
process Vercel Blob CDN propagation lag made staged reads noisy; the in-process,
read-after-write-consistent checks are the reliable evidence, matching the live
path where the mirror runs in-process.)

## Safety / scope

- **No data change.** Guards (2)+(3) make every committed job data-equivalent to
  its original (representation-only). The structure sync-check is IN SYNC after.
- **No schema, no architecture, no task migration, no new behaviour.** The
  canonical shape is the *existing* reconstruction; the UI already renders
  structure sorted by `order` with defaulted fields, so normalization is
  behaviour-preserving.
- **Conservative.** Any job that isn't provably representation-only (real data
  drift, extra nested fields, archived-item metadata) is skipped and stays
  Blob-served — safe, just not yet PG-served.
- **Production untouched.** Operator-run only; prod has no `SUPABASE_DB_URL` and
  no flags enabled. The prod normalization is a future operator run once prod
  Supabase is wired.

## What this unblocks

With the structure loop proven (J8.5) and the existing fleet now PG-servable
(J8.75), **J9 (task-instance/status dual-write)** can proceed under the J8.5
conditions (off-request-path for the high-frequency task-toggle; the same
conservative parity will apply to tasks). Going forward, builder-edited and new
jobs are born canonical (dual-write keeps them faithful); this normalizer is the
one-off catch-up for legacy shapes.
