# L4 — evidence writer (link capture to required proof)

> Status: **server writer real; UI binding is the next micro-slice.** Builds on
> L1 (#466) + L2/L3 (#467). Code:
> [`src/server/job-control/evidence-link.ts`](../../src/server/job-control/evidence-link.ts)
> + route
> [`src/app/api/job-control/evidence-link/route.ts`](../../src/app/api/job-control/evidence-link/route.ts).

## Why

L2/L3 made Phil show "proof needed" for each compiled required-evidence item, but
a captured photo could never flip it to `met` — nothing wrote an `EvidenceLink`.
L4 closes that loop:

```
Phil shows proof needed → worker captures (api/evidence.js, unchanged)
  → POST /api/job-control/evidence-link writes EvidenceLink{requiredEvidenceId}
  → L2 read returns the link → buildPhilTaskContext marks the requirement met
```

## Why a TS writer, not `api/evidence.js`

`api/evidence.js` is a legacy CommonJS Vercel function. Per the runtime ADR
(#463) it **cannot** import the typed job-control domain, and the job-control
schema/validation **must not** be duplicated in JS. So the link write lives in
TS (`src/server/job-control/evidence-link.ts` + an App Router route), exactly like
the L0/L1 producers. The normal `EvidenceItem` save in `api/evidence.js` is
**unchanged**; this is an additive second step invoked with the just-saved
evidence id.

## Writer (`evidence-link.ts`)

- Pure `applyEvidenceLink(artifact, request, ctx)` validates the target (the work
  package exists AND carries the named required-evidence item) and **upserts** an
  `EvidenceLink`. Touches only `evidenceLinks` (+ `updatedAt`); preserves
  `workPackages`, `compileMeta`, `claimLines`, `closeoutRequirements` and unrelated
  links. Never mutates the input.
- **Idempotent**: a duplicate (workPackage + requirement + proof id) makes no new
  link and no write.
- The link references the **real** saved proof id (`evidenceId` or
  `observationId`) — never a fabricated id; the write happens **only after**
  validation passes.
- `writeEvidenceLink(deps, …)` orchestrates load → validate → (only if new) save.
  Injectable deps; `blobEvidenceLinkDeps()` wires the real blob helpers.

## Route — `POST /api/job-control/evidence-link`

Body: `{ jobId, workPackageId, requiredEvidenceId, evidenceId? | observationId?, role? }`.

**Field write, not admin.** Gated by `canAccessSurface(role,'phil')` + the
existing job-assignment gate (re-uses `/api/jobs?id=`, which 403s an unassigned
worker) — no more exposed than the worker's existing evidence write. Outcomes:

| Case | Response |
|---|---|
| valid target, new link | `200 { ok:true, created:true, link }` |
| valid target, duplicate | `200 { ok:true, created:false, link }` (no write) |
| missing `job-control.json` | `404 { ok:false, reason:"missing", warning }` — evidence already saved; not linked |
| unreadable artifact | `409 { ok:false, reason:"unreadable", warning }` — artifact left untouched |
| bad workPackage / requirement | `409 { ok:false, reason:"invalid_work_package" \| "invalid_requirement" }` — no write |

The normal evidence save (`api/evidence.js`) is independent and always succeeds;
a missing/invalid link target never blocks capture.

## UI binding — deliberately the next micro-slice

There is **no per-requirement capture affordance** yet (the L2/L3 field-validation
confirmed "Proof needed" rows have no "Add this photo" button). Per the brief,
this PR builds the **server writer first**; wiring a per-requirement capture
action (that calls this route with the just-saved evidence id) is a separate
micro-slice — no Capture redesign here.

## Field-safe leak guard

A regression test in `read.test.ts` now asserts office internals
(`compileMeta`/`gaps`/source fingerprints) never appear anywhere in the serialized
field read — future-proofing the explicit field-pick the L2 boundary relies on.

## Deliberately not built

No Capture UI/redesign, no Phil tab/page/nav, no task mutation, no compile/
reconcile in the capture path, no variation release, no quote-link (#244), no
Supabase, no `api/evidence.js` change.

## Known limitations (deferred to the per-requirement capture micro-slice)

- **Proof existence is trusted, not verified.** The writer never fabricates a
  proof id, but it persists the caller-supplied `evidenceId`/`observationId`
  without confirming the proof exists in the job's evidence store. So a
  job-assigned worker could POST a link with an arbitrary id and flip *their own*
  requirement to met without a real capture — no worse than their existing ability
  to post arbitrary evidence to their own job, and evidence existence is the
  evidence store's concern. The intended flow saves evidence first and passes back
  its id; an existence check (or invoking this writer only from the evidence-save
  path) is the next slice. Do not add evidence-store I/O to this writer.
- **No concurrency control on `job-control.json`.** This writer and the admin
  compile producer (`compile-producer.ts#savePersisted`) write the **same key**
  via the guard-free `writeJsonBlob` with no `__rev`/compare-and-swap. Two
  near-simultaneous link writes, or a stale link-write landing after an admin
  recompile, can lose an update (the in-process idempotency check can't see a
  concurrently-written link). Tolerable today because **no UI calls this route yet**
  (the multi-writer window isn't live). Before the per-requirement capture UI
  ships, add a **TS-side fresh-read revision check to BOTH writers** (load → apply
  → re-read just before save → 409/retry if `updatedAt`/a revision moved). Note:
  "route through `api/_lib/blob.js`" is **not** the fix — that key has no #157 blob
  guard, and the TS route cannot import the JS layer (the runtime ADR's premise).
  `blob.ts` itself defers this decision to "before any real production write" — this
  is that write, so the race is acknowledged here and the mitigation is scheduled.

## Next

Field validation on one real compiled job: requirement shows needed → capture →
link → refresh Phil → shows met. Then: per-requirement capture UI micro-slice;
variation/daywork release-to-Phil; #244; usage/audit; Supabase dual-write (later).
