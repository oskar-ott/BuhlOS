import { isOpenObservation } from "./service";
import type { ObservationItem } from "./types";
import { canonicalIdForCoordinate } from "@/domains/jobs/task-ref";
import type { TaskBlocker, TaskBlockerType } from "@/domains/jobs/task-blockers";

/**
 * Real blocker source: observations → canonical task blockers (#504).
 *
 * The #482 readiness model and its Phil "Blocked — <reason>" display (#493) were
 * built honest-empty — canonical-keyed but with no source feeding them. This is
 * the first REAL source adapter: it turns the site truth workers already capture
 * (observations) into `TaskBlocker`s keyed by canonical task identity, so a task
 * with an open, task-targeted blocker actually shows as blocked.
 *
 * Honest + conservative (P7):
 *   - Only TASK-SCOPED observations count — the full `(areaId, stage, taskId)`
 *     coordinate must be present (schema already requires `stage` when `taskId`
 *     is set). Area/job-scoped observations are NOT turned into task blockers.
 *   - Only OPEN observations count, via the domain's own `isOpenObservation`
 *     (excludes converted/resolved/record_only) — one source of truth, no drift.
 *   - Only genuinely BLOCKING types count (a task can't proceed until they're
 *     cleared): an explicit `blocker`, an `rfi` (awaiting an answer), a
 *     `variation` (awaiting approval), a `material_request` (awaiting material),
 *     a `plan_mismatch` (awaiting a drawing) and a `client_instruction`
 *     (awaiting the client). `note`/`evidence` are informational; `defect` is
 *     rework not a start-block; `safety` is handled separately — all excluded
 *     until field evidence says otherwise.
 *
 * Identity: each blocker is keyed by `canonicalIdForCoordinate(jobId, ref)` (the
 * #501/#483 bridge), so it lands on the exact canonical task instance — never a
 * bare `taskId` collapsed across areas/stages.
 *
 * PURE + read-only. Persists nothing; invents nothing; feeds `deriveTaskReadiness`
 * (#482) unchanged. The blocker title is the worker-readable observation title
 * (never a raw id) — the #493 reason line already renders it.
 */

/** Observation types that genuinely hold up a task, mapped to the #482
 *  `TaskBlockerType`. A type not in this map is not treated as a blocker. */
const BLOCKING_TYPE_TO_BLOCKER: Readonly<Record<string, TaskBlockerType>> = {
  blocker: "other",
  rfi: "rfi",
  variation: "approval",
  material_request: "material",
  plan_mismatch: "drawing",
  client_instruction: "client",
};

/**
 * Derive canonical task blockers from a job's observations. One blocker per
 * qualifying observation (id = the observation id, so it's stable and de-dupes
 * naturally); a task with several qualifying observations yields several blockers
 * (readiness only needs one open blocker to mark it blocked).
 */
export function taskBlockersFromObservations(args: {
  observations: ReadonlyArray<ObservationItem>;
  jobId: string;
}): TaskBlocker[] {
  const out: TaskBlocker[] = [];
  for (const obs of args.observations) {
    // task-scoped only — need the full coordinate
    if (!obs.areaId || !obs.stage || !obs.taskId) continue;
    // open only
    if (!isOpenObservation(obs.status)) continue;
    // blocking type only
    const blockerType = BLOCKING_TYPE_TO_BLOCKER[obs.type];
    if (!blockerType) continue;

    const taskId = canonicalIdForCoordinate(args.jobId, {
      areaId: obs.areaId,
      stage: obs.stage,
      taskId: obs.taskId,
    });
    out.push({
      id: obs.id,
      taskId,
      type: blockerType,
      title: obs.title,
      status: "open",
      areaRefs: [obs.areaId],
    });
  }
  return out;
}
