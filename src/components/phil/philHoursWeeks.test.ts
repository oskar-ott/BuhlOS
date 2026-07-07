import { describe, expect, it } from "vitest";
import type { TimeEntry } from "@/domains/timesheets/types";
import { addDays, weekStartOf } from "@/domains/timesheets/service";
import {
  buildDraftSendPayload,
  buildHoursWeeks,
  buildJobBreakdown,
  defaultOpenWeeks,
  draftSendBlockReason,
  hoursWeekDot,
  hoursWeekLabel,
  toggleWeek,
  NO_JOB_LABEL,
  UNKNOWN_JOB_LABEL,
} from "./philHoursWeeks";

/**
 * Pure-logic coverage for the sharpened /phil/hours week cards (Wave 2c):
 * week grouping, the honest per-job breakdown, the draft-flush guard, and
 * the fold/unfold state (the repo's vitest runs in the node env with no
 * jsdom, so the collapse interaction is tested through its pure state
 * helpers — the same pattern as useLongPress/createLongPressController).
 */

const TODAY = "2026-06-18"; // a Thursday
const MONDAY = weekStartOf(TODAY); // 2026-06-15
const LAST_MONDAY = addDays(MONDAY, -7);

const JOBS = [
  { id: "j1", name: "Level 12 Office Fitout", ref: "IV0041" },
  { id: "j2", name: "Payneham Rd Bakery", ref: null },
];

let seq = 0;
function entry(over: Partial<TimeEntry> & Pick<TimeEntry, "date" | "status">): TimeEntry {
  seq += 1;
  const totalHours = over.totalHours ?? 7.6;
  return {
    id: `e${seq}`,
    userId: "u1",
    date: over.date,
    totalHours,
    ordinaryHours: over.ordinaryHours ?? Math.min(totalHours, 8),
    overtimeHours: over.overtimeHours ?? Math.max(0, totalHours - 8),
    status: over.status,
    allocations: over.allocations ?? [{ jobId: "j1", hours: totalHours }],
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    notes: over.notes ?? null,
    rejectedReason: over.rejectedReason ?? null,
  } as TimeEntry;
}

describe("buildHoursWeeks", () => {
  it("always includes the current week (even with no entries) and only real past weeks", () => {
    const { weeks } = buildHoursWeeks([], {
      todayISO: TODAY,
      assignedJobs: JOBS,
      jobsError: false,
    });
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.weekStart).toBe(MONDAY);
    expect(weeks[0]!.isCurrent).toBe(true);
    expect(weeks[0]!.totalHours).toBe(0);
  });

  it("groups entries into their true weeks, newest first, and sums real hours", () => {
    const entries = [
      entry({ date: MONDAY, status: "approved", totalHours: 7.6 }),
      entry({ date: addDays(MONDAY, 1), status: "submitted", totalHours: 8 }),
      entry({ date: LAST_MONDAY, status: "approved", totalHours: 7.6 }),
    ];
    const { weeks, hiddenWeekCount } = buildHoursWeeks(entries, {
      todayISO: TODAY,
      assignedJobs: JOBS,
      jobsError: false,
    });
    expect(weeks.map((w) => w.weekStart)).toEqual([MONDAY, LAST_MONDAY]);
    expect(weeks[0]!.totalHours).toBe(15.6);
    expect(weeks[1]!.totalHours).toBe(7.6);
    expect(hiddenWeekCount).toBe(0);
  });

  it("caps the rendered weeks and reports the honest hidden count", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry({ date: addDays(MONDAY, -7 * (i + 1)), status: "approved" }),
    );
    const { weeks, hiddenWeekCount } = buildHoursWeeks(entries, {
      todayISO: TODAY,
      assignedJobs: JOBS,
      jobsError: false,
      maxWeeks: 12,
    });
    expect(weeks).toHaveLength(12);
    expect(hiddenWeekCount).toBe(9); // 20 past weeks + current − 12 shown
  });

  it("splits a week's drafts into sendable vs blocked with worker-words reasons", () => {
    const good = entry({ date: MONDAY, status: "draft" });
    const noJob = entry({
      date: addDays(MONDAY, 1),
      status: "draft",
      allocations: [{ jobId: null, hours: 7.6 }],
    });
    const staleJob = entry({
      date: addDays(MONDAY, 2),
      status: "draft",
      allocations: [{ jobId: "gone", hours: 7.6 }],
    });
    const { weeks } = buildHoursWeeks([good, noJob, staleJob], {
      todayISO: TODAY,
      assignedJobs: JOBS,
      jobsError: false,
    });
    const week = weeks[0]!;
    expect(week.sendableDrafts.map((d) => d.id)).toEqual([good.id]);
    expect(week.blockedDrafts).toHaveLength(2);
    expect(week.blockedDrafts[0]!.reason).toContain("No job attached");
    expect(week.blockedDrafts[1]!.reason).toContain("no longer assigned");
  });
});

describe("hoursWeekDot", () => {
  it("ranks worst-first from real statuses", () => {
    expect(hoursWeekDot([{ status: "approved" }, { status: "rejected" }])).toBe("danger");
    expect(hoursWeekDot([{ status: "approved" }, { status: "draft" }])).toBe("warning");
    expect(hoursWeekDot([{ status: "approved" }, { status: "submitted" }])).toBe("info");
    expect(hoursWeekDot([{ status: "approved" }])).toBe("success");
    expect(hoursWeekDot([])).toBe("neutral");
  });
});

describe("draftSendBlockReason (attribution invariant)", () => {
  it("blocks everything while jobs are unloadable", () => {
    const d = entry({ date: MONDAY, status: "draft" });
    expect(draftSendBlockReason(d, JOBS, true)).toContain("Couldn't load your jobs");
  });

  it("passes only fully-attributed drafts on active assigned jobs", () => {
    expect(draftSendBlockReason(entry({ date: MONDAY, status: "draft" }), JOBS, false)).toBeNull();
    expect(
      draftSendBlockReason(
        entry({
          date: MONDAY,
          status: "draft",
          allocations: [
            { jobId: "j1", hours: 4 },
            { jobId: null, hours: 3.6 },
          ],
        }),
        JOBS,
        false,
      ),
    ).toContain("No job attached");
  });

  it("never claims a non-draft is sendable", () => {
    expect(draftSendBlockReason(entry({ date: MONDAY, status: "submitted" }), JOBS, false)).toBe(
      "Not a draft",
    );
  });
});

describe("buildDraftSendPayload", () => {
  it("carries the entry unchanged and only moves status to submitted", () => {
    const d = entry({
      date: MONDAY,
      status: "draft",
      totalHours: 9,
      ordinaryHours: 8,
      overtimeHours: 1,
      notes: "long one",
      allocations: [
        { jobId: "j1", hours: 5 },
        { jobId: "j2", hours: 4, notes: "arvo" },
      ],
    });
    expect(buildDraftSendPayload(d)).toEqual({
      date: MONDAY,
      totalHours: 9,
      ordinaryHours: 8,
      overtimeHours: 1,
      allocations: [
        { jobId: "j1", hours: 5, notes: null },
        { jobId: "j2", hours: 4, notes: "arvo" },
      ],
      notes: "long one",
      status: "submitted",
    });
  });
});

describe("buildJobBreakdown", () => {
  it("sums real allocation hours per job with honest fallbacks", () => {
    const rows = buildJobBreakdown(
      [
        entry({ date: MONDAY, status: "approved", allocations: [{ jobId: "j1", hours: 7.6 }] }),
        entry({
          date: addDays(MONDAY, 1),
          status: "approved",
          allocations: [
            { jobId: "j1", hours: 5 },
            { jobId: "j2", hours: 3 },
          ],
        }),
        entry({
          date: addDays(MONDAY, 2),
          status: "approved",
          allocations: [{ jobId: "gone", hours: 2 }],
        }),
        entry({
          date: addDays(MONDAY, 3),
          status: "approved",
          allocations: [{ jobId: null, hours: 1 }],
        }),
      ],
      JOBS,
    );
    expect(rows[0]).toMatchObject({ name: "Level 12 Office Fitout", ref: "IV0041", hours: 12.6, known: true });
    expect(rows[1]).toMatchObject({ name: "Payneham Rd Bakery", ref: null, hours: 3, known: true });
    // Unknown/unattributed sink below the real jobs, honestly labelled.
    const names = rows.map((r) => r.name);
    expect(names).toContain(UNKNOWN_JOB_LABEL);
    expect(names).toContain(NO_JOB_LABEL);
    expect(rows[0]!.known).toBe(true);
    expect(rows[2]!.known).toBe(false);
  });
});

describe("week labels", () => {
  it("names this week and last week, then real ranges", () => {
    expect(hoursWeekLabel(MONDAY, TODAY)).toBe("This week");
    expect(hoursWeekLabel(LAST_MONDAY, TODAY)).toBe("Last week");
    expect(hoursWeekLabel(addDays(MONDAY, -14), TODAY)).toMatch(/1–7 Jun/);
  });
});

describe("fold/unfold (the collapse interaction, pure)", () => {
  const weeks = [
    { weekStart: MONDAY, isCurrent: true },
    { weekStart: LAST_MONDAY, isCurrent: false },
  ];

  it("defaults this week open and prior weeks folded", () => {
    expect(defaultOpenWeeks(weeks)).toEqual({
      [MONDAY]: true,
      [LAST_MONDAY]: false,
    });
  });

  it("toggle opens a folded week and folds it again on the second tap", () => {
    let open = defaultOpenWeeks(weeks);
    open = toggleWeek(open, LAST_MONDAY);
    expect(open[LAST_MONDAY]).toBe(true);
    expect(open[MONDAY]).toBe(true); // other cards untouched
    open = toggleWeek(open, LAST_MONDAY);
    expect(open[LAST_MONDAY]).toBe(false);
    open = toggleWeek(open, MONDAY);
    expect(open[MONDAY]).toBe(false); // this week can fold too
  });
});
