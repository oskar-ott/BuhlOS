import type { CanonicalTask } from "@/domains/jobs/task-index";
import type { ITPInstance, ITPStatus } from "./types";

/**
 * Task-scoped QA/ITP projection (#505) — a READ-ONLY view of which checks apply
 * to a canonical task instance.
 *
 * The task-led direction makes QA a FACET of the task. But ITP today has NO task
 * scope: an `ITPInstance` is scoped to `job` / `level` / `area` / `switchboard`
 * (`schema.ts` ITP_SCOPES), never to a `(areaId, stage, taskId)` task. So the
 * only HONEST association (P7) is via the task's AREA:
 *
 *   - a `job`-scoped check applies to every task in the job;
 *   - an `area`-scoped check applies to every task in that area (`scopeId === areaId`);
 *   - `level` / `switchboard` scopes CANNOT be mapped to a task (a task carries
 *     no level/switchboard membership) and are EXCLUDED — never guessed.
 *
 * The result is therefore **area/job-granular QA surfaced per task**, NOT
 * per-task-instance QA. The `granularity` field says so, exactly as the proof
 * read-model is honest about being area/package-granular (proof-review-model.md).
 * Per-task ITP authoring is a later slice; this projection is the seam a future
 * "QA on the task" view (or the #290 dashboard's task drill-down) reads.
 *
 * What it is — and is NOT (deliberately, for #505):
 *   - PURE + read-only. No storage, no API, no UI, no `/qa` change, NO change to
 *     the ITP state machine. Nothing consumes it yet (the surfacing is a separate,
 *     UX-reviewed slice).
 *   - Keyed by CANONICAL task id (`CanonicalTask.id`), never a bare `taskId` — an
 *     inherited template in two areas gets each area's checks independently.
 *   - Archived ITP instances never apply. Invents nothing.
 *
 * Cross-ref:
 *   src/domains/itp/schema.ts — ITP_SCOPES / ITP_STATUSES / ITPInstance
 *   src/domains/itp/qa-rollup.ts — the JOB/dashboard rollup (#290); this is the per-task complement
 *   src/domains/jobs/task-index.ts — CanonicalTask
 */

/** The scopes that can honestly apply to a task — why a check shows on it. */
export type TaskQaScope = "job" | "area";

export interface TaskQaCheck {
  itpId: string;
  /** Worker-readable check name (the attach-time template snapshot name). */
  name: string;
  /** WHY this check applies to the task — `job`-wide or its `area`. Honest
   *  granularity marker: never "task". */
  scope: TaskQaScope;
  status: ITPStatus;
  signedOff: boolean;
}

export interface TaskQaView {
  /** Canonical task id (`ct_…`). */
  taskId: string;
  checks: TaskQaCheck[];
  total: number;
  signedOff: number;
  /** total − signedOff (pending / in-progress / witnessed). */
  outstanding: number;
  /** Always `"area-or-job"`: ITP has no task scope, so these checks are
   *  area/job-granular surfaced per task — never per-task-instance. */
  granularity: "area-or-job";
}

/**
 * True when an ITP instance honestly applies to a task instance: a job-wide
 * check, or an area check on the task's area. `level`/`switchboard` scopes can't
 * be mapped to a task and never apply; archived instances never apply.
 */
export function itpAppliesToTask(itp: ITPInstance, task: CanonicalTask): boolean {
  if (itp.archived) return false;
  if (itp.scope === "job") return true;
  if (itp.scope === "area") return itp.scopeId === task.areaId;
  return false; // level / switchboard — not task-mappable
}

function applyingScope(itp: ITPInstance): TaskQaScope | null {
  if (itp.scope === "job") return "job";
  if (itp.scope === "area") return "area";
  return null;
}

/** The QA view for one canonical task: the checks that apply (area/job), with a
 *  signed-off / outstanding tally. Pure. */
export function taskQaForCanonicalTask(
  task: CanonicalTask,
  itpInstances: ReadonlyArray<ITPInstance>,
): TaskQaView {
  const checks: TaskQaCheck[] = [];
  for (const itp of itpInstances) {
    if (!itpAppliesToTask(itp, task)) continue;
    const scope = applyingScope(itp);
    if (!scope) continue;
    checks.push({
      itpId: itp.id,
      name: itp.templateSnapshot.name,
      scope,
      status: itp.status,
      signedOff: itp.status === "signed-off",
    });
  }
  const signedOff = checks.reduce((n, c) => (c.signedOff ? n + 1 : n), 0);
  return {
    taskId: task.id,
    checks,
    total: checks.length,
    signedOff,
    outstanding: checks.length - signedOff,
    granularity: "area-or-job",
  };
}

/**
 * Build a `canonicalTaskId → TaskQaView` projection over an index. Only tasks
 * with ≥1 applying check are included (honest-empty: a task with no QA is absent,
 * mirroring `buildAreaTaskContext`). Pure + read-only; the input is not mutated.
 */
export function buildTaskQaProjection(
  canonicalTasks: ReadonlyArray<CanonicalTask>,
  itpInstances: ReadonlyArray<ITPInstance>,
): Map<string, TaskQaView> {
  const out = new Map<string, TaskQaView>();
  for (const task of canonicalTasks) {
    const view = taskQaForCanonicalTask(task, itpInstances);
    if (view.total > 0) out.set(task.id, view);
  }
  return out;
}
