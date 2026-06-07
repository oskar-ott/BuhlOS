# Phil worker-visible tasks (`feat/phil-worker-visible-tasks`)

**Status:** shipped slice. Closes gap #1 ("task completion is dormant") from
[the Field Execution contract](./phil-field-execution-contract.md).

Before this slice the new Phil job screen rendered the task plan **read-only**:
a worker could see the rough-in / fit-off tasks for an area but could not mark
any of them done. `/api/task-toggle` had existed and worked since the legacy UI,
but nothing in the modern Phil called it. An electrician literally could not
record progress — the core "site bible" action was missing.

This slice wires real, safe task completion into the existing area drill-in.

---

## Data model — plan vs state (two separate blobs)

The two are deliberately kept apart, and this slice never blurs them:

| Layer | Lives in | Read by | Written by |
|---|---|---|---|
| Task **plan** (what tasks exist) | `jobs.json` — `area.{roughIn,fitOff}Tasks` override, else job-level template | `effectiveTasks` (archived filtered) | the office Job Builder (`/api/jobs` PUT) — **untouched here** |
| Task **state** (what's done) | `jobs/<jobId>/data.json` — `dwellings[areaId][stage].tasks[taskId]` ∈ `not_started \| in_progress \| complete` | `GET /api/data` | `POST /api/task-toggle` |

Because completion state is a different blob from the job definition, marking a
task done **cannot** corrupt the plan or the BuhlOS "What the field sees"
preview (`buildPhilPreview`, which reads `jobs.json`).

There is **no per-task visibility flag** in the schema — every unarchived task
in an active job is implicitly field-visible. "Worker-visible" therefore means
exactly what `effectiveTasks` / `visibleAreaGroups` return: unarchived tasks, in
unarchived areas, in unarchived groups, on a non-draft / non-archived job.

---

## API — `POST /api/task-toggle` (hardened)

`POST /api/task-toggle?jobId=<id>` body `{ areaId, stage, taskId, state }`.

Already present (unchanged): auth required; `client` role 403'd; `canWrite`
(admin tier / LH-on-job / field-on-job) enforced; state/stage enum validation;
area + task existence check; no-op short-circuit; real persistence to
`data.json`; a light `lastTouchedBy` / `lastTouchedAt` stamp on the dwelling.

**Added in this slice (defence-in-depth, Path C):**

1. **Draft / archived job → 404** for non-admins. `canWrite` only checks role +
   assignment, but `/api/jobs` already 404s a field worker's *GET* of a
   draft/archived job. A stale mobile client still holding the ids after a job
   is parked must not be able to write to it — so the toggle now mirrors the GET
   visibility gate (`canViewDraftJobs` / `canViewArchivedJobs`). The admin tier
   is unaffected.
2. **Archived area / area in an archived group → 404** — matches
   `visibleAreaGroups`.
3. **Archived task → 404** — matches `effectiveTasks` (the `.some()` existence
   check now excludes `archived`).
4. **Malformed existing task maps are coerced before write** — if an old/corrupt
   `dwellings[areaId][stage]` or `.tasks` value is not an object, the endpoint
   resets that narrow stage map before applying the confirmed task state instead
   of crashing or returning a false success.

Net: the only toggle targets the API accepts are exactly the ones a worker can
see. No new endpoint, no schema change, no change to the legacy write path.

---

## UI — the existing area drill-in, now interactive

No new section or route. The change lands in the **Work** block that already
exists on `/phil/jobs/[jobId]`:

- `page.tsx` loads initial task state server-side via `GET /api/data`
  (`loadInitialTaskState` → `parseJobTaskState`), alongside the existing
  evidence/snags/ITPs/docs loads. Non-blocking: any failure → empty map plus a
  warning that progress could not load; every task reads "To do" until refresh
  or a server-confirmed toggle reconciles it.
- `PhilJobDetail` holds `taskState` + `pendingTaskIds`, derives the viewed
  stage's `WorkerTask[]` via `buildWorkerTasks`, and owns `handleToggleTask`.
- `PhilJobAreaDetail` renders each task with its real state (icon + status Pill)
  and, when a toggle handler is wired, a **Mark done / Undo** control plus an
  honest **"N of M done"** / **"All N done"** count.

**Non-optimistic by design.** A tapped row shows a *Saving…* state and its
local state only advances once the server confirms the new value. A failed
write, malformed success response, or missing confirmation surfaces a
`PhilNotice` and leaves the task unchanged — so a task **never shows as done on
a failed request**.

**Stage correctness.** The drill-in's task list + write target use the
*viewed* stage (`soleStage(...) ?? stage`), not the raw parent `stage`. This
also fixes a latent first-load mismatch for single-stage areas.

---

## Honesty rules honoured

- **No fake completion / progress.** A task is `complete` only if `data.json`
  records it or `/api/task-toggle` confirms it; counts are real integers, never
  a fabricated percentage. If the initial state fetch fails, Phil says so.
- **`in_progress` is displayed, not written.** v1's control is binary
  (done ↔ not_started); a pre-existing `in_progress` (office app / legacy data)
  renders faithfully as "In progress" but the binary control drives it to done.
- **No per-task evidence link.** Evidence carries no `taskId`, so a per-task
  "Add evidence" button would fabricate a link. Capture stays job/area/stage
  scoped (unchanged).
- **No admin controls in Phil.** No add/edit/delete/archive task affordances;
  the office Job Builder is the only place the plan is edited.

---

## Deferred (honest, not faked)

- Writing `in_progress` from the field (binary done/undo is enough for v1).
- Per-task evidence / ITP linkage (no `taskId` on those records).
- Per-area task-progress chips on the area cards (drill-in only for now).
- A global task-activity feed (only the existing light dwelling stamp is kept).
- Surfacing completion back on the BuhlOS job hub (a later admin-side slice;
  the state is now real and ready for it).

---

## Tests & validation

- `src/domains/jobs/taskState.test.ts` — pure helper: blob parsing (coerces
  invalid values, ignores non-task fields), `readTaskState` defaults,
  `applyTaskState` immutability, `buildWorkerTasks` (archived hidden, override
  vs job-level), `stageProgress`, binary `nextToggleState`, labels/tones, and
  malformed toggle-result rejection.
- `src/domains/jobs/task-toggle-api.test.ts` (registered in `test:api`) —
  persistence, no-op, undo, only-the-toggled-task-moves, light audit, role/auth
  gates (unassigned 403, client 403, 401, 405), draft/archived job 404, admin
  can toggle a draft, unknown/archived task 404, archived area + archived-group
  404, malformed existing blob coercion, body validation 400s.
- `src/components/phil/PhilJobAreaDetail.test.tsx` — extended for the
  `WorkerTask` shape: state pills (read-only), Mark done / Undo, pending
  "Saving…" + disabled, honest count, and "no admin/editor controls".

Validation for this PR must include `typecheck`, `lint`, `test:unit`,
`test:api`, `build`, `check:smoke-list`, and the route/shell guards
(`check:admin-shell`, `check:production-shell`, `check:route-ownership`,
`check:shell-contract`, `check:sw-cache-version`, `smoke:admin-routes`).
Preview Smoke is **not** dispatched for this slice.
