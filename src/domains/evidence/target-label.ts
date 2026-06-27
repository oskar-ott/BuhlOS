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

/**
 * One resolved facet of a capture's context (#260). `resolved` is true when
 * we found the boss-authored name; false when we fell back to the raw id
 * (renamed / archived / unknown). Callers render `false` honestly — an
 * "(unknown)" hint on a raw-id chip, never a guessed name and never a blank.
 */
export interface ResolvedTargetPart {
  /** Human label WITHOUT the "Area "/"Task " prefix — the chip adds its own. */
  label: string;
  resolved: boolean;
}

/**
 * Structured variant of {@link resolveEvidenceTargetLabel} (#260). Returns the
 * stage / area / task facets separately so the admin review surfaces can render
 * each as its own context chip instead of one joined body string. Each present
 * facet carries a `resolved` flag so an unresolvable id renders honestly.
 *
 * Pure + null-safe — a facet is omitted entirely when its id is absent.
 */
export interface ResolvedTargetParts {
  stage?: ResolvedTargetPart;
  area?: ResolvedTargetPart;
  task?: ResolvedTargetPart;
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

export function resolveEvidenceTargetParts(job: Job, item: EvidenceTargetRef): ResolvedTargetParts {
  const out: ResolvedTargetParts = {};

  if (item.stage) {
    out.stage = {
      label: item.stage === "roughIn" ? "Rough-in" : "Fit-off",
      resolved: true,
    };
  }

  const area = findArea(job, item.areaId);
  if (item.areaId) {
    const name = area?.name?.trim();
    out.area = { label: name || item.areaId, resolved: Boolean(name) };
  }

  if (item.taskId) {
    const stage: JobStage = item.stage === "fitOff" ? "fitOff" : "roughIn";
    const taskName = item.stage
      ? effectiveTasks(job, area, stage).find((t) => t.id === item.taskId)?.name?.trim()
      : undefined;
    out.task = { label: taskName || item.taskId, resolved: Boolean(taskName) };
  }

  return out;
}

export function resolveEvidenceTargetLabel(job: Job, item: EvidenceTargetRef): string {
  // Thin join over resolveEvidenceTargetParts so existing callers/tests stay
  // byte-identical (#260).
  const parts = resolveEvidenceTargetParts(job, item);
  const out: string[] = [];
  if (parts.stage) out.push(parts.stage.label);
  if (parts.area) out.push(`Area ${parts.area.label}`);
  if (parts.task) out.push(`Task ${parts.task.label}`);
  return out.join(" · ");
}
