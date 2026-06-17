# Canonical task index

Current storage remains area/stage based: a task is a flat template that lives
at the job level (`Job.roughInTasks` / `fitOffTasks`) and is inherited by each
area unless the area overrides it; runtime state lives at
`dwellings[areaId][stage].tasks[taskId]` (the canonical progress definition,
`src/domains/jobs/progress.ts` #198).

The **canonical task index** (`src/domains/jobs/task-index.ts`) is a read-only
derived model that materialises one task instance per `(areaId, stage, taskId)`.

Bare `taskId` is a **template id**, not a work-instance id — the same id is
inherited by every area. The canonical id is derived deterministically from
`jobId + areaId + stage + taskId` (FNV-1a → `ct_<hash>`) and **must not be
name-based**. `templateId` is preserved separately.

The index walks the structure exactly as `effectiveTasks` + `jobTaskProgress`
do (override-wins, archived groups/areas/templates excluded), so its length and
`complete` count never drift from the existing progress definition (parity is
tested).

This index is the bridge toward future job-level task graph work. It changes no
storage, API, or UI; for #480 `system` is always `general` and `areaRefs` is
always `[areaId]`. Discipline inference is #481; the job-control `TaskRef`
mapping is #483.
