# Job-control artifact revision / stale-write guard

> Status: **real, application-level revision precondition guard.** NOT
> storage-level atomic CAS (see §CAS honesty). Protects the shared artifact
> `jobs/<jobId>/job-control.json`, which now has **two writers** — the compile
> producer (L1, #466) and the evidence-link writer (L4, #468).

## Why

`job-control.json` is written by both the admin compile producer and the field
evidence-link writer. Without a shared precondition, a stale writer could erase
evidence links or overwrite a freshly recompiled artifact (the medium-severity
race flagged in #468's review). This guard makes a write **reject** when the
artifact has moved since the caller read it.

## Revision model

The persisted artifact carries an optional `revision: string` — a **content
fingerprint** (sha256) over the meaningful fields (`jobId`, `workPackages`,
`evidenceLinks`, `claimLines`, `closeoutRequirements`, `compileMeta`), excluding
`revision` and `updatedAt` so it is a stable function of content.

- `computeJobControlRevision(artifact)` — the hash.
- `jobControlRevisionOf(artifact)` — the stored token, or computed for a
  pre-guard artifact (**migration-on-read**: old artifacts get a stable revision
  with no write and never crash Phil).

Both helpers live in `src/server/job-control/compile-producer.ts` and are shared
by the evidence-link writer and the read boundary.

## Both writers participate

- **Compile confirm** (`prepareCompileConfirm` / `runCompileConfirm`): accepts an
  **optional** `expectedRevision`. If supplied and the current artifact's revision
  differs → `409 stale_revision` (no write). It re-reads + preserves
  `evidenceLinks` / `claimLines` / `closeoutRequirements`, and stamps the advanced
  revision on the new artifact. Returns `saved.revision`.
- **Evidence-link write** (`writeEvidenceLink`): **requires** `expectedRevision`.
  If the current artifact's revision differs → `409 stale_revision` (no write).
  On a valid, non-duplicate write it appends the link and stamps the advanced
  revision; returns the new `revision`.

Compile keeps the field optional (no UI passes it yet, and confirm already
re-reads + preserves arrays); the evidence-link mutating write **requires** it,
because no UI calls that route yet — so we foreclose silent stale writes now
rather than retrofit them later.

## Routes

| Route | revision param | on stale |
|---|---|---|
| `POST /api/job-control/compile/confirm` | `expectedJobControlRevision?` (optional) | `409 { code: "stale_revision", currentRevision }` |
| `POST /api/job-control/evidence-link` | `expectedJobControlRevision` (**required**, 400 if missing) | `409 { reason: "stale_revision", currentRevision }` |

Both return the new `revision` on success. The field-safe read
(`readJobControlForField`) exposes `meta.revision` so a caller reads it, then
passes it back as `expectedJobControlRevision` when writing.

## CAS honesty

**This is NOT storage-level atomic compare-and-swap.** `@vercel/blob`'s `put`
(used by `writeJsonBlob`) has no conditional/precondition option — there is no
`ifMatch`/etag/`ifNoneMatch` write parameter (the SDK's `etag` is a multipart
*result* field, not a write input). The guard is therefore an **application-level
read → compare-revision → write** precondition:

> It detects stale callers and prevents the known stale overwrites in normal app
> flow (stale preview, sequential writes, recompile-after-link). A **concurrent
> same-revision race remains possible**: two writers that both read revision R
> and write near-simultaneously will both pass the precondition, and the second
> `put` still wins (last-write-wins). Closing that fully needs storage-level
> conditional writes (not available in `@vercel/blob` today) or a serialized
> writer — deferred.

This residual window is small and bounded; it is acceptable until a Capture UI
makes the multi-writer path live at volume.

One more deliberate gap: compile confirm only checks `expectedRevision` when a
prior artifact exists — if a caller supplies a revision but the artifact is
*absent*, the precondition is skipped and a fresh artifact is written. This has
**no data-loss consequence** (an absent artifact has no state to preserve, and
there is no real delete flow for `job-control.json`), so it is left as-is; the
evidence-link writer, by contrast, fails closed (`404 missing`) since a field
link write to a non-existent artifact is never meaningful.

## Deliberately not built

No Capture UI, no Phil UI change, no task mutation, no compile/reconcile in the
evidence-link path, no Supabase, no Vercel/config, no `api/evidence.js` change,
no storage migration.

## Next

The per-requirement Capture UI micro-slice must **read `meta.revision` first**
and pass it as `expectedJobControlRevision` when calling the evidence-link route.
