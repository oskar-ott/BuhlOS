import {
  buildCanonicalTaskIndex,
  canonicalTaskMatchesSource,
  canonicalTaskSourceKey,
  deriveCanonicalTaskId,
  type CanonicalTask,
  type CanonicalTaskSource,
} from "./task-index";
import type { Job } from "./types";
import type { JobTaskState } from "./taskState";

/**
 * Cross-surface task-ref bridge (#501) — the surface-AGNOSTIC core that resolves
 * between a task coordinate `(areaId, stage, taskId)` and a canonical task
 * instance, in BOTH directions, against a job's canonical index (#480).
 *
 * Why this lives here (and not in job-control)
 * --------------------------------------------
 * The first bridge shipped inside job-control (`task-ref-compat.ts`, #483 —
 * deleted with job-control by the 2026-07-27 gut)
 * because that is where the legacy `TaskRef` tuple lives. But the SAME resolution
 * is needed by every other surface that holds a tuple — evidence, ITP/QA, the
 * task-instance projection (#500), future facets. Re-using a job-control module
 * from those surfaces would couple them to job-control for no reason. So the
 * shared core lives in the jobs domain (next to the index it resolves against),
 * and job-control's `task-ref-compat` delegated to it until the gut removed it
 * (its public API and
 * behaviour are unchanged — see that file). No fork, one resolver.
 *
 * No import cycle: the jobs domain never imports job-control; job-control imports
 * the jobs domain. Putting the core here keeps that direction intact.
 *
 * What it is — and is NOT (deliberately, for #501)
 * ------------------------------------------------
 *   - PURE resolution helpers. NO storage, NO API, NO Phil/UI, NO write path.
 *     `TaskRef {areaId, stage, taskId}` stays the stored/wire shape on every
 *     surface — nothing is migrated (that is #508, last, with its own ADR).
 *   - Identity is the TUPLE, never the bare `taskId` (a template id shared across
 *     areas). All matching defers to the index's own
 *     `canonicalTaskMatchesSource` / `canonicalTaskSourceKey` so there is ONE
 *     id/match rule and no duplicated derivation.
 *   - It adds NO new identity and NO duplicate `TaskInstance` model — it resolves
 *     to the existing `CanonicalTask` / `ct_<hash>`. `taskInstanceId` is a target
 *     term only (CLAUDE.md); `ct_` is the bridge toward it.
 *   - The `ct_ → tuple` direction needs the index (a hash is not reversible), so
 *     those helpers take the materialised index, exactly like the forward ones.
 *
 * Cross-ref:
 *   src/domains/jobs/task-index.ts — CanonicalTask + id/source primitives
 *   docs/architecture/task-led-job-architecture.md — "The compatibility bridge"
 */

/**
 * A surface-neutral task coordinate: the `(areaId, stage, taskId)` tuple that is
 * the stored/wire identity on every surface today (job-control `TaskRef`,
 * evidence coordinates, `dwellings` keys). Structurally identical to
 * `CanonicalTaskSource` — declared as an alias so callers on any surface import
 * one clearly-named bridge type.
 */
export type TaskCoordinate = CanonicalTaskSource;

/** Normalise any coordinate-shaped value to a clean `CanonicalTaskSource`. */
export function taskCoordinateToSource(coord: TaskCoordinate): CanonicalTaskSource {
  return { areaId: coord.areaId, stage: coord.stage, taskId: coord.taskId };
}

/** A stable string key for a coordinate — the single key rule (defers to the
 *  index). Useful for Map/Set lookups across surfaces. */
export function taskCoordinateKey(coord: TaskCoordinate): string {
  return canonicalTaskSourceKey(coord);
}

/** True when a coordinate points at the given canonical task. Defers to the
 *  index's predicate so the match rule has one source of truth. */
export function taskCoordinateMatchesCanonicalTask(
  coord: TaskCoordinate,
  task: CanonicalTask,
): boolean {
  return canonicalTaskMatchesSource(task, taskCoordinateToSource(coord));
}

/**
 * The canonical `ct_<hash>` id for a coordinate, without needing the index — a
 * thin, coordinate-shaped wrapper over `deriveCanonicalTaskId`. Deterministic,
 * tuple-derived, never name-based.
 */
export function canonicalIdForCoordinate(jobId: string, coord: TaskCoordinate): string {
  return deriveCanonicalTaskId({
    jobId,
    areaId: coord.areaId,
    stage: coord.stage,
    taskId: coord.taskId,
  });
}

// ── Forward: coordinate → canonical task ──────────────────────────────────────

/**
 * Find the canonical task a coordinate resolves to within an already-built
 * index, or `null` when nothing matches. Tuple identity means a coordinate for
 * one area never matches another area's instance of the same template.
 */
export function findCanonicalTaskByCoordinate(
  canonicalTasks: ReadonlyArray<CanonicalTask>,
  coord: TaskCoordinate,
): CanonicalTask | null {
  return canonicalTasks.find((t) => taskCoordinateMatchesCanonicalTask(coord, t)) ?? null;
}

// ── Reverse: canonical id / task → coordinate ─────────────────────────────────

/** The coordinate a canonical task was materialised from. The inverse of
 *  resolving a coordinate — for callers holding a task but talking to a
 *  tuple-keyed surface (evidence, job-control, `dwellings`). */
export function canonicalTaskToCoordinate(task: CanonicalTask): TaskCoordinate {
  return {
    areaId: task.source.areaId,
    stage: task.source.stage,
    taskId: task.source.taskId,
  };
}

/**
 * Find a canonical task by its `ct_<hash>` id within an already-built index, or
 * `null`. This is the direction the #483 bridge lacked: a surface holding only a
 * canonical id (no tuple) can recover the instance. The index is required — the
 * id is a one-way hash and is not reversible on its own.
 */
export function findCanonicalTaskById(
  canonicalTasks: ReadonlyArray<CanonicalTask>,
  id: string,
): CanonicalTask | null {
  return canonicalTasks.find((t) => t.id === id) ?? null;
}

/**
 * Resolve a `ct_<hash>` id back to its `(areaId, stage, taskId)` coordinate
 * against an index, or `null` when the id isn't in the index. Completes the
 * round-trip: `coordinate → id → coordinate`.
 */
export function coordinateForCanonicalId(
  canonicalTasks: ReadonlyArray<CanonicalTask>,
  id: string,
): TaskCoordinate | null {
  const task = findCanonicalTaskById(canonicalTasks, id);
  return task ? canonicalTaskToCoordinate(task) : null;
}

// ── Job-level convenience resolvers (build the index, then resolve) ───────────

/**
 * Build the canonical index for a job and resolve a single coordinate against
 * it. Pure; cycle-free. Prefer `findCanonicalTaskByCoordinate` against a
 * pre-built index when resolving many coordinates for one job, to avoid
 * rebuilding the index each call.
 */
export function resolveCanonicalTaskForCoordinate(args: {
  job: Job;
  taskState?: JobTaskState | null;
  coord: TaskCoordinate;
}): CanonicalTask | null {
  const canonicalTasks = buildCanonicalTaskIndex({
    job: args.job,
    taskState: args.taskState ?? null,
  });
  return findCanonicalTaskByCoordinate(canonicalTasks, args.coord);
}

/**
 * Build the canonical index for a job and resolve a single `ct_<hash>` id
 * against it. The reverse-direction sibling of
 * `resolveCanonicalTaskForCoordinate`.
 */
export function resolveCanonicalTaskById(args: {
  job: Job;
  taskState?: JobTaskState | null;
  id: string;
}): CanonicalTask | null {
  const canonicalTasks = buildCanonicalTaskIndex({
    job: args.job,
    taskState: args.taskState ?? null,
  });
  return findCanonicalTaskById(canonicalTasks, args.id);
}
