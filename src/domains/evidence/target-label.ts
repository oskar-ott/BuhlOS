import { effectiveTasks } from "@/domains/jobs/format";
import type { Job, JobArea, JobStage } from "@/domains/jobs/types";

/**
 * Office-facing label for an evidence capture's target (#515): the room + task
 * NAMES the boss authored — "Rough-in · Area Kitchen · Task Pull power" — not the
 * raw internal ids ("Area area_a1b2 · Task task_xyz") the review surface used to
 * show. Mirrors the resolution the ITP / job-control panels already do.
 *
 * Pure + null-safe. Falls back to the raw id whenever a name can't be resolved
 * (renamed/archived/unknown area or task), so a row never blanks or crashes.
 */

export interface EvidenceTargetRef {
  stage?: JobStage | null;
  areaId?: string | null;
  taskId?: string | null;
}

function findArea(job: Pick<Job, "areaGroups">, areaId: string | null | undefined): JobArea | null {
  if (!areaId) return null;
  for (const group of job.areaGroups ?? []) {
    for (const area of group.areas ?? []) {
      if (area && area.id === areaId) return area;
    }
  }
  return null;
}

export function resolveEvidenceTargetLabel(job: Job, item: EvidenceTargetRef): string {
  const parts: string[] = [];
  if (item.stage) parts.push(item.stage === "roughIn" ? "Rough-in" : "Fit-off");

  const area = findArea(job, item.areaId);
  if (item.areaId) parts.push(`Area ${area?.name?.trim() || item.areaId}`);

  if (item.taskId) {
    const stage: JobStage = item.stage === "fitOff" ? "fitOff" : "roughIn";
    const taskName = item.stage
      ? effectiveTasks(job, area, stage).find((t) => t.id === item.taskId)?.name?.trim()
      : undefined;
    parts.push(`Task ${taskName || item.taskId}`);
  }

  return parts.join(" · ");
}
