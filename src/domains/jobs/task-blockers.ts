import type { CanonicalTask } from "./task-index";

/**
 * Task blockers & readiness — a READ-ONLY domain model (#482).
 *
 * The task-model direction is: dependencies connect tasks (across areas), and
 * blockers explain why a task cannot proceed. This module defines the SHAPE of
 * that model and the pure helpers to derive readiness from it. It is the
 * foundation a future admin/Phil "why isn't this ready?" view will read.
 *
 * What it is — and is NOT (deliberately, for #482):
 *   - PURE types + functions. It persists NOTHING, has no API, no UI, no route.
 *   - It does NOT derive blockers from real variations / observations /
 *     material-requests yet. Those are real adjacent signals (variation-approval
 *     blockers, WorkPackage warnings, RFI observations) but wiring them in is a
 *     later slice — keeping this a shape module avoids guessing a mapping.
 *   - It does NOT change storage, compile output, proof/evidence, or ITP/QA.
 *
 * Identity: blockers and dependencies reference tasks by their CANONICAL task id
 * (`CanonicalTask.id`, derived from jobId+areaId+stage+taskId, #480). That id is
 * job-level and unique per instance, so a dependency can cross areas safely —
 * "area B fit-off waits on area A rough-in" is just two canonical ids. Bare
 * `taskId` (a template id) is never used as identity here.
 *
 * Cross-ref:
 *   src/domains/jobs/task-index.ts — CanonicalTask (state + id)
 *   src/domains/job-control/task-ref-compat.ts — legacy TaskRef ↔ canonical (#483)
 *   docs/architecture/task-blockers.md
 */

/** Why a task is held up. `task` = another task must finish first; the rest are
 *  external causes (materials, site access, an RFI answer, a drawing, an
 *  approval, an inspection, or a party — builder/client/supplier). */
export type TaskBlockerType =
  | "task"
  | "material"
  | "access"
  | "rfi"
  | "drawing"
  | "approval"
  | "inspection"
  | "builder"
  | "client"
  | "supplier"
  | "other";

export type TaskBlockerStatus = "open" | "resolved";

/** Who owns clearing the blocker. */
export type TaskBlockerOwnerType = "internal" | "builder" | "client" | "supplier" | "unknown";

/**
 * One reason a task is held up. References the blocked task by canonical id.
 * `id` is supplied by the caller (this module never mints ids — no random, no
 * name-derived identity). Not persisted by anything in #482.
 */
export interface TaskBlocker {
  id: string;
  /** The blocked task → `CanonicalTask.id`. */
  taskId: string;
  type: TaskBlockerType;
  title: string;
  description?: string;
  status: TaskBlockerStatus;
  /** When `type === "task"`: the task that raised / owns this blocker. */
  sourceTaskId?: string;
  /** When `type === "task"`: the prerequisite task that must finish first. */
  blockingTaskId?: string;
  /** Areas this blocker relates to (metadata for future views). */
  areaRefs?: string[];
  ownerType?: TaskBlockerOwnerType;
  ownerName?: string;
}

/** A directed prerequisite edge: `taskId` cannot proceed until `dependsOnTaskId`
 *  is complete. Both are canonical task ids, so the edge may cross areas. */
export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
}

/** The three readiness states this model derives. `complete` is a real,
 *  terminal state (the task is done); `ready`/`blocked` are derived. */
export type TaskReadiness = "ready" | "blocked" | "complete";

/**
 * From a set of dependency edges, return the ones currently BLOCKING — i.e.
 * whose prerequisite (`dependsOnTaskId`) is not a complete task in `tasks`.
 * Conservative: a prerequisite that is missing from `tasks` (unknown) counts as
 * blocking, never silently satisfied.
 */
export function findBlockingDependencies(args: {
  tasks: ReadonlyArray<CanonicalTask>;
  dependencies: ReadonlyArray<TaskDependency>;
}): TaskDependency[] {
  const byId = new Map(args.tasks.map((t) => [t.id, t]));
  return args.dependencies.filter((dep) => {
    const prerequisite = byId.get(dep.dependsOnTaskId);
    return !prerequisite || prerequisite.state !== "complete";
  });
}

/** True when the task has at least one OPEN blocker. Resolved blockers don't
 *  count. Keyed by canonical task id. */
export function taskHasOpenBlockers(args: {
  taskId: string;
  blockers: ReadonlyArray<TaskBlocker>;
}): boolean {
  return args.blockers.some((b) => b.taskId === args.taskId && b.status === "open");
}

/**
 * Derive a task's readiness. Conservative and ordered:
 *   1. the task is already complete           → "complete"
 *   2. it has an open blocker                  → "blocked"
 *   3. a dependency is incomplete or missing   → "blocked"
 *   4. otherwise                               → "ready"
 *
 * `dependencies`/`blockers`/`tasks` are all optional; with none supplied a
 * not-yet-complete task is simply "ready". Dependency checks need `tasks` to
 * know whether a prerequisite is complete — an unresolved/absent prerequisite
 * blocks (never assumed done).
 */
export function deriveTaskReadiness(args: {
  task: CanonicalTask;
  dependencies?: ReadonlyArray<TaskDependency>;
  blockers?: ReadonlyArray<TaskBlocker>;
  tasks?: ReadonlyArray<CanonicalTask>;
}): TaskReadiness {
  if (args.task.state === "complete") return "complete";

  if (args.blockers && taskHasOpenBlockers({ taskId: args.task.id, blockers: args.blockers })) {
    return "blocked";
  }

  const edges = (args.dependencies ?? []).filter((d) => d.taskId === args.task.id);
  if (edges.length > 0) {
    const blocking = findBlockingDependencies({ tasks: args.tasks ?? [], dependencies: edges });
    if (blocking.length > 0) return "blocked";
  }

  return "ready";
}
