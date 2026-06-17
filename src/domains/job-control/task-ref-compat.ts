import {
  buildCanonicalTaskIndex,
  canonicalTaskMatchesSource,
  type CanonicalTask,
  type CanonicalTaskSource,
} from "../jobs/task-index";
import type { Job, JobStage } from "../jobs/types";
import type { JobTaskState } from "../jobs/taskState";

/**
 * Job-control ↔ canonical-task compatibility (#483).
 *
 * Job-control still identifies tasks by the legacy TUPLE coordinate
 * `{ areaId, stage, taskId }` (`TaskRef`, job-control/schema.ts) — that is the
 * shape stored in `WorkPackage.taskRefs`, resolved by `compile.resolveTaskRef`,
 * and keyed by `spine.taskRefKey`. The canonical task index (#480) gives each
 * materialised task instance a stable id derived from `jobId+areaId+stage+taskId`
 * (`CanonicalTask.id`). This module is the BRIDGE between the two.
 *
 * What it is — and is NOT:
 *   - PURE translation/resolution helpers only. It is NOT wired into compile,
 *     Phil, evidence, or the proof-status reader. Compile output, work-package
 *     ids, requiredEvidence ids, EvidenceLink shape and `isRequiredEvidenceMet`
 *     are all untouched (zero behaviour change — this is foundation).
 *   - It does NOT make canonical ids the only accepted ref. Legacy tuple refs
 *     remain first-class; this just lets callers move between the two forms.
 *   - It does NOT migrate storage or rewrite `job-control.json`.
 *
 * Identity is the tuple, never the bare taskId: a job-level template inherited
 * by many areas shares a `taskId` but is a DISTINCT canonical task per area, so
 * a legacy ref for area A never resolves area B's instance. All matching defers
 * to the task-index's own `canonicalTaskMatchesSource` / `canonicalTaskSourceKey`
 * so there is ONE id/match rule and no duplicated derivation.
 *
 * No import cycle: the jobs domain never imports job-control, and job-control
 * already imports the jobs domain (see compile.ts).
 *
 * Cross-ref:
 *   src/domains/jobs/task-index.ts — CanonicalTask + source helpers
 *   src/domains/job-control/schema.ts — TaskRef (the legacy tuple)
 *   src/domains/job-control/compile.ts#resolveTaskRef — the legacy resolver
 *   docs/architecture/task-index.md §Job-control compatibility
 */

/**
 * The legacy job-control task coordinate. Structurally identical to the
 * job-control `TaskRef` (`z.infer<TaskRefSchema>` is exactly these three
 * fields), so a real `TaskRef` — e.g. an item of `WorkPackage.taskRefs` — is
 * assignable here and can be passed to any helper below without conversion.
 */
export interface LegacyTaskRef {
  areaId: string;
  stage: JobStage; // "roughIn" | "fitOff"
  taskId: string;
}

/**
 * Translate a legacy tuple ref into the task-index's source-coordinate shape
 * (`CanonicalTaskSource`). This is the coordinate the index materialises each
 * canonical task from, so it is the natural key for matching.
 */
export function legacyTaskRefToCanonicalSource(ref: LegacyTaskRef): CanonicalTaskSource {
  return { areaId: ref.areaId, stage: ref.stage, taskId: ref.taskId };
}

/**
 * True when a legacy ref points at the given canonical task. Defers to the
 * task-index's own predicate so the match rule has a single source of truth.
 */
export function legacyTaskRefMatchesCanonicalTask(
  ref: LegacyTaskRef,
  task: CanonicalTask,
): boolean {
  return canonicalTaskMatchesSource(task, legacyTaskRefToCanonicalSource(ref));
}

/**
 * Find the canonical task a legacy ref resolves to within an already-built
 * index, or `null` when nothing matches. Tuple identity means a ref for one
 * area never matches another area's instance of the same template.
 */
export function findCanonicalTaskForLegacyRef(args: {
  canonicalTasks: ReadonlyArray<CanonicalTask>;
  ref: LegacyTaskRef;
}): CanonicalTask | null {
  return args.canonicalTasks.find((t) => legacyTaskRefMatchesCanonicalTask(args.ref, t)) ?? null;
}

/**
 * Convert a canonical task back to its legacy tuple ref — exactly the
 * `(areaId, stage, taskId)` coordinate it was materialised from. The inverse of
 * resolving a ref; useful for callers that hold a canonical task but need to
 * talk to legacy job-control / evidence APIs that still expect the tuple.
 */
export function canonicalTaskToLegacyTaskRef(task: CanonicalTask): LegacyTaskRef {
  return {
    areaId: task.source.areaId,
    stage: task.source.stage,
    taskId: task.source.taskId,
  };
}

/**
 * Convenience resolver: build the canonical index for a job and resolve a single
 * legacy ref against it. Pure; cycle-free (job-control already depends on the
 * jobs domain). Prefer `findCanonicalTaskForLegacyRef` against a pre-built index
 * when resolving many refs for one job, to avoid rebuilding the index each call.
 */
export function resolveCanonicalTaskForTaskRef(args: {
  job: Job;
  taskState?: JobTaskState | null;
  ref: LegacyTaskRef;
}): CanonicalTask | null {
  const canonicalTasks = buildCanonicalTaskIndex({
    job: args.job,
    taskState: args.taskState ?? null,
  });
  return findCanonicalTaskForLegacyRef({ canonicalTasks, ref: args.ref });
}
