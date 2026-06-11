import type { Job, JobArea, JobStage } from "./types";
import { effectiveTasks } from "./format";

/**
 * THE canonical job-progress definition (#198). One pure implementation,
 * rendered everywhere — the office and the field can never disagree.
 *
 * The definition:
 *   - A task counts as COMPLETE only when its recorded state is exactly
 *     "complete" (dwellings[areaId][stage].tasks[taskId]). `in_progress`
 *     counts as NOT complete — matching Phil's binary toggle semantics
 *     (taskState.ts nextToggleState).
 *   - Effective task lists resolve exactly as Phil resolves them
 *     (format.ts effectiveTasks): a non-empty per-area override wins, else
 *     the job-level default; ARCHIVED tasks are excluded.
 *   - Archived areas and archived area groups are excluded entirely.
 *   - Counts are first-class; a PERCENTAGE exists only where total > 0
 *     (progressPct returns null otherwise — render "No tasks yet", never
 *     0% or 100%).
 *   - Job-level progress is POOLED task counts (completeTasks/allTasks),
 *     not an average of area percentages — five one-task areas can't
 *     outvote one fifty-task area.
 *
 * The legacy api/handover-readiness.js percentages are explicitly
 * legacy-reports-only; api/_lib/job-tasks.js mirrors THIS math for the
 * CJS stats enrichment (parity-tested in progress.test.ts).
 */

/** dwellings[areaId][stage].tasks[taskId] → recorded task state string. */
export type DwellingsState = Record<
  string,
  Partial<Record<JobStage, { tasks?: Record<string, string> }>>
>;

export interface TaskCounts {
  total: number;
  complete: number;
}

const STAGES: ReadonlyArray<JobStage> = ["roughIn", "fitOff"];

function recordedStates(
  dwellings: DwellingsState | null | undefined,
  areaId: string,
  stage: JobStage,
): Record<string, string> {
  return dwellings?.[areaId]?.[stage]?.tasks ?? {};
}

/** Per-area, per-stage counts — the layer Phil's area detail renders. */
export function stageTaskCounts(
  job: Pick<Job, "roughInTasks" | "fitOffTasks">,
  area: Pick<JobArea, "id" | "roughInTasks" | "fitOffTasks">,
  stage: JobStage,
  dwellings: DwellingsState | null | undefined,
): TaskCounts {
  const tasks = effectiveTasks(job, area, stage);
  const states = recordedStates(dwellings, area.id, stage);
  let complete = 0;
  for (const t of tasks) if (states[t.id] === "complete") complete += 1;
  return { total: tasks.length, complete };
}

/** Per-area counts pooled across both stages. */
export function areaTaskCounts(
  job: Pick<Job, "roughInTasks" | "fitOffTasks">,
  area: Pick<JobArea, "id" | "roughInTasks" | "fitOffTasks">,
  dwellings: DwellingsState | null | undefined,
): TaskCounts {
  let total = 0;
  let complete = 0;
  for (const stage of STAGES) {
    const c = stageTaskCounts(job, area, stage, dwellings);
    total += c.total;
    complete += c.complete;
  }
  return { total, complete };
}

export interface JobProgress extends TaskCounts {
  /** Rounded 0–100, or null when the job has no tasks (render "No tasks yet"). */
  pct: number | null;
  byStage: Record<JobStage, TaskCounts>;
}

/** Whole-job pooled progress. Archived groups/areas excluded entirely. */
export function jobTaskProgress(
  job: Pick<Job, "roughInTasks" | "fitOffTasks" | "areaGroups">,
  dwellings: DwellingsState | null | undefined,
): JobProgress {
  const byStage: Record<JobStage, TaskCounts> = {
    roughIn: { total: 0, complete: 0 },
    fitOff: { total: 0, complete: 0 },
  };
  for (const group of job.areaGroups ?? []) {
    if (!group || group.archived) continue;
    for (const area of group.areas ?? []) {
      if (!area || area.archived) continue;
      for (const stage of STAGES) {
        const c = stageTaskCounts(job, area, stage, dwellings);
        byStage[stage].total += c.total;
        byStage[stage].complete += c.complete;
      }
    }
  }
  const total = byStage.roughIn.total + byStage.fitOff.total;
  const complete = byStage.roughIn.complete + byStage.fitOff.complete;
  return { total, complete, pct: progressPct({ total, complete }), byStage };
}

/** % only where a total exists — the honesty rule, in one place. */
export function progressPct(counts: TaskCounts): number | null {
  if (counts.total <= 0) return null;
  return Math.round((counts.complete / counts.total) * 100);
}

/** "8/30 done" / "No tasks yet" — the shared counts-first caption. */
export function progressCaption(counts: TaskCounts): string {
  if (counts.total === 0) return "No tasks yet";
  return `${counts.complete}/${counts.total} done`;
}
