# L2 + L3 — job-control read boundary + Phil task-context wiring

> Status: **real.** Builds on L1 (#466). Code:
> [`src/server/job-control/read.ts`](../../src/server/job-control/read.ts) (L2) +
> the Phil job page/detail wiring (L3). This is the first slice that makes
> compiled job-control data visible to workers in Phil.

## Why

L1 persists the compiled artifact `jobs/<jobId>/job-control.json`, but the Phil
task-context model (#368/#462) received no real data — every task rendered its
honest-empty context. L2 exposes a field-safe read; L3 feeds it into the existing
Phil task-context builder, so the already-built context cards light up where real
compiled data exists, with **no Phil IA change**.

## L2 — read boundary (`src/server/job-control/read.ts`)

`readJobControlForField(deps, jobId)` reads `jobs/<jobId>/job-control.json`,
validates it with the L1 schema, and returns only the **field-safe subset**:

```ts
{ ok: true, ready: true, jobId, workPackages, evidenceLinks, meta } // generatedAt/confirmedAt/sourceHash
{ ok: true, ready: false, reason: "missing", workPackages: [], evidenceLinks: [] }
{ ok: false, reason: "unreadable" | "job_mismatch", workPackages: [], evidenceLinks: [] }
```

- Office-only compile internals — `compileMeta.gaps`, the reconciliation/structure
  source fingerprints — are **never** exposed to the field.
- Pure core `buildJobControlReadResult(jobId, raw)` + injectable `JobControlReadDeps`
  (read-only — there is no write capability on the deps surface). It compiles
  nothing, writes nothing, mutates nothing.

## L3 — Phil wiring

The Phil job page server component
([`src/app/phil/jobs/[jobId]/page.tsx`](../../src/app/phil/jobs/[jobId]/page.tsx))
already gates `canAccessSurface(role,'phil')` and job assignment (via the
`/api/jobs?id=` fetch). It now also loads the compiled artifact **directly,
server-side, only after that gate passes** (`result.kind === "ok"`), and passes
`workPackages` / `evidenceLinks` into `<PhilJobDetail>`. `PhilJobDetail` threads
them into the existing `buildAreaTaskContext(...)` call (#368). No new endpoint,
no new UI, no new tab/page/nav.

## Field-gating

No standalone public endpoint is added. The read is a server-only helper invoked
from the already-authenticated, job-access-checked page — so it is **no more
exposed than the existing Phil job-data fetch**. (A future admin/debug surface
could add a route; not needed here.)

## Honest-empty & fail-soft

- **Missing artifact** (the normal case — most jobs aren't compiled yet) → empty
  `workPackages` → `buildAreaTaskContext` returns an empty map → every task
  renders exactly as today. **Zero regression.**
- **Unreadable artifact** → the loader fails soft to empty; the worker is never
  blocked. (The read boundary distinguishes `unreadable`/`job_mismatch` from
  `missing` for a future office surface, but the field page treats both as empty.)

## Deliberately not built

No evidence writing (L4), no Capture/My Day change, no task mutation, no compile,
no `job-control.json` / `scope-reconciliation.json` write, no Supabase, no Phil
tab/page/nav, no fake work packages or evidence links. A required-evidence item
reads `met` **only** from a real `EvidenceLink` — there is no writer yet, so today
`met` is driven solely by any links already present in the artifact.

## Next slice

- **L4** — evidence writer: capture writes `EvidenceLink{requiredEvidenceId}` so a
  required-evidence item flips from "needed" to "met".
