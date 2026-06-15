# L1 — compile preview/confirm producer

> Status: **real, runtime producer.** Builds on L0 (#465). Code:
> [`src/server/job-control/compile-producer.ts`](../../src/server/job-control/compile-producer.ts)
> + routes under
> [`src/app/api/job-control/compile/`](../../src/app/api/job-control/compile/).
> Wires NOTHING into Phil — that is L3.

## Why

L0 persists a confirmed `ScopeReconciliation` (`jobs/<jobId>/scope-reconciliation.json`).
L1 turns it into the compiled job-control artifact — the work packages with
provenance — that L2/L3 will later expose to Phil.

## What it does

- **Reads** the confirmed reconciliation (L0) + the job structure
  (`Pick<Job, id|areaGroups|roughInTasks|fitOffTasks>`) from `jobs.json`.
- **Runs the tested pure compiler** `compileWorkPackages(...)`
  (`src/domains/job-control/compile.ts`, #367) — no logic duplicated. The
  compiler NEVER mints a task: an `unclear` / unbacked clause becomes a NAMED
  GAP, never a fabricated task.
- **Diffs** against any existing artifact via `diffCompile(...)` (id-stable; an
  identical re-compile is a no-op).
- **Preview** returns the work packages, gaps and diff summary — persists nothing.
- **Confirm** persists `jobs/<jobId>/job-control.json`.

## Routes

| Route | Method | Auth | Writes |
|---|---|---|---|
| `/api/job-control/compile/preview` | POST | admin (cookie decode) | no |
| `/api/job-control/compile/confirm` | POST | admin (**authoritative `verifyViaApi`**) | `jobs/<jobId>/job-control.json` |

Preview body: `{ jobId }`. Confirm body: `{ jobId, sourceHash? }` — when `sourceHash`
is supplied it is checked against the current reconciliation+structure; a stale
confirm is rejected `409` (`code: "stale_source"`), writing nothing. Missing
reconciliation → `409 no_reconciliation`; missing job → `404`. If an existing
`job-control.json` is present but unreadable (fails schema parse), confirm
refuses with `409 unreadable_previous` rather than clobber its preserved
claim/closeout/evidence arrays; the read-only preview tolerates it as "no previous".

## Auth

Mirrors L0: preview is read-only (`decodeSessionCookie` + `isAdminRole`); confirm
is a write and uses the authoritative HMAC-verified `verifyViaApi()` (reusing
L0's `authorizeAdminViaVerify` / a `confirmCompileAuthorized` seam, unit-tested
without Next). A forged/unsigned cookie cannot reach the write.

## Persistence

`jobs/<jobId>/job-control.json` is the domain `JobControlSpine` (so L2 reads
top-level `workPackages` / `evidenceLinks`) plus L1 `compileMeta`:

```jsonc
{
  "jobId": "...",
  "workPackages": [ /* compiled */ ],
  "claimLines": [], "closeoutRequirements": [], "evidenceLinks": [], // preserved, not L1's to own
  "updatedAt": "...",
  "compileMeta": {
    "generatedAt": "...", "confirmedAt": "...", "confirmedBy": "...",
    "compilerVersion": "1",
    "sourceHash": "<reconciliation + structure>",
    "sourceReconciliationHash": "<L0 scope source>",
    "sourceStructureHash": "...",
    "gaps": [ /* named compile gaps — never tasks */ ],
    "diff": { "added": 0, "updated": 0, "removed": 0 }
  }
}
```

L1 owns **only** `workPackages`; claim/closeout/evidence arrays from an existing
artifact are preserved, never clobbered.

## Backup

`jobs/<jobId>/job-control.json` is covered + snapshotted via the existing `jobs/`
PREFIX_STORE in `api/_lib/backup-manifest.js` (`isCoveredKey(...)` → true; the
manifest comment now names it). `npm run check:backup-manifest` stays green.

## Revision guard

The artifact carries a `revision` content fingerprint, advanced on every write.
Compile confirm accepts an **optional** `expectedJobControlRevision`; if supplied
and the stored artifact has moved (e.g. a field evidence-link append landed),
confirm is rejected `409 stale_revision` rather than clobbering it — and the
saved result returns the new `revision`. Shared with the evidence-link writer;
see [job-control-revision-guard.md](job-control-revision-guard.md). This is a
revision precondition guard, **not** storage-level atomic CAS.

## Deliberately not built

No Phil wiring (L3), no L2 read boundary, no evidence writing (L4), no task
mutation, no Supabase, no fake/duplicated compiler.

## Next slices

- **L2** — field-gated read returning `{ workPackages, evidenceLinks }`.
- **L3** — wire Phil fetch into `buildAreaTaskContext(...)`.
- **L4** — capture/evidence writes `EvidenceLink{requiredEvidenceId}`.
