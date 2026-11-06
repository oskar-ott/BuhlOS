import type { HoursJob } from "./hours-view";

/**
 * Office and Workshop — the two places hours can be logged to that are NOT
 * jobs (owner pull 2026-11-06). They ride an allocation's `jobId` as reserved
 * ids, so the worker picks them like a job and can split a day across them
 * and real jobs. Server twin: api/_lib/work-places.js — the ids and names
 * must match (pinned by work-places.test.ts).
 */
export const WORK_PLACES: ReadonlyArray<HoursJob> = [
  { id: "place:office", name: "Office" },
  { id: "place:workshop", name: "Workshop" },
];

const NAME_BY_ID: Record<string, string> = Object.fromEntries(
  WORK_PLACES.map((p) => [p.id, p.name])
);

/** True for the Office / Workshop ids. */
export function isWorkPlaceId(id: string | null | undefined): boolean {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(NAME_BY_ID, id);
}

/** "Office" / "Workshop" for a place id, else null. */
export function workPlaceName(id: string | null | undefined): string | null {
  return isWorkPlaceId(id) ? NAME_BY_ID[id as string]! : null;
}

/** The worker's jobs with Office and Workshop after them (never doubled). */
export function withWorkPlaces<J extends HoursJob>(jobs: ReadonlyArray<J>): Array<J | HoursJob> {
  const real = jobs.filter((j) => !isWorkPlaceId(j.id));
  return [...real, ...WORK_PLACES];
}
