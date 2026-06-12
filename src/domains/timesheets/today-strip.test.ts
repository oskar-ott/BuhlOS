import { describe, expect, it } from "vitest";
import type { TodayPulseResponse } from "./types";
import { summariseTodayStrip } from "./today-strip";

/**
 * #185 — pure summariser for the command-centre Today strip.
 * Covers the three payload classes the strip renders: populated, zero-day
 * (calm state) and error (null payload after a failed/unparseable fetch).
 */

function pulse(
  hours: Partial<TodayPulseResponse["hours"]> = {},
  date = "2026-06-12"
): TodayPulseResponse {
  return {
    date,
    hours: {
      submittedCount: 0,
      submittedTotal: 0,
      approvedCount: 0,
      approvedTotal: 0,
      pendingCount: 0,
      draftCount: 0,
      crewOnSite: 0,
      ...hours,
    },
    snags: { openedToday: 0, resolvedToday: 0 },
    jobs: { activeJobs: 0, jobsWithActivityToday: 0 },
  };
}

describe("summariseTodayStrip", () => {
  it("returns null for a null payload (failed fetch → component error chip)", () => {
    expect(summariseTodayStrip(null)).toBeNull();
  });

  it("summarises a populated day", () => {
    const m = summariseTodayStrip(
      pulse({
        submittedCount: 2,
        submittedTotal: 15.2,
        approvedCount: 1,
        approvedTotal: 7.6,
        pendingCount: 2,
        crewOnSite: 3,
      })
    );
    expect(m).not.toBeNull();
    expect(m!.date).toBe("2026-06-12");
    expect(m!.crewCount).toBe(3);
    expect(m!.hasActivity).toBe(true);
    // 15.2 + 7.6 = 22.8h → "22h 48m"
    expect(m!.loggedHoursLabel).toBe("22h 48m");
    expect(m!.loggedHoursHint).toBe("submitted + approved");
    expect(m!.draftCount).toBe(0);
  });

  it("carries the API's day verbatim — never recomputes the boundary", () => {
    const m = summariseTodayStrip(pulse({}, "2026-01-03"));
    expect(m!.date).toBe("2026-01-03");
  });

  it("flags a zero day so the strip can render the calm state", () => {
    const m = summariseTodayStrip(pulse());
    expect(m!.hasActivity).toBe(false);
    expect(m!.crewCount).toBe(0);
    expect(m!.loggedHoursLabel).toBe("0h");
  });

  it("counts a drafts-only morning as activity and names the gap", () => {
    const m = summariseTodayStrip(pulse({ draftCount: 2, crewOnSite: 2 }));
    expect(m!.hasActivity).toBe(true);
    expect(m!.loggedHoursLabel).toBe("0h");
    expect(m!.loggedHoursHint).toBe(
      "submitted + approved — 2 drafts not submitted yet"
    );
  });

  it("singularises a single draft", () => {
    const m = summariseTodayStrip(pulse({ draftCount: 1, crewOnSite: 1 }));
    expect(m!.loggedHoursHint).toBe(
      "submitted + approved — 1 draft not submitted yet"
    );
  });

  it("treats crew-only activity (e.g. rejected-entries day) as activity", () => {
    // api/today-pulse.js adds any user with >0 allocated hours to the crew
    // set even when no submitted/approved/draft counter moves (rejected
    // entries do exactly this).
    const m = summariseTodayStrip(pulse({ crewOnSite: 1 }));
    expect(m!.hasActivity).toBe(true);
  });

  it("absorbs float noise when summing the two server-rounded totals", () => {
    // 7.3 + 8.4 = 15.700000000000001 in IEEE754 — label must still be clean.
    const m = summariseTodayStrip(
      pulse({ submittedTotal: 7.3, approvedTotal: 8.4, crewOnSite: 2 })
    );
    expect(m!.loggedHoursLabel).toBe("15h 42m");
  });

  it("never labels crew as on site (honesty: hours logged, not GPS)", () => {
    const m = summariseTodayStrip(pulse({ crewOnSite: 4 }));
    expect(m!.crewLabel).toBe("on the clock");
    expect(m!.crewLabel).not.toContain("on site");
  });
});
