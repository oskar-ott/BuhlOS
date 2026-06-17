import type { CanonicalTask, CanonicalTaskStage } from "./task-index";
import type { WorkerTask } from "./taskState";

/**
 * Phil — worker-task rows projected FROM the canonical task index (#484).
 *
 * Why this exists
 * ---------------
 * Phil's area drill-in renders one `WorkerTask` row per task in the selected
 * area + stage. Until now those rows came straight from `buildWorkerTasks`
 * (`effectiveTasks` + `readTaskState`). #484 re-sources them from the canonical
 * task index (#480) so the platform starts treating a task as a job-level entity
 * — WITHOUT changing what the worker sees, taps, or writes.
 *
 * This is a pure PROJECTION, not a new model:
 *
 *   all canonical tasks → filter to (areaId, stage) → render the same rows
 *
 * Parity guarantee
 * ----------------
 * `buildCanonicalTaskIndex` walks the structure with the SAME rule the Phil page
 * uses (non-archived groups → non-archived areas → `effectiveTasks`,
 * override-wins, archived templates excluded) and reads state through the SAME
 * `readTaskState`. So for any non-archived area in a non-archived group — which
 * is the only kind Phil ever selects (its areas come from `visibleAreaGroups`,
 * which applies the identical `!archived` filter) — the rows this returns equal
 * `buildWorkerTasks(job, area, stage, taskState)` exactly, in the same order and
 * with the same state. The parity is asserted directly in the tests.
 *
 * Identity rule (the load-bearing one)
 * ------------------------------------
 * A canonical task's instance identity is its source coordinate
 * `(areaId, stage, taskId)`, NOT the bare `taskId` — an inherited template is a
 * distinct instance in every area. We therefore FILTER by the source coordinate.
 *
 * The rendered row id is deliberately the TEMPLATE id (`source.taskId`), not the
 * canonical `ct_…` id. The whole downstream contract is keyed on it within the
 * already-selected area+stage scope: `POST /api/task-toggle` writes
 * `{ areaId, stage, taskId }`, the per-task scope context (#368) is keyed by
 * `taskId`, and capture-proof targets carry `taskId`. Preserving the template id
 * as the row id keeps every one of those behaviours byte-for-byte unchanged
 * while the canonical instance identity is preserved in the projection layer
 * (the `CanonicalTask` we read from carries the full coordinate).
 *
 * Cross-ref:
 *   src/domains/jobs/task-index.ts — buildCanonicalTaskIndex + CanonicalTask
 *   src/domains/jobs/taskState.ts#buildWorkerTasks — the parity oracle
 *   src/domains/jobs/format.ts#visibleAreaGroups — Phil's area filter
 *   src/components/phil/PhilJobDetail.tsx — the consumer
 */

/**
 * Project an already-built canonical task index down to the worker task rows
 * for ONE `(areaId, stage)` coordinate. Pure; preserves index order; never
 * invents a row or a state.
 *
 * Filters on the canonical SOURCE coordinate so an inherited template's
 * instance in another area can never leak in. The row `id` is the template id
 * (`source.taskId`) so the existing toggle / context / capture-proof contract is
 * unchanged.
 */
export function workerTasksFromCanonicalIndex(
  canonicalTasks: ReadonlyArray<CanonicalTask>,
  areaId: string,
  stage: CanonicalTaskStage,
): WorkerTask[] {
  const out: WorkerTask[] = [];
  for (const task of canonicalTasks) {
    if (task.source.areaId !== areaId) continue;
    if (task.source.stage !== stage) continue;
    out.push({
      id: task.source.taskId,
      name: task.title,
      state: task.state,
    });
  }
  return out;
}
