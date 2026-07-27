import type { CanonicalTask } from "@/domains/jobs/task-index";

/**
 * Pure derivations for the in-job four-rooms navigation (phil_job_rooms — the
 * filed #133 experiment). The rooms are PROJECTIONS over data the job screen
 * already loads: nothing here reads storage, invents a count, or deepens
 * area-owned task arrays — tasks come in as the canonical index (#480).
 *
 * The room-tab badges these feed are the #133 criterion instrumentation
 * ("critical state is never hidden behind navigation"): every number is a real
 * derived count, or absent.
 */

export type PhilJobRoom = "now" | "work" | "proof" | "site";

export const PHIL_JOB_ROOMS: ReadonlyArray<PhilJobRoom> = [
  "now",
  "work",
  "proof",
  "site",
];

export function isPhilJobRoom(value: unknown): value is PhilJobRoom {
  return (
    typeof value === "string" && (PHIL_JOB_ROOMS as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Whole-job work counts for the Work room's segmented bar + chips. Every
 * number is derived from the same canonical instances (#507 parity path):
 *   done    — state === "complete" (the #198 rule, in_progress is NOT done)
 *   going   — in_progress
 *   todo    — the remainder
 */
export interface JobWorkCounts {
  total: number;
  done: number;
  going: number;
  todo: number;
}

export function jobWorkCounts(tasks: ReadonlyArray<CanonicalTask>): JobWorkCounts {
  let done = 0;
  let going = 0;
  for (const t of tasks) {
    if (t.state === "complete") done += 1;
    else if (t.state === "in_progress") going += 1;
  }
  const total = tasks.length;
  return { total, done, going, todo: total - done - going };
}

/**
 * Where an attention item's in-page anchor lives in the rooms layout. The
 * flag-off page scrolls to these anchors on one long page; inside the rooms,
 * the same signal navigates to the room that now owns the section — the Now
 * room never dead-ends a critical signal behind a broken anchor (the #133
 * criterion).
 */
export function roomForAttentionAnchor(anchor: string): PhilJobRoom {
  switch (anchor) {
    case "#phil-job-site":
      return "site";
    default:
      return "now";
  }
}
