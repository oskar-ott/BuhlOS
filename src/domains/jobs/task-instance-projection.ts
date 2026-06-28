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
 *
 * Grain-tagged facets — assignee / labour / material / drawing / rfi (#506)
 * -------------------------------------------------------------------------
 * Every facet ALWAYS carries an explicit `grain` (and a `reason` when empty), so
 * an absent source renders "not task-grained yet" — it is NEVER silently omitted
 * and NEVER faked. The grain is the load-bearing honesty (P7): a facet says where
 * its data is keyed (`task` / `area-package` / `job` / `none`), so the reader can
 * never mistake job-grained or absent data for a per-task signal.
 *
 *   - assignee: NO per-task assignee source exists on `main` (visibility is the
 *     job-grained `assignedJobIds`, never a per-task owner). The facet is
 *     ALWAYS honest-empty (`grain: "none"`) — there is no resolver and no input
 *     path, so it is STRUCTURALLY INCAPABLE of being faked. It lights up with no
 *     projection rewrite the day a per-task assignee field lands (a separate
 *     write issue, NOT this one — #134/#340 territory).
 *   - labour: hours are `jobId`-only (the timesheet/hours ledger keys to a job,
 *     never a task). The facet is ALWAYS `grain: "job"` honest-empty — NEVER a
 *     per-task split (P7) — which deliberately keeps the sensitive timesheet /
 *     payroll surface out of this read model. No resolver, no input path. It
 *     lights up with no rewrite the day a task-grained `TimeEntryAllocation`
 *     lands (#134/#334 — and those pull in payroll, out of scope here).
 *   - material: area/package-granular today (#368 compiles `WorkPackage.materials`
 *     for the area that delivers the task). INJECTED via `materialsFor`; honest
 *     `grain: "area-package"` with zero items when the package carries none.
 *   - drawing: area/package-granular today (#368 `governingDocRefs`). INJECTED via
 *     `drawingsFor`; honest `grain: "area-package"` with zero docs when none.
 *   - rfi: the ONE genuinely task-grained facet — derived IN-DOMAIN from the #504
 *     blockers already passed to `projectTaskInstances` (an open `rfi`-typed
 *     `TaskBlocker` keyed on the canonical id). `grain: "task"` with the open rfi
 *     ids/titles, or honest-empty `grain: "none"` when the task has none.
 *
 * Dependency direction is preserved: material/drawing facet shapes are STRUCTURAL
 * MIRRORS declared LOCALLY (like `TaskInstanceProofFacet` mirrors job-control's
 * `PhilTaskProofSummary`) so the jobs domain still imports NOTHING from
 * job-control. The caller maps a `buildPhilTaskContext` result into the injected
 * resolvers (see the integration test).
 *
 * Strictly READ-ONLY (#506 scope guard): no per-task assignee field, no
 * task-grained labour write, no new authoring or write path of any kind. The
 * NOTE on #367: `buildAreaTaskContext` returns empty until the #367 plumbing
 * lands, so `materialsFor`/`drawingsFor` resolve empty on real jobs today — that
 * is ON-SPEC (grain `area-package`, zero items = honest-empty), and the facet
 * lights up with no rewrite once #367 flows.
 *
 * Cross-ref:
 *   src/domains/jobs/task-index.ts — CanonicalTask + buildCanonicalTaskIndex
 *   src/domains/jobs/task-blockers.ts — readiness/blocker read-model (#482), TaskBlockerType (#504)
 *   src/domains/jobs/phil-task-projection.ts — the Phil worker-row projection (#490/#493)
 *   src/domains/job-control/task-context.ts — summarisePhilTaskProof / buildPhilTaskContext (injected sources)
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

// ── #506 grain-tagged facets ──────────────────────────────────────────────────
// Each facet ALWAYS carries a `grain` discriminator so an absent source renders
// "not task-grained yet", never silently omitted, never faked (P7). The
// material/drawing shapes are STRUCTURAL MIRRORS of job-control's
// `WorkPackageMaterial` / `GoverningDocRef`, declared LOCALLY so the jobs domain
// imports nothing from job-control (dependency direction preserved — see header).

/** A material item delivered to a task's package. Structural mirror of
 *  job-control's `WorkPackageMaterial` (label + optional qty/unit), declared
 *  locally. `boqLineRef` and any compiler-added fields ride through untyped
 *  (the source schema is `.passthrough()`), so the resolver may inject the
 *  package's items byte-for-byte without this domain importing the source type. */
export interface TaskInstanceMaterial {
  label: string;
  qty?: number | null;
  unit?: string | null;
  [extra: string]: unknown;
}

/** An id-only reference into the documents/plans register. Structural mirror of
 *  job-control's `GoverningDocRef`, declared locally. */
export interface TaskInstanceGoverningDoc {
  documentId: string;
  label?: string | null;
  [extra: string]: unknown;
}

/**
 * Who is on a task. ALWAYS honest-empty: `main` has NO per-task assignee source
 * (visibility is the job-grained `assignedJobIds`, never a per-task owner), and
 * this facet has NO resolver and NO input path — it is structurally incapable of
 * carrying a faked per-task value. Lights up with no projection rewrite the day a
 * per-task assignee field lands (a separate write issue, not #506).
 */
export interface AssigneeFacet {
  grain: "none";
  reason: "no per-task assignee source";
}

/**
 * Labour on a task. ALWAYS `grain: "job"` honest-empty: hours are `jobId`-only
 * (the hours ledger keys to a job, never a task), so this is NEVER a per-task
 * split (P7) — which keeps the sensitive timesheet/payroll surface out of this
 * read model. No resolver, no input path. Lights up with no rewrite the day a
 * task-grained `TimeEntryAllocation` lands (#134/#334 — payroll, out of scope).
 */
export interface LabourFacet {
  grain: "job";
  reason: "hours are jobId-only";
}

/** Materials on a task. `area-package` granular (the package that delivers the
 *  task), injected via `materialsFor`; honest-empty `grain: "none"` when no
 *  resolver is supplied or the task belongs to no package. */
export type MaterialFacet =
  | { grain: "area-package"; items: TaskInstanceMaterial[] }
  | { grain: "none"; reason: "no task-grained material source" };

/** Governing drawings/specs on a task. `area-package` granular, injected via
 *  `drawingsFor`; honest-empty `grain: "none"` otherwise. */
export type DrawingFacet =
  | { grain: "area-package"; docs: TaskInstanceGoverningDoc[] }
  | { grain: "none"; reason: "no task-grained drawing source" };

/** Open RFIs on a task. The ONE genuinely task-grained facet — derived in-domain
 *  from the open `rfi`-typed `TaskBlocker`s (#504) keyed on the canonical id;
 *  honest-empty `grain: "none"` when the task has none. */
export type RfiFacet =
  | { grain: "task"; openRfiIds: string[]; titles: string[] }
  | { grain: "none"; reason: "no open task RFI" };

const ASSIGNEE_NONE: AssigneeFacet = { grain: "none", reason: "no per-task assignee source" };
const LABOUR_JOB: LabourFacet = { grain: "job", reason: "hours are jobId-only" };
const MATERIAL_NONE: MaterialFacet = { grain: "none", reason: "no task-grained material source" };
const DRAWING_NONE: DrawingFacet = { grain: "none", reason: "no task-grained drawing source" };
const RFI_NONE: RfiFacet = { grain: "none", reason: "no open task RFI" };

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

  /** Who is on the task. ALWAYS honest-empty `grain: "none"` — no per-task
   *  assignee source, no resolver (structurally un-fakeable, #506). */
  assignee: AssigneeFacet;
  /** Labour on the task. ALWAYS `grain: "job"` honest-empty — hours are
   *  jobId-only, never a per-task split (P7; keeps payroll out, #506). */
  labour: LabourFacet;
  /** Materials. `area-package`-granular when injected (`materialsFor`), else
   *  honest-empty `grain: "none"` (#506). */
  material: MaterialFacet;
  /** Governing drawings/specs. `area-package`-granular when injected
   *  (`drawingsFor`), else honest-empty `grain: "none"` (#506). */
  drawing: DrawingFacet;
  /** Open RFIs — task-grained, derived from open `rfi`-typed blockers (#504),
   *  else honest-empty `grain: "none"` (#506). */
  rfi: RfiFacet;
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

/** Optional pre-resolved facet inputs for ONE instance. Any grain-tagged facet
 *  not supplied falls back to its honest-empty/grain-tagged default — never to a
 *  faked value. `assignee`/`labour` have NO input here by design (resolver-less,
 *  #506): they are always their honest default. */
export interface TaskInstanceFacetInput {
  readiness?: TaskReadiness;
  hasOpenBlockers?: boolean;
  blockerIds?: string[];
  proof?: TaskInstanceProofFacet | null;
  material?: MaterialFacet;
  drawing?: DrawingFacet;
  rfi?: RfiFacet;
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
      // grain-tagged facets — every one defaults to its honest-empty default, so
      // with no input the observable output is identical to today plus the tags.
      assignee: ASSIGNEE_NONE,
      labour: LABOUR_JOB,
      material: facets.material ?? MATERIAL_NONE,
      drawing: facets.drawing ?? DRAWING_NONE,
      rfi: facets.rfi ?? RFI_NONE,
    },
  };
}

/** Context for composing a whole index's worth of task-instance views. */
export interface ProjectTaskInstancesContext {
  /** #482 dependency edges (canonical ids). Honest-empty by default. */
  dependencies?: ReadonlyArray<TaskDependency>;
  /** #482 blockers (canonical ids). Honest-empty by default. ALSO the in-domain
   *  source of the rfi facet: open `rfi`-typed blockers on a task → that task's
   *  open RFIs (#504/#506 — no new import, no new source). */
  blockers?: ReadonlyArray<TaskBlocker>;
  /** Caller-injected proof facet per instance (job-control lives outside this
   *  domain). Return `null` for a task with no required proof. */
  proofFor?: (task: CanonicalTask) => TaskInstanceProofFacet | null;
  /** Caller-injected materials per instance, area/package-granular today (the
   *  caller maps a `buildPhilTaskContext(...).materials` into this — job-control
   *  lives outside this domain). Return `null` for a task with no package; an
   *  empty array yields an honest `grain: "area-package"` facet with zero items
   *  (#506/#368). */
  materialsFor?: (task: CanonicalTask) => TaskInstanceMaterial[] | null;
  /** Caller-injected governing drawings/specs per instance, area/package-granular
   *  today (maps `buildPhilTaskContext(...).governingDocs`). Return `null` for a
   *  task with no package (#506/#368). */
  drawingsFor?: (task: CanonicalTask) => TaskInstanceGoverningDoc[] | null;
}

/** Derive the rfi facet IN-DOMAIN from the #504 blockers already passed to the
 *  projection: the OPEN, `rfi`-typed blockers keyed on this canonical id. A
 *  resolved or non-rfi blocker never contributes. Honest-empty when none. */
function rfiFacetFromBlockers(
  task: CanonicalTask,
  blockers: ReadonlyArray<TaskBlocker>,
): RfiFacet {
  const openRfis = blockers.filter(
    (b) => b.taskId === task.id && b.status === "open" && b.type === "rfi",
  );
  if (openRfis.length === 0) return RFI_NONE;
  return {
    grain: "task",
    openRfiIds: openRfis.map((b) => b.id),
    titles: openRfis.map((b) => b.title),
  };
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
  const { dependencies, blockers, proofFor, materialsFor, drawingsFor } = ctx;
  const allBlockers = blockers ?? [];
  return tasks.map((task) => {
    const openBlockers = allBlockers.filter(
      (b) => b.taskId === task.id && b.status === "open",
    );
    const materials = materialsFor ? materialsFor(task) : null;
    const docs = drawingsFor ? drawingsFor(task) : null;
    return toTaskInstanceView(task, {
      readiness: deriveTaskReadiness({ task, dependencies, blockers, tasks }),
      hasOpenBlockers: openBlockers.length > 0,
      blockerIds: openBlockers.map((b) => b.id),
      proof: proofFor ? proofFor(task) : null,
      material: materials ? { grain: "area-package", items: materials } : MATERIAL_NONE,
      drawing: docs ? { grain: "area-package", docs } : DRAWING_NONE,
      rfi: rfiFacetFromBlockers(task, allBlockers),
    });
  });
}
