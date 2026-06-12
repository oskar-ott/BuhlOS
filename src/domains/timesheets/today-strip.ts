import type { TodayPulseResponse } from "./types";
import { formatHoursLabel } from "./format";

/**
 * Pure summariser for the /command-centre "Today" strip (#185): today-pulse
 * payload in, display model out. The strip is the operational morning view —
 * "is the crew where I think it is?" — NOT an analytics surface (the six-
 * numbers board is #316's separate surface).
 *
 * Data honesty (#185 requirement 1): `crewOnSite` from api/today-pulse.js is
 * "distinct users with >0 hours logged on the day" — it is NOT GPS presence.
 * The model's labels therefore say "on the clock" / "logged hours today",
 * never "on site". Keep it that way.
 *
 * Day boundary: `pulse.date` is the API's own Sydney day (sydneyToday() in
 * api/today-pulse.js, same boundary the /hours closeout uses). It is carried
 * verbatim — never recomputed client-side.
 *
 * The pending-approvals number deliberately does NOT come from this payload:
 * the strip shows the same loadSnapshot value the Hours queue card uses (one
 * number, one source), so it is passed to the component separately.
 *
 * Cross-ref:
 *   src/components/admin/TodayStrip.tsx — sole consumer
 *   src/domains/timesheets/schema.ts TodayPulseResponseSchema — wire shape
 *   api/today-pulse.js — source of truth for the semantics above
 */

export interface TodayStripModel {
  /** The API's Sydney day (YYYY-MM-DD), verbatim — never recomputed. */
  date: string;
  /** Distinct users with >0 hours logged today (any status). NOT GPS. */
  crewCount: number;
  /** Honest crew label — "on the clock", pluralised. */
  crewLabel: string;
  /** Submitted + approved hours, formatted ("15h 12m"). Drafts excluded. */
  loggedHoursLabel: string;
  /** What the logged figure covers — names drafts when they exist. */
  loggedHoursHint: string;
  /** Entries logged but not submitted today (the silent gap). */
  draftCount: number;
  /**
   * False when nothing has been logged today at all — the calm zero state
   * ("No hours logged yet today" is normal before the crew clocks on, not
   * a warning).
   */
  hasActivity: boolean;
}

export function summariseTodayStrip(
  pulse: TodayPulseResponse | null
): TodayStripModel | null {
  if (!pulse) return null;
  const h = pulse.hours;

  // crewOnSite already dedupes users across multi-job days server-side —
  // never re-sum entries client-side.
  const crewCount = h.crewOnSite;

  // The endpoint only totals submitted + approved hours (drafts carry a
  // count but no total), so the figure is labelled exactly that.
  const loggedHours = h.submittedTotal + h.approvedTotal;

  // crewCount alone can be >0 with every counter at zero (e.g. a day with
  // only rejected entries still puts those users in the crew set), so it
  // participates in the activity check in its own right.
  const hasActivity =
    crewCount > 0 ||
    h.submittedCount > 0 ||
    h.approvedCount > 0 ||
    h.draftCount > 0;

  return {
    date: pulse.date,
    crewCount,
    crewLabel: "on the clock",
    loggedHoursLabel: formatHoursLabel(loggedHours),
    loggedHoursHint:
      h.draftCount > 0
        ? `submitted + approved — ${h.draftCount} ${
            h.draftCount === 1 ? "draft" : "drafts"
          } not submitted yet`
        : "submitted + approved",
    draftCount: h.draftCount,
    hasActivity,
  };
}
