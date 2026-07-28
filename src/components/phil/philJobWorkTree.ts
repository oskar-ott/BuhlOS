import { effectiveTasks } from "@/domains/jobs/format";
import type { Job, JobArea, JobStage } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";

/**
 * Work-tree derivation for the Phil job interface area cards.
 *
 * Per the Phil Job Interface Bible §09 ("Work — areas, then stages,
 * then tasks"), each area should read as a small job inside the job:
 * which stages it has, and what's outstanding on it.
 *
 * We only surface counts that are **real and area-linked** in the data
 * the page already loads:
 *
 *   - Photos       — `evidence.areaId === area.id`. The evidence list is
 *                    already viewer-scoped by the server (a tradie sees
 *                    their own captures; admin/LH see all), so this
 *                    means "captures visible to me in this area."
 *
 * Documents are deliberately **not** counted per area: the document
 * schema carries `level` + `category` but no `areaId`, so a per-area
 * document count would be fabricated. Documents stay job-wide in the
 * Documents panel.
 *
 * Stage availability is derived from the task plan: a Rough-in / Fit-off
 * chip only shows when `effectiveTasks` returns a non-empty list for
 * that stage (own override or job inheritance).
 *
 * Cross-ref:
 *   /tmp/phil-bible/buhlos-phil/project/Phil Job Interface Bible.html §09
 *   src/domains/jobs/format.ts#effectiveTasks
 */

export interface AreaStageAvailability {
  roughIn: boolean;
  fitOff: boolean;
}

/**
 * Which stages have a task plan for this area. Drives the Rough-in /
 * Fit-off chips — a chip only renders when there's an actual task list
 * behind it, so an area with no fit-off plan doesn't claim one.
 */
export function areaStageAvailability(
  job: Pick<Job, "roughInTasks" | "fitOffTasks">,
  area: Pick<JobArea, "roughInTasks" | "fitOffTasks">,
): AreaStageAvailability {
  return {
    roughIn: effectiveTasks(job, area, "roughIn").length > 0,
    fitOff: effectiveTasks(job, area, "fitOff").length > 0,
  };
}

export interface AreaCounts {
  /** Evidence captures linked to this area (viewer-scoped). */
  photos: number;
}

const EMPTY_COUNTS: AreaCounts = { photos: 0 };

/**
 * Evidence captures grouped by `areaId`. Captures with no area are
 * excluded. The input is already viewer-scoped by the server.
 */
export function evidenceCountByArea(
  evidence: ReadonlyArray<EvidenceItem>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of evidence) {
    if (!e.areaId) continue;
    m.set(e.areaId, (m.get(e.areaId) ?? 0) + 1);
  }
  return m;
}

/**
 * Compose the per-area count maps once, then read each area's counts by
 * id. Keeping the maps together means PhilJobDetail builds them in a
 * single `useMemo` and the card just does a `Map.get` lookup.
 */
export interface AreaCountMaps {
  photos: Map<string, number>;
}

export function buildAreaCountMaps(input: {
  evidence: ReadonlyArray<EvidenceItem>;
}): AreaCountMaps {
  return {
    photos: evidenceCountByArea(input.evidence),
  };
}

/** Read a single area's counts out of the prebuilt maps. */
export function countsForArea(
  maps: AreaCountMaps,
  areaId: string,
): AreaCounts {
  const photos = maps.photos.get(areaId) ?? 0;
  if (photos === 0) return EMPTY_COUNTS;
  return { photos };
}

/**
 * The single stage that has a task plan, or null when zero stages or
 * both stages have one.
 *
 * Drives two decisions in the area drill-in:
 *   - When a worker selects an area with exactly one stage, the parent
 *     syncs `stage` to it (so the capture / snag context matches what's
 *     shown) — at selection time, not via an effect.
 *   - The drill-in only renders the Rough-in / Fit-off selector when
 *     `soleStage` is null AND at least one stage exists (i.e. both do).
 */
export function soleStage(stages: AreaStageAvailability): JobStage | null {
  if (stages.roughIn && !stages.fitOff) return "roughIn";
  if (stages.fitOff && !stages.roughIn) return "fitOff";
  return null;
}

/** True when the area has a task plan for at least one stage. */
export function hasAnyStage(stages: AreaStageAvailability): boolean {
  return stages.roughIn || stages.fitOff;
}

export interface AreaQuickLink {
  key: "photos";
  count: number;
  /** Already-pluralised visible label, e.g. "2 snags", "1 ITP". */
  label: string;
  /** In-page scroll anchor for the matching job section. The count is
   *  area-specific; the section it scrolls to is the job-wide list,
   *  where each row carries its own area label. */
  anchor: string;
}

/**
 * Quick links to show in the area drill-in — one per count that is
 * actually > 0. A zero count produces no link, so an area with nothing
 * outstanding shows no quick-link row at all (zero-count noise stays
 * hidden, per the work-tree rules).
 */
export function areaQuickLinks(counts: AreaCounts): AreaQuickLink[] {
  const links: AreaQuickLink[] = [];
  if (counts.photos > 0) {
    links.push({
      key: "photos",
      count: counts.photos,
      label: counts.photos === 1 ? "1 photo" : `${counts.photos} photos`,
      anchor: "#phil-job-capture",
    });
  }
  return links;
}
