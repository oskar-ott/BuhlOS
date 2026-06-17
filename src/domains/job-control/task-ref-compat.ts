import {
  canonicalTaskToCoordinate,
  findCanonicalTaskByCoordinate,
  resolveCanonicalTaskForCoordinate,
  taskCoordinateMatchesCanonicalTask,
  taskCoordinateToSource,
} from "../jobs/task-ref";
import type { CanonicalTask, CanonicalTaskSource } from "../jobs/task-index";
import type { Job, JobStage } from "../jobs/types";
import type { JobTaskState } from "../jobs/taskState";

/**
 * Job-control ↔ canonical-task compatibility (#483) — now a thin DELEGATE over
 * the surface-agnostic bridge in the jobs domain (`../jobs/task-ref`, #501).
 *
 * Job-control still identifies tasks by the legacy TUPLE coordinate
 * `{ areaId, stage, taskId }` (`TaskRef`, job-control/schema.ts) — the shape
 * stored in `WorkPackage.taskRefs`, resolved by `compile.resolveTaskRef`, and
 * keyed by `spine.taskRefKey`. The canonical index (#480) gives each materialised
 * instance a stable id. This module is job-control's view of that bridge.
 *
 * #501 relocated the resolution CORE into the jobs domain so every surface
 * (evidence, ITP/QA, the task-instance projection #500) shares ONE resolver
 * instead of importing job-control. These functions keep their original names,
 * signatures and behaviour and simply forward to that core — no fork, zero
 * behaviour change (the #483 tests still pass unchanged).
 *
 * What it is — and is NOT:
 *   - PURE translation/resolution helpers. NOT wired into compile, Phil,
 *     evidence, or the proof-status reader. Compile output, work-package ids,
 *     requiredEvidence ids, EvidenceLink shape and `isRequiredEvidenceMet` are
 *     untouched.
 *   - Legacy tuple refs remain first-class; canonical ids are not the only
 *     accepted ref. It does NOT migrate storage or rewrite `job-control.json`.
 *
 * Identity is the tuple, never the bare taskId: a job-level template inherited by
 * many areas shares a `taskId` but is a DISTINCT canonical task per area, so a
 * legacy ref for area A never resolves area B's instance.
 *
 * No import cycle: the jobs domain never imports job-control; job-control already
 * imports the jobs domain.
 *
 * Cross-ref:
 *   src/domains/jobs/task-ref.ts — the shared cross-surface bridge core (#501)
 *   src/domains/jobs/task-index.ts — CanonicalTask + source helpers
 *   src/domains/job-control/schema.ts — TaskRef (the legacy tuple)
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
 * (`CanonicalTaskSource`) — the coordinate the index materialises each canonical
 * task from. Delegates to the jobs-domain bridge.
 */
export function legacyTaskRefToCanonicalSource(ref: LegacyTaskRef): CanonicalTaskSource {
  return taskCoordinateToSource(ref);
}

/**
 * True when a legacy ref points at the given canonical task. Defers (through the
 * bridge) to the task-index's own predicate so the match rule has a single
 * source of truth.
 */
export function legacyTaskRefMatchesCanonicalTask(
  ref: LegacyTaskRef,
  task: CanonicalTask,
): boolean {
  return taskCoordinateMatchesCanonicalTask(ref, task);
}

/**
 * Find the canonical task a legacy ref resolves to within an already-built
 * index, or `null` when nothing matches. Tuple identity means a ref for one area
 * never matches another area's instance of the same template.
 */
export function findCanonicalTaskForLegacyRef(args: {
  canonicalTasks: ReadonlyArray<CanonicalTask>;
  ref: LegacyTaskRef;
}): CanonicalTask | null {
  return findCanonicalTaskByCoordinate(args.canonicalTasks, args.ref);
}

/**
 * Convert a canonical task back to its legacy tuple ref — exactly the
 * `(areaId, stage, taskId)` coordinate it was materialised from. For callers
 * that hold a canonical task but need to talk to legacy job-control / evidence
 * APIs that still expect the tuple.
 */
export function canonicalTaskToLegacyTaskRef(task: CanonicalTask): LegacyTaskRef {
  return canonicalTaskToCoordinate(task);
}

/**
 * Convenience resolver: build the canonical index for a job and resolve a single
 * legacy ref against it. Pure; cycle-free. Prefer `findCanonicalTaskForLegacyRef`
 * against a pre-built index when resolving many refs for one job, to avoid
 * rebuilding the index each call.
 */
export function resolveCanonicalTaskForTaskRef(args: {
  job: Job;
  taskState?: JobTaskState | null;
  ref: LegacyTaskRef;
}): CanonicalTask | null {
  return resolveCanonicalTaskForCoordinate({
    job: args.job,
    taskState: args.taskState ?? null,
    coord: args.ref,
  });
}
