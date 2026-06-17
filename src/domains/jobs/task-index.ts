import { effectiveTasks } from "./format";
import { readTaskState, type JobTaskState, type TaskState } from "./taskState";
import type { Job, JobStage } from "./types";

/**
 * Canonical task index (#480) — a READ-ONLY derived model that materialises one
 * task instance per `(areaId, stage, taskId)` coordinate.
 *
 * Why this exists
 * ---------------
 * BuhlOS stores tasks as flat templates that live at the job level
 * (`Job.roughInTasks` / `fitOffTasks`) and are inherited by every area unless
 * the area overrides them. The real, state-bearing unit of work lives at
 * `dwellings[areaId][stage].tasks[taskId]` (progress.ts #198). So a bare
 * `taskId` is only a TEMPLATE id — the same id is materialised independently in
 * every inheriting area, and is NOT globally unique as a work instance.
 *
 * The task-model audit confirmed the real instance identity is the tuple
 * `(areaId, stage, taskId)`. This module turns that tuple into a stable,
 * deterministic canonical id so future work can treat tasks as job-level nodes
 * WITHOUT migrating storage.
 *
 * What this is NOT (deliberately, for #480)
 * -----------------------------------------
 *   - It changes NO storage, NO API, NO UI. Nothing consumes it yet.
 *   - It derives state ONLY from the existing stored three-state value
 *     (`not_started | in_progress | complete`) via the shared `readTaskState`
 *     — it never invents `ready` / `blocked` / `needs_review` / `signed_off`.
 *   - `system` is always `"general"`. Discipline inference (power / data /
 *     lighting / …) is #481, not here.
 *   - `areaRefs` is always `[areaId]`. Multi-area tasks are future work.
 *
 * Parity guarantee
 * ----------------
 * The materialisation walks the structure exactly as the canonical progress
 * definition does (non-archived groups → non-archived areas → both stages →
 * `effectiveTasks`, override-wins, archived templates excluded). So the index
 * length equals `jobTaskProgress(...).total` and the count of `complete`
 * canonical tasks equals `.complete` for the same job + state — proven in the
 * tests. Field and office can never disagree.
 *
 * Cross-ref:
 *   src/domains/jobs/format.ts#effectiveTasks — the plan resolver this mirrors
 *   src/domains/jobs/progress.ts — the canonical count definition (#198)
 *   src/domains/jobs/taskState.ts — JobTaskState + readTaskState (state source)
 *   src/domains/job-control/compile.ts#deriveWorkPackageId — the id pattern
 *   docs/architecture/task-index.md
 */

/** The two stages a task can sit in — aliased to the jobs domain so the two can
 *  never drift apart. */
export type CanonicalTaskStage = JobStage;

/** The stored runtime state — aliased to the jobs domain's TaskState so this
 *  index never introduces a second, divergent state vocabulary. */
export type CanonicalTaskState = TaskState;

/** Discipline classification. #480 only ever emits `general`; the real
 *  power/data/lighting enum lands with the inference slice (#481). */
export type CanonicalTaskSystem = "general";

/** The existing-storage coordinate a canonical task was materialised from. Kept
 *  on every task so callers can map a canonical id back to `(areaId, stage,
 *  taskId)` — i.e. back to `dwellings`, evidence, and job-control `TaskRef`. */
export interface CanonicalTaskSource {
  areaId: string;
  stage: CanonicalTaskStage;
  taskId: string;
}

/** One materialised task instance. */
export interface CanonicalTask {
  /** Stable, deterministic id derived from `jobId + areaId + stage + taskId`
   *  — never from the task name, never random. Unique per area, so an inherited
   *  template yields a DISTINCT id in each area (the bare-taskId hazard). */
  id: string;
  jobId: string;

  /** The originating template id (`task.id`). Shared across areas that inherit
   *  the same job-level template — preserved separately from `id` on purpose. */
  templateId: string;
  /** The template name (`task.name`). Display only; never identity. */
  title: string;

  /** The area this instance belongs to. */
  areaId: string;
  /** Areas this task relates to. Always `[areaId]` for #480 (single-area). */
  areaRefs: string[];

  stage: CanonicalTaskStage;
  /** Read from the stored task state; missing reads as `not_started`. */
  state: CanonicalTaskState;

  system: CanonicalTaskSystem;

  /** The existing-storage coordinate (back-compat / round-trip key). */
  source: CanonicalTaskSource;
}

const STAGES: ReadonlyArray<CanonicalTaskStage> = ["roughIn", "fitOff"];

/**
 * FNV-1a (32-bit) → 8 hex chars. Deterministic, no randomness, no time — the
 * SAME pattern as `deriveWorkPackageId` in job-control/compile.ts, re-implemented
 * here so the jobs domain carries no dependency on the job-control domain.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The canonical id for a task coordinate. Deterministic and stable: the same
 * tuple always yields the same `ct_…` id, and a different area/stage/job yields
 * a different id. NEVER derived from the task name.
 */
export function deriveCanonicalTaskId(input: {
  jobId: string;
  areaId: string;
  stage: CanonicalTaskStage;
  taskId: string;
}): string {
  return `ct_${fnv1a(`${input.jobId}::${input.areaId}::${input.stage}::${input.taskId}`)}`;
}

/**
 * A stable string key for the existing-storage coordinate — for grouping /
 * lookup against `dwellings`, evidence, or job-control `TaskRef`. Pure.
 */
export function canonicalTaskSourceKey(input: {
  areaId: string;
  stage: CanonicalTaskStage;
  taskId: string;
}): string {
  return `${input.areaId}::${input.stage}::${input.taskId}`;
}

/**
 * True when a canonical task was materialised from the given coordinate. Pure
 * convenience over `canonicalTaskSourceKey`. NOT wired into job-control yet
 * (that mapping is #483).
 */
export function canonicalTaskMatchesSource(
  task: CanonicalTask,
  source: { areaId: string; stage: CanonicalTaskStage; taskId: string },
): boolean {
  return canonicalTaskSourceKey(task.source) === canonicalTaskSourceKey(source);
}

/**
 * Build the canonical task index for a job. Pure and read-only.
 *
 * Walks non-archived groups → non-archived areas → both stages → `effectiveTasks`
 * (override-wins, archived templates excluded), emitting one `CanonicalTask` per
 * effective task. State comes from `taskState` via `readTaskState` (missing ⇒
 * `not_started`). Passing no state yields every task as `not_started`.
 */
export function buildCanonicalTaskIndex(args: {
  job: Job;
  taskState?: JobTaskState | null;
}): CanonicalTask[] {
  const { job } = args;
  const taskState = args.taskState ?? {};
  const jobId = job.id;
  const out: CanonicalTask[] = [];

  for (const group of job.areaGroups ?? []) {
    if (!group || group.archived) continue;
    for (const area of group.areas ?? []) {
      if (!area || area.archived) continue;
      for (const stage of STAGES) {
        for (const template of effectiveTasks(job, area, stage)) {
          const source: CanonicalTaskSource = {
            areaId: area.id,
            stage,
            taskId: template.id,
          };
          out.push({
            id: deriveCanonicalTaskId({ jobId, areaId: area.id, stage, taskId: template.id }),
            jobId,
            templateId: template.id,
            title: template.name,
            areaId: area.id,
            areaRefs: [area.id],
            stage,
            state: readTaskState(taskState, area.id, stage, template.id),
            system: "general",
            source,
          });
        }
      }
    }
  }

  return out;
}
