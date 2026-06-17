import type { CanonicalTask, CanonicalTaskStage } from "./task-index";
import type { WorkerTask } from "./taskState";
import {
  deriveTaskReadiness,
  findBlockingDependencies,
  type TaskBlocker,
  type TaskDependency,
  type TaskReadiness,
} from "./task-blockers";

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

/**
 * Readiness overlay for Phil task rows (the readiness/blocker display slice).
 *
 * Sits ALONGSIDE the worker task rows (`workerTasksFromCanonicalIndex`) — it does
 * not replace them. The #490 row source is untouched; this is a parallel, keyed
 * lookup the row reads to show a blocked indicator, exactly the way the per-task
 * scope context (#368) is supplied. Keeping the two separate means the proven
 * #484/#490 parity path stays byte-for-byte intact.
 *
 * Honest-empty by design (P7)
 * ---------------------------
 * Readiness comes ENTIRELY from the #482 read model (`deriveTaskReadiness`) — we
 * add no second engine. The #482 model derives `blocked` only from real
 * `TaskBlocker` / `TaskDependency` data, and TODAY nothing in the product
 * produces that data (no API, no storage — see task-blockers.ts). So with the
 * default empty inputs every not-complete task resolves to `ready` and every
 * done task to `complete`: the map carries NO `blocked` entries and the row shows
 * exactly what it shows today (zero visual change). When a future slice feeds
 * real blockers/dependencies through `blockers` / `dependencies`, the same render
 * lights up — no further UI change. We never invent a blocker.
 */
export interface PhilTaskReadiness {
  readiness: TaskReadiness;
  /** A short, worker-readable reason — present ONLY when `readiness` is
   *  `blocked`, else null. Never a raw id or a technical object (P11 — site
   *  language). */
  blockedReason: string | null;
}

/**
 * Build a `templateId → PhilTaskReadiness` map for ONE `(areaId, stage)`,
 * keyed the same way the rows are (the template id = `source.taskId`), so the
 * row can look its readiness up by `task.id`. Pure.
 *
 * Identity: readiness is derived per CANONICAL instance (blockers/dependencies
 * key on `CanonicalTask.id`), so the same template inherited by two areas — or
 * sitting in both stages — gets independent readiness. We filter by the source
 * coordinate first, exactly like `workerTasksFromCanonicalIndex`, then key the
 * result by the template id (unique within one area+stage).
 *
 * `tasks` for the dependency-completeness check is the WHOLE index, because a
 * prerequisite can live in another area (cross-area dependency, #482).
 */
export function philTaskReadinessByTemplateId(args: {
  canonicalTasks: ReadonlyArray<CanonicalTask>;
  areaId: string;
  stage: CanonicalTaskStage;
  blockers?: ReadonlyArray<TaskBlocker>;
  dependencies?: ReadonlyArray<TaskDependency>;
}): Map<string, PhilTaskReadiness> {
  const { canonicalTasks, areaId, stage, blockers, dependencies } = args;
  const out = new Map<string, PhilTaskReadiness>();
  for (const task of canonicalTasks) {
    if (task.source.areaId !== areaId) continue;
    if (task.source.stage !== stage) continue;
    const readiness = deriveTaskReadiness({
      task,
      blockers,
      dependencies,
      tasks: canonicalTasks,
    });
    out.set(task.source.taskId, {
      readiness,
      blockedReason:
        readiness === "blocked"
          ? blockedReasonForTask({ task, blockers, dependencies, tasks: canonicalTasks })
          : null,
    });
  }
  return out;
}

/**
 * The short, worker-readable reason a task is blocked. Precedence mirrors
 * `deriveTaskReadiness` (open blocker first, then dependency), so the reason
 * always matches the cause the model used. Returns a non-empty string for any
 * genuinely-blocked task; falls back to a plain "Dependency incomplete" when the
 * prerequisite isn't known. Never surfaces a raw id.
 */
function blockedReasonForTask(args: {
  task: CanonicalTask;
  blockers?: ReadonlyArray<TaskBlocker>;
  dependencies?: ReadonlyArray<TaskDependency>;
  tasks: ReadonlyArray<CanonicalTask>;
}): string {
  const openBlocker = (args.blockers ?? []).find(
    (b) => b.taskId === args.task.id && b.status === "open",
  );
  if (openBlocker) {
    const title = openBlocker.title?.trim();
    return title ? title : "Open blocker";
  }

  const edges = (args.dependencies ?? []).filter((d) => d.taskId === args.task.id);
  const blocking = findBlockingDependencies({ tasks: args.tasks, dependencies: edges });
  const first = blocking[0];
  if (first) {
    const prerequisite = args.tasks.find((t) => t.id === first.dependsOnTaskId);
    return prerequisite ? `Waiting on ${prerequisite.title}` : "Dependency incomplete";
  }

  return "Dependency incomplete";
}
