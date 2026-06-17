import {
  type CanonicalTask,
  type CanonicalTaskStage,
  type CanonicalTaskSystem,
} from "./task-index";
import {
  deriveTaskReadiness,
  type TaskBlocker,
  type TaskDependency,
  type TaskReadiness,
} from "./task-blockers";

/**
 * Read-only task-instance projection (#500) — the first forward slice of the
 * task-led migration (epic #479).
 *
 * The principle (docs/architecture/task-led-job-architecture.md): a job's
 * operational spine is the TASK INSTANCE, and area / stage / system / worker /
 * blocker / proof / QA / material / RFI are FACETS of it; every list (an area
 * page, a system column, a worker's day, a blocked list) is a VIEW — a
 * projection over task instances.
 *
 * This module is exactly that projection layer, and nothing more. It composes
 * the facet read-models that already shipped into one task-instance shape and
 * offers the multi-view filters — over the EXISTING canonical task index. It is
 * the read surface later phases (proof keying #502, real blockers #504, QA/ITP
 * #505, facets #506, progress roll-up #507) read through.
 *
 * What it is — and is NOT (deliberately, for #500)
 * ------------------------------------------------
 *   - It REUSES `CanonicalTask` / `ct_<hash>` as the task-instance seam.
 *     `TaskInstanceView` is `CanonicalTask & { facets }` — it adds NO second
 *     identity and NO competing model. `taskInstanceId` is a target term only
 *     (CLAUDE.md); the canonical `ct_` id is the bridge toward it.
 *   - PURE + READ-ONLY. No storage, no API, no write path, no Phil change. It
 *     changes nothing a worker sees, taps, or writes; `/api/task-toggle` is
 *     untouched. Nothing in the app consumes this yet.
 *   - It NEVER treats a bare `taskId` (a template id, shared across areas) as
 *     job-level identity. Filters key on the instance coordinate
 *     (`source.areaId` / `source.stage`), exactly like
 *     `workerTasksFromCanonicalIndex` (#490). The full coordinate is preserved
 *     on `task.source` for write/round-trip compatibility (the bridge).
 *
 * Facet honesty (P7 — never fake a value)
 * ---------------------------------------
 *   - area / stage / system: first-class fields ALREADY on `CanonicalTask`
 *     (#480/#481). The facets object surfaces them so a caller has one uniform
 *     facet accessor; they are not re-derived.
 *   - readiness + open blockers: composed IN-DOMAIN from the #482 read-model
 *     (`deriveTaskReadiness`). #482 is honest-empty — it derives `blocked` only
 *     from real `TaskBlocker` / `TaskDependency` data, and nothing produces that
 *     on `main` yet — so with no inputs every not-complete task is `ready` and
 *     every done task `complete`. Real sources are wired in #504.
 *   - proof: required proof lives in the job-control domain and is
 *     AREA/PACKAGE-granular today (docs/architecture/proof-review-model.md). The
 *     jobs domain must not import job-control (that would invert the dependency
 *     and create a cycle — see task-index.ts), so the proof facet is INJECTED by
 *     the caller via `proofFor`. It carries `granularity: "area-package"` to stay
 *     honest that it is not per-task-instance yet (#502).
 *   - worker / material / rfi: no per-task source exists on `main`, so these are
 *     always `null` — never invented. They light up in later facet slices (#506).
 *
 * Cross-ref:
 *   src/domains/jobs/task-index.ts — CanonicalTask + buildCanonicalTaskIndex
 *   src/domains/jobs/task-blockers.ts — readiness/blocker read-model (#482)
 *   src/domains/jobs/phil-task-projection.ts — the Phil worker-row projection (#490/#493)
 *   src/domains/job-control/task-context.ts — summarisePhilTaskProof (proof source, injected)
 *   docs/architecture/task-led-job-architecture.md
 */

/**
 * A task's required-proof facet. A structural mirror of job-control's
 * `PhilTaskProofSummary` plus an explicit `granularity` tag, declared locally so
 * the jobs domain stays free of any job-control import. The caller maps a
 * `summarisePhilTaskProof(ctx)` result into this (see the integration test).
 *
 * `granularity: "area-package"` is load-bearing honesty: proof is keyed by work
 * package (area) today, so every task the package delivers shares this summary —
 * it is NOT a per-task-instance signal yet (#502).
 */
export interface TaskInstanceProofFacet {
  requiredCount: number;
  metCount: number;
  missingCount: number;
  eligibleForReview: boolean;
  granularity: "area-package";
}

/**
 * The composed facets of one task instance. `area`/`stage`/`system` echo the
 * first-class `CanonicalTask` fields (uniform accessor, not re-derived);
 * `readiness`/`hasOpenBlockers`/`blockerIds` come from the #482 model; `proof`
 * is injected; the deferred facets are honestly `null`.
 */
export interface TaskInstanceFacets {
  areaId: string;
  stage: CanonicalTaskStage;
  system: CanonicalTaskSystem;

  /** From #482 `deriveTaskReadiness`. Honest-empty: `ready`/`complete` until a
   *  real blocker/dependency source is wired (#504). */
  readiness: TaskReadiness;
  /** True when this instance has ≥1 OPEN blocker (keyed by canonical id). */
  hasOpenBlockers: boolean;
  /** Ids of this instance's OPEN blockers (empty when none — never faked). */
  blockerIds: string[];

  /** Injected, area/package-granular today; `null` when no proof context is
   *  supplied or the task's package carries no required proof. */
  proof: TaskInstanceProofFacet | null;

  /** Facets with no per-task source on `main` yet — always `null` (P7, never
   *  faked). Light up in later slices (#506 facets, #504 real blockers). */
  worker: null;
  material: null;
  rfi: null;
}

/** A task instance with its composed facets. REUSES `CanonicalTask` (and its
 *  `ct_` id + `source` coordinate) — it is not a new model. */
export type TaskInstanceView = CanonicalTask & { facets: TaskInstanceFacets };

// ── Multi-view filters — every list is a projection over the same instances ───
// Generic over `T extends CanonicalTask` so filtering an already-projected
// `TaskInstanceView[]` returns `TaskInstanceView[]` (facets preserved), and a
// raw `CanonicalTask[]` returns `CanonicalTask[]`. All filter on the INSTANCE
// coordinate, never the bare `taskId`.

/** Tasks whose instance lives in `areaId` (the area facet / area view). */
export function tasksByArea<T extends CanonicalTask>(
  tasks: ReadonlyArray<T>,
  areaId: string,
): T[] {
  return tasks.filter((t) => t.source.areaId === areaId);
}

/** Tasks in `stage` (the stage facet / stage column). */
export function tasksByStage<T extends CanonicalTask>(
  tasks: ReadonlyArray<T>,
  stage: CanonicalTaskStage,
): T[] {
  return tasks.filter((t) => t.source.stage === stage);
}

/** Tasks classified to `system` (the system facet / system view). */
export function tasksBySystem<T extends CanonicalTask>(
  tasks: ReadonlyArray<T>,
  system: CanonicalTaskSystem,
): T[] {
  return tasks.filter((t) => t.system === system);
}

/** Group instances by area id — the area projection as a lookup. Pure. */
export function groupTaskInstancesByArea<T extends CanonicalTask>(
  tasks: ReadonlyArray<T>,
): Map<string, T[]> {
  return groupBy(tasks, (t) => t.source.areaId);
}

/** Group instances by stage — the stage projection as a lookup. Pure. */
export function groupTaskInstancesByStage<T extends CanonicalTask>(
  tasks: ReadonlyArray<T>,
): Map<CanonicalTaskStage, T[]> {
  return groupBy(tasks, (t) => t.source.stage);
}

/** Group instances by system — the system projection as a lookup. Pure. */
export function groupTaskInstancesBySystem<T extends CanonicalTask>(
  tasks: ReadonlyArray<T>,
): Map<CanonicalTaskSystem, T[]> {
  return groupBy(tasks, (t) => t.system);
}

function groupBy<T, K>(items: ReadonlyArray<T>, keyOf: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = out.get(key);
    if (bucket) bucket.push(item);
    else out.set(key, [item]);
  }
  return out;
}

// ── Projection (compose facets onto an instance) ──────────────────────────────

/** Optional pre-resolved facet inputs for ONE instance. */
export interface TaskInstanceFacetInput {
  readiness?: TaskReadiness;
  hasOpenBlockers?: boolean;
  blockerIds?: string[];
  proof?: TaskInstanceProofFacet | null;
}

/**
 * Project a single `CanonicalTask` into a `TaskInstanceView`. Pure; no side
 * effects; preserves the `ct_` id and the full `source` coordinate.
 *
 * With no facet input, readiness falls back to the task's own state
 * (`complete` → `complete`, else `ready`) and all derived/injected facets are
 * empty — the honest-empty default. Use `projectTaskInstances` to compose
 * readiness across a whole index (it needs the sibling tasks for dependency
 * checks).
 */
export function toTaskInstanceView(
  task: CanonicalTask,
  facets: TaskInstanceFacetInput = {},
): TaskInstanceView {
  return {
    ...task,
    facets: {
      areaId: task.areaId,
      stage: task.stage,
      system: task.system,
      readiness: facets.readiness ?? (task.state === "complete" ? "complete" : "ready"),
      hasOpenBlockers: facets.hasOpenBlockers ?? false,
      blockerIds: facets.blockerIds ?? [],
      proof: facets.proof ?? null,
      worker: null,
      material: null,
      rfi: null,
    },
  };
}

/** Context for composing a whole index's worth of task-instance views. */
export interface ProjectTaskInstancesContext {
  /** #482 dependency edges (canonical ids). Honest-empty by default. */
  dependencies?: ReadonlyArray<TaskDependency>;
  /** #482 blockers (canonical ids). Honest-empty by default. */
  blockers?: ReadonlyArray<TaskBlocker>;
  /** Caller-injected proof facet per instance (job-control lives outside this
   *  domain). Return `null` for a task with no required proof. */
  proofFor?: (task: CanonicalTask) => TaskInstanceProofFacet | null;
}

/**
 * Project a whole canonical index into task-instance views, composing readiness
 * from the #482 model and proof from the injected resolver. Pure; read-only;
 * the input array is not mutated and order is preserved.
 *
 * Readiness is derived per CANONICAL instance, and the dependency-completeness
 * check is run against the WHOLE index (a prerequisite can live in another area
 * — cross-area dependencies, #482).
 */
export function projectTaskInstances(
  tasks: ReadonlyArray<CanonicalTask>,
  ctx: ProjectTaskInstancesContext = {},
): TaskInstanceView[] {
  const { dependencies, blockers, proofFor } = ctx;
  return tasks.map((task) => {
    const openBlockers = (blockers ?? []).filter(
      (b) => b.taskId === task.id && b.status === "open",
    );
    return toTaskInstanceView(task, {
      readiness: deriveTaskReadiness({ task, dependencies, blockers, tasks }),
      hasOpenBlockers: openBlockers.length > 0,
      blockerIds: openBlockers.map((b) => b.id),
      proof: proofFor ? proofFor(task) : null,
    });
  });
}
