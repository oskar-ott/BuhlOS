import type {
  CanonicalTask,
  CanonicalTaskStage,
  CanonicalTaskSystem,
} from "./task-index";
import { buildCanonicalTaskIndex } from "./task-index";
import { progressPct, type TaskCounts } from "./progress";
import type { JobTaskState } from "./taskState";
import type { Job } from "./types";

/**
 * Job progress rolled up FROM canonical task instances (#507, Epic #479,
 * roadmap Phase 8).
 *
 * The task-led direction wants progress to derive from the canonical task index
 * (#480) rather than from a bespoke walk of the job structure. But #198 already
 * established ONE canonical progress number, rendered everywhere
 * (src/domains/jobs/progress.ts) — so a rollup that produced a SECOND, competing
 * percentage would be a regression. This module deliberately avoids that:
 *
 *   - It is a pure projection over a `CanonicalTask[]` (the #480 index), which is
 *     itself materialised by the SAME walk the canonical progress definition uses
 *     (non-archived groups → non-archived areas → both stages → `effectiveTasks`,
 *     override-wins, archived excluded). #480 proves the index length and
 *     complete-count equal `jobTaskProgress(...)`.
 *   - "Complete" means exactly `state === "complete"` — `in_progress` is NOT
 *     complete, matching #198 / Phil's binary toggle. The percentage honesty rule
 *     (a % exists only where total > 0, else null) is reused from `progressPct`,
 *     so it lives in ONE place.
 *
 * The result: the job / stage / area counts are PARITY-LOCKED to `progress.ts`
 * (proven in task-progress-rollup.test.ts) — same definition, same value, just
 * derived through the instance projection. The only NEW dimension is `bySystem`
 * (#481 classification), an additive breakdown of the SAME pooled tasks — never a
 * competing "the progress number" for the job. Office, field, and any view
 * (area / stage / system) therefore report a consistent percentage.
 *
 * Additive and read-only, exactly like #480: nothing consumes it yet. It does
 * NOT replace the progress engine — both coexist until parity has paid for the
 * switch.
 *
 * Cross-ref:
 *   src/domains/jobs/task-index.ts — the canonical index (#480) this reads
 *   src/domains/jobs/progress.ts — THE canonical count definition (#198)
 *   docs/architecture/task-led-job-architecture.md — the direction
 */

/** Counts plus the honest percentage (null when there are no tasks). */
export interface ProgressCounts extends TaskCounts {
  /** Rounded 0–100, or null when total is 0 (render "No tasks yet"). */
  pct: number | null;
}

/** Job progress rolled up across every dimension of the canonical index. */
export interface TaskProgressRollup {
  /** Whole-job pooled counts — parity-locked to `jobTaskProgress`. */
  job: ProgressCounts;
  /** Job-level counts split by stage — both stages always present. */
  byStage: Record<CanonicalTaskStage, ProgressCounts>;
  /** Per-area pooled counts, keyed by areaId. Only areas present in the index
   *  appear (archived areas are already excluded by the index). */
  byArea: Record<string, ProgressCounts>;
  /** Per-system pooled counts (#481). Only systems present in the index appear.
   *  An additive breakdown of the same tasks — not a competing job percentage. */
  bySystem: Partial<Record<CanonicalTaskSystem, ProgressCounts>>;
}

/** A task instance is complete only at the exact "complete" state (#198). */
function isComplete(task: CanonicalTask): boolean {
  return task.state === "complete";
}

/** Pool a list of instances into counts. */
function countFrom(tasks: ReadonlyArray<CanonicalTask>): TaskCounts {
  let complete = 0;
  for (const t of tasks) if (isComplete(t)) complete += 1;
  return { total: tasks.length, complete };
}

/** Attach the honest percentage to a counts pair. */
function withPct(counts: TaskCounts): ProgressCounts {
  return { total: counts.total, complete: counts.complete, pct: progressPct(counts) };
}

/**
 * Roll up progress from canonical task instances. Pure — the input is the
 * already-materialised #480 index, so this never touches storage or invents
 * state. The job/stage/area numbers are identical to `progress.ts` for the same
 * job + state (the index carries that parity).
 */
export function rollUpTaskProgress(
  tasks: ReadonlyArray<CanonicalTask>,
): TaskProgressRollup {
  const stageTasks: Record<CanonicalTaskStage, CanonicalTask[]> = {
    roughIn: [],
    fitOff: [],
  };
  const areaTasks: Record<string, CanonicalTask[]> = {};
  const systemTasks: Partial<Record<CanonicalTaskSystem, CanonicalTask[]>> = {};

  for (const t of tasks) {
    stageTasks[t.stage].push(t);
    (areaTasks[t.areaId] ??= []).push(t);
    (systemTasks[t.system] ??= []).push(t);
  }

  const byArea: Record<string, ProgressCounts> = {};
  for (const areaId of Object.keys(areaTasks)) {
    byArea[areaId] = withPct(countFrom(areaTasks[areaId] ?? []));
  }

  const bySystem: Partial<Record<CanonicalTaskSystem, ProgressCounts>> = {};
  for (const system of Object.keys(systemTasks) as CanonicalTaskSystem[]) {
    bySystem[system] = withPct(countFrom(systemTasks[system] ?? []));
  }

  return {
    job: withPct(countFrom(tasks)),
    byStage: {
      roughIn: withPct(countFrom(stageTasks.roughIn)),
      fitOff: withPct(countFrom(stageTasks.fitOff)),
    },
    byArea,
    bySystem,
  };
}

/**
 * Convenience: build the canonical index for a job + its task state and roll it
 * up in one call. Read-only; the same parity guarantee applies. Useful for a
 * future consumer that holds a `Job` + parsed `JobTaskState` and wants progress
 * without separately wiring `buildCanonicalTaskIndex`.
 */
export function rollUpJobTaskProgress(args: {
  job: Job;
  taskState?: JobTaskState | null;
}): TaskProgressRollup {
  return rollUpTaskProgress(buildCanonicalTaskIndex(args));
}
