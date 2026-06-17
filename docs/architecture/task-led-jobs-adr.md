# ADR — task-led jobs: tasks are first-class, areas/stages are views

**Status:** Accepted as direction (2026-06-17). Identity migration deferred; a
compatibility bridge is in force. Spec: [`task-led-job-architecture.md`](task-led-job-architecture.md).

## Problem

The job model grew area-first: a task is a flat template at job level
(`Job.roughInTasks` / `fitOffTasks`) inherited per area, with runtime state at
`dwellings[areaId][stage].tasks[taskId]` (`src/domains/jobs/progress.ts`). That
shape reads as **"Job → Area → Stage → Task"**, i.e. the area *owns* the task.

But the work a field worker actually does is a **task** that has a place, a phase,
a system, a worker, dependencies, blockers, required proof, a QA check, materials
and a drawing — and that same task needs to appear in many lists (by area, by
system, by worker, blocked, waiting on material, QA queue, proof-missing) without
being duplicated or re-owned per list. An area-owned model cannot express
cross-area dependencies (one area's fit-off waiting on another area's rough-in)
or a system/worker view without either duplicating data or bolting view-state
onto storage. Deepening the area-owned arrays each time a new facet (proof,
blocker, QA) arrives compounds the wrong shape.

## Rejected option — keep deepening area-owned task arrays

Continue hanging every new facet (blocker, proof, QA, dependency) directly off
`dwellings[areaId][stage].tasks[taskId]`. Rejected: it entrenches area-ownership,
makes cross-area relationships inexpressible without duplication, and forces every
non-area view to reconstruct identity ad hoc. Each addition raises the eventual
migration cost.

## Decision

Two linked decisions, recorded together:

**Decision 1 — Tasks are first-class job objects.** The task instance is the
operational spine of a job. Areas, stages, systems, workers, dependencies,
blockers, proof, QA, materials, RFIs and drawings are **facets of a task**.

**Decision 2 — Areas and stages are facets/views, not the final owner.** The
"Job → Area → Stage → Task" hierarchy is **current storage and a place-first
view**, not the long-term owner. Every list (area, stage, system, worker, blocked,
QA, proof) is a **projection over task instances**. Views stay views.

### How it is realised today (the bridge)

- Identity is carried by a **canonical task index** — one instance per
  `(jobId, areaId, stage, taskId)`, id `ct_<hash>` derived deterministically
  (FNV-1a), never name-based (`src/domains/jobs/task-index.ts`, #486/#487).
- Job-control keeps legacy `TaskRef`; `task-ref-compat.ts` (#488) resolves it to
  canonical ids and back **without changing storage or compile output**.
- Blocker/readiness (#489), Phil rendering (#490/#493) and the proof summary
  (#494) all key off canonical identity, not raw area arrays.
- The model term **`jobId + areaId + stage + taskId`** is therefore an explicit
  **compatibility bridge** — load-bearing today, not the final architecture.

### Target (not built)

A stable **`taskInstanceId`** owned by the job, with the facets above and views as
projections. `taskInstanceId` exists **nowhere** in the codebase yet — it is the
direction, not a type. The `ct_<hash>` canonical id is the bridge toward it.

## Constraints / consequences

- **No storage migration** under this ADR. Moving task storage off the area/stage
  shape needs its own ADR + field validation. This ADR sets direction and a bridge
  only.
- **Anti-creep:** new task-facet work must key off canonical identity (the index /
  `task-ref-compat`), and must not deepen area-owned task arrays unless it labels
  itself a temporary compatibility bridge (enforced as a rule in
  `00-rebuild-non-negotiables.md`).
- **Area-id uniqueness** within a job is an invariant protecting the bridge
  (a tuple must resolve one instance) — `findDuplicateLiveAreaId` on every write
  path (#491).
- **Phil unaffected at the surface.** Place-first navigation (P1) is a view and
  remains. No Phil-constitution amendment is implied; behavioural change to the
  ratified Phil package goes via governance §3 / P15.
- **Proof granularity** stays area/package today — see
  [`proof-review-model.md`](proof-review-model.md). Per-canonical-task proof
  authoring is a later slice.

## Next slices (not in this decision)

1. Wire a **real blocker/dependency source** (variations / observations /
   material-requests) into the readiness model so the Phil blocker line lights up
   from real data.
2. **Read-only TaskInstance projection layer** — a job-level projection that
   composes the facets, still over current storage.
3. **Per-canonical-task proof authoring** (key `EvidenceLink` by canonical id).
4. Only after the above prove out: an ADR for a persisted `taskInstanceId` and a
   storage migration, field-validated.
