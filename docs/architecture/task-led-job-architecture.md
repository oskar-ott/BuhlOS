# Task-led job architecture

> **Status:** direction of record (accepted 2026-06-17). The *principle* is
> settled; the *storage/identity* is mid-migration. This document states the
> target, names the current compatibility bridge, and marks honestly what is and
> is not built. Decision record: [`task-led-jobs-adr.md`](task-led-jobs-adr.md).
> Cross-surface — governs both **BuhlOS** (admin) and **Phil** (field).

## The principle

A job is the **operating context**; the **task instance is the operational
spine**. Areas, stages, systems, workers, dependencies, blockers, proof, QA,
materials, RFIs and drawings are **facets of a task**, not the thing that owns
it. Every other shape the product shows — an area page, a stage column, a
worker's day, a blocked-tasks list, a QA queue — is a **view: a projection over
task instances**. Views may slice the model any way that helps a context; they
never gain their own storage. *(Phil constitution P2 "Work lives somewhere" + the
stable-concepts footer "views stay views"; `docs/phil-architecture.md` §1.)*

What this rules **out** as the long-term model:

```
Job → Area → Stage → Task          ✗  area owns the task (the old shape)
```

What it rules **in**:

```
Job
  └─ TaskInstance                  ✓  the operational spine
       ↳ area facet                    where the work is
       ↳ stage / phase facet           the trade-sequence gate
       ↳ system facet                  power / data / lighting / fire / …
       ↳ worker facet                  who is on it
       ↳ dependency facet              what it waits on (can cross areas)
       ↳ blocker facet                 what is stuck, and why
       ↳ proof facet                   required evidence + captures
       ↳ QA facet                      ITP / check
       ↳ material facet                what it consumes / waits on
       ↳ RFI / drawing facet           the reference of record
```

An area is **a facet of a task** ("this task is in the East Gym"), the same way
a system or a worker is. It is a legitimate and important **view** — Phil
navigates by place first (P1: Phil reflects site reality), and that place-first
surface is exactly the kind of projection this model expects. The model does not
flatten the place-first view; it says the place-first view is a *projection*,
not the owner of the data.

## Worked example — one task, many views

```
Task:  Install dedicated 20A ZIP circuit
Job:   100 Arthur St
System: power
Stage:  fit-off
Primary area: East Gym
Depends on:
  - circuit rough-in
  - breaker installed
  - switchboard termination          (equipment use of the word — not the product name)
  - corridor ceiling access
  - builder works
  - material delivery
  - drawing / RFI approval
Proof:  photo · test result
QA:     final-fix ITP
Worker: Oskar
```

That single task instance must be able to appear in **every** view below without
being duplicated or re-owned:

- East Gym **area** view
- Power **system** view
- Fit-off **stage** view
- Oskar's **worker** view
- Switchboard **dependency** view (what hangs off the board)
- **Blocked tasks** view
- **Material-waiting** view
- **RFI / drawing-approval** view
- **QA / ITP** queue
- **Proof-missing** view

It must **not** be fundamentally owned by "East Gym → Fit-off tasks". Today it
partly is (see the bridge below); that is the gap this direction closes over
time.

## Current reality (what is actually on `main`)

Honest, verified against `main` — not aspirational:

| Concern | What exists today | Where |
|---|---|---|
| **Storage** | Still area/stage based. A task is a flat **template** at job level (`Job.roughInTasks` / `fitOffTasks`), inherited by each area unless overridden; runtime state lives at `dwellings[areaId][stage].tasks[taskId]`. | `src/domains/jobs/progress.ts` |
| **Canonical task index** | A **read-only derived** model materialising one task instance per `(areaId, stage, taskId)`. Identity is `deriveCanonicalTaskId(jobId, areaId, stage, taskId)` (FNV-1a → `ct_<hash>`), **never name-based**; `templateId` kept separately. Parity with the existing progress definition is tested. | `src/domains/jobs/task-index.ts` (`buildCanonicalTaskIndex`) — PRs #486/#487 |
| **System facet** | Conservative, text-derived classification (`classifyCanonicalTaskSystem`) into a closed set; defaults `general`. Read-model aid only — no authoring field, no storage change. | `task-index.ts` — PR #487 |
| **TaskRef ↔ canonical bridge** | Job-control still stores legacy `TaskRef {areaId, stage, taskId}`; pure helpers resolve those to canonical ids and back, without changing storage or compile output. | `src/domains/job-control/task-ref-compat.ts` — PR #488 |
| **Blocker / readiness** | A **read-only** shape + pure readiness rules (`complete` / `blocked` / `ready`). Does **not** persist blockers and does **not** yet derive them from real variations / observations / material-requests. | `src/domains/jobs/task-blockers.ts` — PR #489 |
| **Phil renders from the index** | Phil area/stage rows are projected from the canonical index (`workerTasksFromCanonicalIndex`), parity-proven vs the prior builder; readiness shows a "Blocked — <reason>" line only when blocked (honest-empty otherwise, since no real blocker source is wired yet). | `src/domains/jobs/phil-task-projection.ts`, `PhilJobDetail.tsx` — PRs #490/#493 |
| **Proof** | Area/package-granular via job-control `requiredEvidence` / `EvidenceLink`; per-task summary + review-eligibility is a read-model. | see [`proof-review-model.md`](proof-review-model.md) |
| **Area-id uniqueness** | Live area ids are **unique within a job**, enforced on every HTTP write path. | `findDuplicateLiveAreaId` (`api/_lib/validation.js`, `api/jobs.js`, `api/jobs-bulk-edit.js`) — PR #491 |

## The compatibility bridge (temporary — labelled)

> The current **`jobId + areaId + stage + taskId`** model is a **compatibility
> bridge** over the older area/stage task storage. It is valid and load-bearing
> *today* — for write paths, Phil display, job-control `TaskRef`, and proof
> keying — but it is **not** the final architecture.

The bridge is deliberate: it lets blocker/proof/QA/readiness work adopt **canonical
task identity** (the tuple-derived `ct_<hash>`) *without a storage migration*. The
canonical index and `task-ref-compat` are the seam. Because identity is the
tuple (never the bare `taskId`, which is only a template id shared across areas),
an inherited template never collapses across areas and a ref for one area/stage
never resolves another's instance.

## The long-term target

- A **stable `taskInstanceId`** owned by the job (not reconstructed from a
  tuple). **Not implemented** — the term `taskInstanceId` appears **nowhere** in
  the codebase today; it is a target, not a type. The canonical `ct_<hash>` id is
  the *bridge toward* it.
- Area / stage / system / worker / proof / blocker / QA / material / RFI become
  **facets of the task instance**, and every list is a **projection**.
- Proof authored **per canonical task instance** rather than per area/package
  (today's granularity — see [`proof-review-model.md`](proof-review-model.md)).

## The anti-creep law

**Future work must not deepen area-owned task arrays unless it explicitly
documents itself as a temporary compatibility bridge.** Adding more behaviour
that treats `dwellings[areaId][stage].tasks[taskId]` as the *owner* of a task —
rather than as current storage behind the canonical index — moves the product
away from this direction. New task-facet work (blockers, proof, QA, dependencies)
should key off **canonical task identity** via the index / `task-ref-compat`, the
same seam the merged work already uses.

## What this is NOT

- **Not** a license to migrate storage. No PR should move task storage off the
  area/stage shape without its own ADR and field validation.
- **Not** a claim that `taskInstanceId` exists. It is the target term only.
- **Not** an override of Phil's place-first navigation. Phil still leads with
  place (P1); that is a view, fully consistent with this model.
- **Not** a Phil-constitution amendment. The ratified Phil package
  (`docs/phil-constitution.md` and siblings) is field-gated; any behavioural
  change there goes through governance §3 / P15, not this document.

## See also

- [`task-index.md`](task-index.md) — the canonical index + system classification
- [`task-blockers.md`](task-blockers.md) — readiness / blocker read-model
- [`proof-review-model.md`](proof-review-model.md) — proof granularity + review status
- [`job-control-runtime-adr.md`](job-control-runtime-adr.md) — the TS runtime boundary the spine runs on
- `docs/phil-architecture.md` §1–2 — stable concepts vs views; the elastic hierarchy
- `docs/architecture/00-rebuild-non-negotiables.md` — "Task-led architecture" rule
