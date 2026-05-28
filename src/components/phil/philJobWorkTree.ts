import { effectiveTasks } from "@/domains/jobs/format";
import { needsWorkerAttention as snagNeedsAttention } from "@/domains/snags/format";
import { needsWorkerAttention as itpNeedsAttention } from "@/domains/itp/format";
import type { Job, JobArea } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ITPInstance } from "@/domains/itp/types";
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
 *   - Snags        — `snag.areaId === area.id`, active states only.
 *   - Area ITPs    — `itp.scope === "area" && itp.scopeId === area.id`,
 *                    non-archived, active states only. Job- / level- /
 *                    switchboard-scoped ITPs are NOT attributed to a
 *                    single area (that would be guessing).
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
 *   src/components/phil/itp-scope.ts — scope='area' → scopeId = area.id
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
  /** Active snags raised against this area. */
  snags: number;
  /** Active, non-archived ITP instances scoped to this area. */
  itps: number;
  /** Evidence captures linked to this area (viewer-scoped). */
  photos: number;
}

const EMPTY_COUNTS: AreaCounts = { snags: 0, itps: 0, photos: 0 };

/**
 * Active snags grouped by `areaId`. Snags with no area (job-level) are
 * excluded — they can't be attributed to a single card.
 */
export function activeSnagCountByArea(
  snags: ReadonlyArray<SnagItem>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of snags) {
    if (!s.areaId) continue;
    if (!snagNeedsAttention(s.status)) continue;
    m.set(s.areaId, (m.get(s.areaId) ?? 0) + 1);
  }
  return m;
}

/**
 * Active, non-archived, **area-scoped** ITPs grouped by `scopeId`
 * (which, for `scope === "area"`, is the area id). Other scopes are
 * skipped so we never spread a job- or level-scoped ITP across areas.
 */
export function activeAreaItpCountByArea(
  itps: ReadonlyArray<ITPInstance>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of itps) {
    if (i.archived) continue;
    if (i.scope !== "area" || !i.scopeId) continue;
    if (!itpNeedsAttention(i.status)) continue;
    m.set(i.scopeId, (m.get(i.scopeId) ?? 0) + 1);
  }
  return m;
}

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
 * id. Keeping the three maps together means PhilJobDetail builds them in
 * a single `useMemo` and the card just does three `Map.get` lookups.
 */
export interface AreaCountMaps {
  snags: Map<string, number>;
  itps: Map<string, number>;
  photos: Map<string, number>;
}

export function buildAreaCountMaps(input: {
  snags: ReadonlyArray<SnagItem>;
  itps: ReadonlyArray<ITPInstance>;
  evidence: ReadonlyArray<EvidenceItem>;
}): AreaCountMaps {
  return {
    snags: activeSnagCountByArea(input.snags),
    itps: activeAreaItpCountByArea(input.itps),
    photos: evidenceCountByArea(input.evidence),
  };
}

/** Read a single area's counts out of the prebuilt maps. */
export function countsForArea(
  maps: AreaCountMaps,
  areaId: string,
): AreaCounts {
  const snags = maps.snags.get(areaId) ?? 0;
  const itps = maps.itps.get(areaId) ?? 0;
  const photos = maps.photos.get(areaId) ?? 0;
  if (snags === 0 && itps === 0 && photos === 0) return EMPTY_COUNTS;
  return { snags, itps, photos };
}
