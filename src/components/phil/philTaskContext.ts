import type { JobStage } from "@/domains/jobs/types";
import { buildPhilTaskContext, type PhilTaskContext } from "@/domains/job-control/task-context";
import type { EvidenceLink, WorkPackage } from "@/domains/job-control/types";

/**
 * Phil — task scope-context boundary adapter (#368).
 *
 * Turns a job's compiled work packages into a `taskId → PhilTaskContext`
 * lookup for ONE area+stage, so the task list can render context per task
 * WITHOUT recomputing the model's logic in the UI. Each visible task maps to a
 * `TaskRef { areaId, stage, taskId }`, which `buildPhilTaskContext` resolves
 * against the job's work packages + evidence links (the pure #368 selector).
 *
 * TODAY the Phil job fetch does NOT carry compiled work packages or evidence
 * links — the #367 compile→Phil plumbing is a separate later slice — so callers
 * pass none, every context is the model's HONEST EMPTY, and this returns an
 * empty map. Every task then renders exactly as it does today (zero regression,
 * P10). When that data flows, pass it through `workPackages` / `evidenceLinks`
 * here and the existing render lights up with no further UI change.
 *
 * Only NON-EMPTY contexts are included; an absent `taskId` ⇒ render the task
 * plainly. Stage typing: `JobStage` is the same literal union as the spine's
 * `JobControlStage` (enforced by the compile-time guard in
 * job-control/types.ts), so a `JobStage` flows straight into a `TaskRef`.
 */
export function buildAreaTaskContext(input: {
  areaId: string;
  stage: JobStage;
  taskIds: ReadonlyArray<string>;
  workPackages?: ReadonlyArray<WorkPackage>;
  evidenceLinks?: ReadonlyArray<EvidenceLink>;
}): ReadonlyMap<string, PhilTaskContext> {
  const workPackages = input.workPackages ?? [];
  const map = new Map<string, PhilTaskContext>();
  // Fast path + honesty: nothing compiled means nothing to show — return the
  // empty map rather than building an empty context per task.
  if (workPackages.length === 0) return map;

  const evidenceLinks = input.evidenceLinks ?? [];
  for (const taskId of input.taskIds) {
    const context = buildPhilTaskContext({
      workPackages,
      task: { areaId: input.areaId, stage: input.stage, taskId },
      evidenceLinks,
    });
    if (!context.isEmpty) map.set(taskId, context);
  }
  return map;
}
