import { ISO_DATE_RE } from "./validate";

/**
 * Lightweight job milestones (#225) — pure state + ordering, no I/O, no React.
 *
 * A milestone is a named date a job is working toward ("Rough-in complete",
 * "Switchboard energised") with an optional done date. This foundation derives
 * the display state and the register ordering from date-only strings; date
 * comparison is plain lexicographic on `YYYY-MM-DD` (no timezone math, so it is
 * deterministic and matches how the rest of the jobs domain treats calendar
 * dates). Persistence (a `milestones[]` field on the Job + the builder/overview
 * UI) is a deferred layer that consumes this — kept out of this slice so it
 * touches only NEW files (zero conflict).
 *
 * Rules:
 *   - done       — has a doneDate (regardless of target; a late-but-done
 *                  milestone is done, never overdue).
 *   - overdue    — not done, valid target, and target is STRICTLY before today
 *                  (target === today is NOT overdue — you still have the day).
 *   - upcoming   — everything else (incl. today, and an unparseable target,
 *                  which can never be "overdue" without a real date).
 */

export interface Milestone {
  id: string;
  name: string;
  /** Target date, `YYYY-MM-DD`. */
  targetDate: string;
  /** Completion date, `YYYY-MM-DD`, or null/absent when not done. */
  doneDate?: string | null;
}

export type MilestoneState = "done" | "overdue" | "upcoming";

function isValidDate(d: string | null | undefined): d is string {
  return typeof d === "string" && ISO_DATE_RE.test(d);
}

/** Derive a milestone's state relative to `today` (a `YYYY-MM-DD` string). */
export function deriveMilestoneState(
  m: Pick<Milestone, "targetDate" | "doneDate">,
  today: string,
): MilestoneState {
  if (isValidDate(m.doneDate)) return "done";
  if (isValidDate(m.targetDate) && m.targetDate < today) return "overdue";
  return "upcoming";
}

export interface MilestoneSummary {
  total: number;
  done: number;
  overdue: number;
  upcoming: number;
  /** The soonest not-done, not-overdue milestone (earliest valid target), or null. */
  nextUpcoming: Milestone | null;
}

export function summariseMilestones(
  milestones: ReadonlyArray<Milestone>,
  today: string,
): MilestoneSummary {
  let done = 0;
  let overdue = 0;
  let upcoming = 0;
  let nextUpcoming: Milestone | null = null;

  for (const m of milestones) {
    const state = deriveMilestoneState(m, today);
    if (state === "done") done += 1;
    else if (state === "overdue") overdue += 1;
    else {
      upcoming += 1;
      if (
        isValidDate(m.targetDate) &&
        (nextUpcoming === null || m.targetDate < nextUpcoming.targetDate)
      ) {
        nextUpcoming = m;
      }
    }
  }

  return { total: milestones.length, done, overdue, upcoming, nextUpcoming };
}

const STATE_RANK: Record<MilestoneState, number> = { overdue: 0, upcoming: 1, done: 2 };

/**
 * Register ordering: overdue first (earliest target on top), then upcoming
 * (earliest target), then done (most-recently-done first). Stable + pure.
 */
export function sortMilestonesForDisplay(
  milestones: ReadonlyArray<Milestone>,
  today: string,
): Milestone[] {
  return [...milestones].sort((a, b) => {
    const sa = STATE_RANK[deriveMilestoneState(a, today)];
    const sb = STATE_RANK[deriveMilestoneState(b, today)];
    if (sa !== sb) return sa - sb;
    if (sa === STATE_RANK.done) {
      // done: newest doneDate first
      return String(b.doneDate ?? "").localeCompare(String(a.doneDate ?? ""));
    }
    // overdue / upcoming: earliest target first
    return String(a.targetDate).localeCompare(String(b.targetDate));
  });
}
