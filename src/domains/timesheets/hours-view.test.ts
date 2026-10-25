import { describe, expect, it } from "vitest";
import {
  LEAVE_LABELS,
  MAX_OT_HOURS,
  OT_PRESET_MINUTES,
  buildEarlierWeeks,
  dayDate,
  defaultJobId,
  draftSendBlockReason,
  entryTarget,
  fixNeededLine,
  initialPick,
  isLoggableDate,
  leaveOptions,
  nextPickAfterSave,
  oldestLoggableDate,
  otPresetLabel,
  receiptLine,
  searchJobs,
  splitLabel,
  weekRangeLabel,
  weekRows,
  weekSummaryLine,
  weekdayTotalFromOt,
} from "./hours-view";
import { autoSplitOT, buildCustomHoursPayload, buildStandardDayPayload } from "./service";
import type { TimeEntry } from "./types";

/** 2026-10-15 is a Thursday; the week is Mon 12 – Sun 18 Oct. */
const TODAY = "2026-10-15";

let seq = 0;
function entry(over: Partial<TimeEntry> & Pick<TimeEntry, "date">): TimeEntry {
  seq += 1;
  const totalHours = over.totalHours ?? 7.6;
  const split = autoSplitOT(totalHours, over.date);
  return {
    id: `e${seq}`,
    userId: "u1",
    date: over.date,
    totalHours,
    ordinaryHours: over.ordinaryHours ?? split.ordinary,
    overtimeHours: over.overtimeHours ?? split.overtime,
    status: over.status ?? "submitted",
    allocations: over.allocations ?? [{ jobId: "bondi", hours: totalHours }],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    notes: null,
    ...(over.dayType ? { dayType: over.dayType } : {}),
  } as TimeEntry;
}

const JOBS = [
  { id: "bondi", name: "Bondi switchboard", address: "12 Campbell Pde, Bondi" },
  { id: "mascot", name: "Mascot warehouse", address: "4 Bourke Rd, Mascot" },
  {
    id: "castle",
    name: "Castle Hill fit-out",
    address: "9 Old Northern Rd",
    completedAt: "2026-09-20",
  },
];

describe("dates read one way", () => {
  it("days read 'Thu 15 Oct', weeks '12–18 Oct' or '29 Sep – 5 Oct'", () => {
    expect(dayDate("2026-10-15")).toBe("Thu 15 Oct");
    expect(weekRangeLabel("2026-10-12")).toBe("12–18 Oct");
    expect(weekRangeLabel("2026-09-28")).toBe("28 Sep – 4 Oct");
  });
});

describe("the loggable window: 14 days back, today, tomorrow", () => {
  it("offers exactly today-14 … tomorrow", () => {
    expect(oldestLoggableDate(TODAY)).toBe("2026-10-01");
    expect(isLoggableDate("2026-10-01", TODAY)).toBe(true);
    expect(isLoggableDate("2026-09-30", TODAY)).toBe(false);
    expect(isLoggableDate(TODAY, TODAY)).toBe(true);
    expect(isLoggableDate("2026-10-16", TODAY)).toBe(true); // tomorrow
    expect(isLoggableDate("2026-10-17", TODAY)).toBe(false); // beyond tomorrow
    expect(isLoggableDate("not-a-date", TODAY)).toBe(false);
  });

  it("week rows: logged / pickable (incl. today + tomorrow) / future beyond tomorrow", () => {
    const rows = weekRows("2026-10-12", [entry({ date: "2026-10-13" })], TODAY);
    expect(rows.map((r) => r.kind)).toEqual([
      "pickable", // Mon
      "logged", // Tue
      "pickable", // Wed
      "pickable", // Thu today
      "pickable", // Fri tomorrow
      "future", // Sat
      "future", // Sun
    ]);
    expect(rows[3]!.isToday).toBe(true);
    expect(rows[4]!.isTomorrow).toBe(true);
  });

  it("an earlier week's day outside the window is closed, not pickable", () => {
    const rows = weekRows("2026-09-28", [], TODAY);
    // Mon 28 Sep – Wed 30 Sep are more than 14 days back; Thu 1 Oct onward are in.
    expect(rows.slice(0, 3).map((r) => r.kind)).toEqual(["closed", "closed", "closed"]);
    expect(rows.slice(3).map((r) => r.kind)).toEqual([
      "pickable",
      "pickable",
      "pickable",
      "pickable",
    ]);
  });
});

describe("OT maths and the 16h cap", () => {
  it("a weekday is standard day + OT; presets derive their totals", () => {
    expect(weekdayTotalFromOt(60)).toEqual({ totalHours: 8.6, overCap: false });
    expect(weekdayTotalFromOt(75).totalHours).toBe(8.85); // 8h 51m
    expect(OT_PRESET_MINUTES.map((m) => otPresetLabel(m))).toEqual([
      { lead: "+30m OT", total: "8h 6m total" },
      { lead: "+1h OT", total: "8h 36m total" },
      { lead: "+1½h OT", total: "9h 6m total" },
      { lead: "+2h OT", total: "9h 36m total" },
    ]);
  });

  it("the most OT a day can carry is 8h 24m — one minute more breaks the 16h cap", () => {
    expect(MAX_OT_HOURS).toBe(8.4);
    expect(weekdayTotalFromOt(8 * 60 + 24)).toEqual({ totalHours: 16, overCap: false });
    expect(weekdayTotalFromOt(8 * 60 + 25).overCap).toBe(true);
  });

  it("the split reads '7h 36m + 1h OT' from stored parts, and refuses a split that doesn't add up", () => {
    expect(
      splitLabel({ date: "2026-10-15", totalHours: 8.6, ordinaryHours: 7.6, overtimeHours: 1 })
    ).toBe("7h 36m + 1h OT");
    expect(
      splitLabel({ date: "2026-10-15", totalHours: 7.6, ordinaryHours: 7.6, overtimeHours: 0 })
    ).toBe("7h 36m");
    expect(
      splitLabel({ date: "2026-10-15", totalHours: 8.6, ordinaryHours: 8, overtimeHours: 1 })
    ).toBe("8h 36m");
    // Derived when parts are absent (a review line before anything is stored).
    expect(splitLabel({ date: "2026-10-15", totalHours: 8.6 })).toBe("7h 36m + 1h OT");
  });

  it("the payload the screen sends splits exactly like the server", () => {
    const p = buildCustomHoursPayload({ date: "2026-10-15", totalHours: 8.6, jobId: "bondi" });
    expect(p.ordinaryHours).toBe(7.6);
    expect(p.overtimeHours).toBe(1);
    expect(p.totalHours).toBe(8.6);
  });
});

describe("the weekend rule: every hour is OT", () => {
  it("a Saturday or Sunday has no standard day — the whole total is overtime", () => {
    expect(autoSplitOT(4, "2026-10-17")).toEqual({ ordinary: 0, overtime: 4 });
    expect(autoSplitOT(7.6, "2026-10-18")).toEqual({ ordinary: 0, overtime: 7.6 });
    expect(splitLabel({ date: "2026-10-17", totalHours: 4 })).toBe("4h OT");
    const p = buildCustomHoursPayload({ date: "2026-10-17", totalHours: 4, jobId: "bondi" });
    expect(p.ordinaryHours).toBe(0);
    expect(p.overtimeHours).toBe(4);
  });

  it("a leave day on a weekend still pays ordinary (not a job day)", () => {
    const p = buildStandardDayPayload({ date: "2026-10-17", jobId: null, dayType: "sick" });
    expect(p.overtimeHours).toBe(0);
    expect(p.ordinaryHours).toBe(7.6);
  });
});

describe("the week summary counts only what's logged", () => {
  it("names days logged and hours, never 'of N' or 'to go'", () => {
    const line = weekSummaryLine([
      entry({ date: "2026-10-12" }),
      entry({ date: "2026-10-13", totalHours: 8.6 }),
      entry({ date: "2026-10-14" }),
    ]);
    expect(line).toBe("3 days logged · 23h 48m");
    expect(line).not.toMatch(/ of |to go|done/i);
    expect(weekSummaryLine([entry({ date: "2026-10-12" })])).toBe("1 day logged · 7h 36m");
    expect(weekSummaryLine([])).toBe("Nothing logged yet this week");
  });

  it("names the days that need fixing", () => {
    expect(fixNeededLine([entry({ date: "2026-10-13", status: "rejected" })])).toBe(
      "1 day needs fixing · Tue"
    );
    expect(
      fixNeededLine([
        entry({ date: "2026-10-15", status: "rejected" }),
        entry({ date: "2026-10-13", status: "rejected" }),
      ])
    ).toBe("2 days need fixing · Tue, Thu");
    expect(fixNeededLine([entry({ date: "2026-10-13" })])).toBeNull();
  });
});

describe("picking and auto-advance", () => {
  it("opens on the earliest unlogged weekday of this week (a catch-up starts on Monday)", () => {
    expect(initialPick([], TODAY)).toBe("2026-10-12");
    expect(initialPick([entry({ date: "2026-10-12" }), entry({ date: "2026-10-13" })], TODAY)).toBe(
      "2026-10-14"
    );
  });

  it("opens on today when every weekday is logged but today isn't — including a Saturday", () => {
    const sat = "2026-10-17";
    const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((d) =>
      entry({ date: d })
    );
    expect(initialPick(week, sat)).toBe(sat);
  });

  it("picks nothing when every day up to today is logged", () => {
    const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"].map((d) =>
      entry({ date: d })
    );
    expect(initialPick(week, TODAY)).toBeNull();
  });

  it("after a save the pick moves to the next unlogged weekday up to today", () => {
    expect(nextPickAfterSave("2026-10-12", [], TODAY)).toBe("2026-10-13");
    expect(nextPickAfterSave("2026-10-13", [entry({ date: "2026-10-12" })], TODAY)).toBe(
      "2026-10-14"
    );
  });

  it("never advances into a weekend or tomorrow — Friday saved on a Sunday ends the run", () => {
    const sunday = "2026-10-18";
    const monToThu = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"].map((d) =>
      entry({ date: d })
    );
    expect(nextPickAfterSave("2026-10-16", monToThu, sunday)).toBeNull();
    // Thursday saved today (Thursday): Friday is tomorrow — not offered.
    const monToWed = monToThu.slice(0, 3);
    expect(nextPickAfterSave("2026-10-15", monToWed, TODAY)).toBeNull();
  });

  it("moves forward first; a weekday skipped earlier in the week comes round once the later ones are in", () => {
    // Mon logged, Wed just saved: Thu (today) is next; Tue is still waiting.
    expect(nextPickAfterSave("2026-10-14", [entry({ date: "2026-10-12" })], TODAY)).toBe(
      "2026-10-15"
    );
    // Then Thu saved: nothing after it, so the skipped Tuesday is offered.
    expect(
      nextPickAfterSave(
        "2026-10-15",
        [entry({ date: "2026-10-12" }), entry({ date: "2026-10-14" })],
        TODAY
      )
    ).toBe("2026-10-13");
  });

  it("saving a backdated day from an earlier week resumes this week from Monday", () => {
    expect(nextPickAfterSave("2026-10-09", [], TODAY)).toBe("2026-10-12");
  });
});

describe("jobs", () => {
  it("the default job: this day's pick, else the last job, else the sole job, else none", () => {
    expect(defaultJobId({ picked: "mascot", lastJobId: "bondi", jobs: JOBS })).toBe("mascot");
    expect(defaultJobId({ picked: null, lastJobId: "bondi", jobs: JOBS })).toBe("bondi");
    expect(defaultJobId({ picked: null, lastJobId: "gone", jobs: JOBS })).toBeNull();
    expect(defaultJobId({ picked: null, lastJobId: null, jobs: [JOBS[0]!] })).toBe("bondi");
    expect(defaultJobId({ picked: null, lastJobId: null, jobs: JOBS })).toBeNull();
  });

  it("search matches name or address; leave days are never in the results", () => {
    expect(searchJobs(JOBS, "castle").map((j) => j.id)).toEqual(["castle"]);
    expect(searchJobs(JOBS, "bourke").map((j) => j.id)).toEqual(["mascot"]);
    for (const word of Object.values(LEAVE_LABELS)) {
      expect(searchJobs(JOBS, word)).toEqual([]);
      expect(searchJobs(JOBS, word.split(" ")[0]!)).toEqual([]);
    }
    expect(searchJobs(JOBS, "").map((j) => j.id)).toEqual(["bondi", "mascot", "castle"]);
  });

  it("TAFE is offered to apprentices only", () => {
    expect(leaveOptions(false)).toEqual(["sick", "holiday"]);
    expect(leaveOptions(true)).toEqual(["sick", "holiday", "tafe"]);
  });
});

describe("receipts name the day, the job and the hours", () => {
  it("a standard day, an OT day, a split day and a leave day", () => {
    expect(receiptLine(entry({ date: "2026-10-15" }), JOBS)).toBe(
      "Thu 15 Oct · Bondi switchboard · 7h 36m"
    );
    expect(receiptLine(entry({ date: "2026-10-15", totalHours: 8.6 }), JOBS)).toBe(
      "Thu 15 Oct · Bondi switchboard · 7h 36m + 1h OT"
    );
    expect(
      receiptLine(
        entry({
          date: "2026-10-15",
          allocations: [
            { jobId: "mascot", hours: 4 },
            { jobId: "bondi", hours: 3.6 },
          ],
        }),
        JOBS
      )
    ).toBe("Thu 15 Oct · Mascot warehouse 4h + Bondi switchboard 3h 36m · 7h 36m total");
    expect(
      receiptLine(
        entry({ date: "2026-10-16", dayType: "sick", allocations: [{ jobId: null, hours: 7.6 }] }),
        JOBS
      )
    ).toBe("Fri 16 Oct · Sick day · 7h 36m");
    expect(entryTarget({ dayType: null, allocations: [{ jobId: "gone", hours: 7.6 }] }, JOBS)).toBe(
      "A job you're no longer on"
    );
  });
});

describe("earlier weeks", () => {
  it("folds weeks with entries plus the empty weeks still inside the window, newest first", () => {
    const { weeks, hidden } = buildEarlierWeeks(
      [
        entry({ date: "2026-10-06", status: "approved" }),
        entry({ date: "2026-10-07", status: "approved" }),
        entry({ date: "2026-09-15", status: "rejected" }),
      ],
      TODAY
    );
    expect(hidden).toBe(0);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-10-05", "2026-09-28", "2026-09-14"]);
    expect(weeks[0]!.line).toBe("2 days · all approved");
    expect(weeks[0]!.range).toBe("5–11 Oct");
    expect(weeks[1]!.line).toBe("No days logged");
    expect(weeks[1]!.hasLoggableDays).toBe(true); // Thu 1 – Sun 4 Oct are inside the window
    expect(weeks[2]!.line).toBe("1 day · 1 fix needed");
    expect(weeks[2]!.hasLoggableDays).toBe(false);
  });
});

describe("office drafts", () => {
  it("a draft on an assigned job can be sent; a job the worker is off can't", () => {
    expect(
      draftSendBlockReason(entry({ date: "2026-10-12", status: "draft" }), JOBS, false)
    ).toBeNull();
    expect(
      draftSendBlockReason(
        entry({
          date: "2026-10-12",
          status: "draft",
          allocations: [{ jobId: "gone", hours: 7.6 }],
        }),
        JOBS,
        false
      )
    ).toMatch(/no longer assigned/);
    expect(
      draftSendBlockReason(entry({ date: "2026-10-12", status: "draft" }), JOBS, true)
    ).toMatch(/jobs/);
  });
});
