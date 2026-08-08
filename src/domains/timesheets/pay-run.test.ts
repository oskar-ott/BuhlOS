import { describe, expect, it } from "vitest";
import type { MissingLog, TimeEntry } from "./types";
import { buildWeeklyHoursCloseout } from "./weekly-closeout";
import {
  PAY_RUN_BULK_MAX,
  buildPayRun,
  isCleanWeek,
  isFlaggedWeek,
  shortHours,
  toStripCell,
  wholeDollarsFromCents,
  workerStrip,
} from "./pay-run";

// Pinned week: Monday 2024-05-20 … Sunday 2024-05-26; today = Friday 2024-05-24.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-24";

function entry(p: Partial<TimeEntry> & { userId: string; date: string }): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userName:
      p.userId === "u1" ? "Oskar Ott" : p.userId === "u2" ? "Jack Smith" : "Tom Brown",
    userRole: "tradie",
    totalHours: 7.6,
    status: "approved",
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: p.totalHours ?? 7.6 }],
    ...p,
  } as unknown as TimeEntry;
}

function missing(userId: string, date: string, userName = "Oskar Ott"): MissingLog {
  return { userId, date, userName, role: "tradie" } as MissingLog;
}

function build(
  entries: TimeEntry[],
  missingLogs: MissingLog[] = [],
  opts: {
    weekStart?: string;
    todayISO?: string;
    leave?: Array<{ date: string; userId: string; type: string }>;
    holidays?: Array<{ date: string; name: string }>;
  } = {},
) {
  return buildWeeklyHoursCloseout({
    entries,
    missing: missingLogs,
    weekStart: opts.weekStart ?? WEEK_START,
    todayISO: opts.todayISO ?? TODAY,
    leave: opts.leave,
    holidays: opts.holidays,
  });
}

const workerById = (c: ReturnType<typeof build>, id: string) =>
  c.workers.find((w) => w.workerId === id)!;

describe("isFlaggedWeek / isCleanWeek", () => {
  it("a submitted-only week is clean, not flagged", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "submitted" })]);
    const w = workerById(c, "u1");
    expect(isCleanWeek(w)).toBe(true);
    expect(isFlaggedWeek(w)).toBe(false);
  });

  it("a week with a rejected day is flagged and NOT clean", () => {
    const c = build([
      entry({ userId: "u1", date: WEEK_START, status: "submitted" }),
      entry({ userId: "u1", date: "2024-05-21", status: "rejected" }),
    ]);
    const w = workerById(c, "u1");
    expect(isFlaggedWeek(w)).toBe(true);
    expect(isCleanWeek(w)).toBe(false);
  });

  it("a missing day flags the week and keeps it out of the clean sweep", () => {
    const c = build(
      [entry({ userId: "u1", date: WEEK_START, status: "submitted" })],
      [missing("u1", "2024-05-22")],
    );
    const w = workerById(c, "u1");
    expect(isFlaggedWeek(w)).toBe(true);
    expect(isCleanWeek(w)).toBe(false);
  });

  it("an approved-only (settled) week is neither flagged nor clean — nothing to do", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "approved" })]);
    const w = workerById(c, "u1");
    expect(isFlaggedWeek(w)).toBe(false);
    expect(isCleanWeek(w)).toBe(false);
  });

  it("a draft day flags the week (worker action needed)", () => {
    const c = build([
      entry({ userId: "u1", date: WEEK_START, status: "submitted" }),
      entry({ userId: "u1", date: "2024-05-21", status: "draft" }),
    ]);
    expect(isFlaggedWeek(workerById(c, "u1"))).toBe(true);
  });
});

describe("buildPayRun — hero", () => {
  it("counts crew / ready / need-action / flagged from the closeout", () => {
    const c = build(
      [
        // u1: fully approved → ready
        entry({ userId: "u1", date: WEEK_START, status: "approved" }),
        // u2: submitted only → clean, needs action, not flagged
        entry({ userId: "u2", date: WEEK_START, status: "submitted" }),
        // u3: rejected → flagged, needs action
        entry({ userId: "u3", date: WEEK_START, status: "rejected" }),
      ],
    );
    const { hero } = buildPayRun(c);
    expect(hero.crewCount).toBe(3);
    expect(hero.readyCount).toBe(1);
    expect(hero.needActionCount).toBe(2);
    expect(hero.flaggedCount).toBe(1);
  });

  it("progress is readyCount/crewCount rounded; allReady only when everyone is ready", () => {
    const c = build([
      entry({ userId: "u1", date: WEEK_START, status: "approved" }),
      entry({ userId: "u2", date: WEEK_START, status: "submitted" }),
    ]);
    const { hero } = buildPayRun(c);
    expect(hero.progressPct).toBe(50);
    expect(hero.allReady).toBe(false);
  });

  it("allReady true + 100% when every worker is payroll-ready", () => {
    const c = build([
      entry({ userId: "u1", date: WEEK_START, status: "approved" }),
      entry({ userId: "u2", date: WEEK_START, status: "approved" }),
    ]);
    const { hero } = buildPayRun(c);
    expect(hero.allReady).toBe(true);
    expect(hero.progressPct).toBe(100);
  });

  it("an empty run is 0%, never a fabricated all-ready", () => {
    const c = build([]);
    const { hero } = buildPayRun(c);
    expect(hero.crewCount).toBe(0);
    expect(hero.progressPct).toBe(0);
    expect(hero.allReady).toBe(false);
  });

  it("formats approved hours and the week range, never money", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "approved", totalHours: 8 })]);
    const { hero } = buildPayRun(c);
    expect(hero.approvedHoursLabel).toBe("8h");
    expect(hero.rangeLabel).toMatch(/May/);
    // No money field exists on the hero at all.
    expect(Object.keys(hero)).not.toContain("labour");
  });
});

describe("buildPayRun — clean sweep selection", () => {
  it("collects submitted days from clean weeks only", () => {
    const c = build([
      // clean: two submitted days
      entry({ userId: "u1", date: WEEK_START, status: "submitted" }),
      entry({ userId: "u1", date: "2024-05-21", status: "submitted" }),
      // flagged: submitted + rejected → excluded entirely
      entry({ userId: "u2", date: WEEK_START, status: "submitted" }),
      entry({ userId: "u2", date: "2024-05-21", status: "rejected" }),
    ]);
    const vm = buildPayRun(c);
    expect(vm.cleanWorkerCount).toBe(1);
    expect(vm.cleanApproval).toEqual([
      { userId: "u1", date: "2024-05-20" },
      { userId: "u1", date: "2024-05-21" },
    ]);
    // u2 (flagged) contributes nothing.
    expect(vm.cleanApproval.some((e) => e.userId === "u2")).toBe(false);
  });

  it("never includes approved/draft/missing days in the sweep body", () => {
    const c = build(
      [
        entry({ userId: "u1", date: WEEK_START, status: "submitted" }),
        entry({ userId: "u1", date: "2024-05-21", status: "approved" }),
      ],
      [],
    );
    const vm = buildPayRun(c);
    // Only the submitted day is swept; the approved day is left alone.
    expect(vm.cleanApproval).toEqual([{ userId: "u1", date: "2024-05-20" }]);
  });

  it("empty run → empty sweep, zero clean workers", () => {
    const vm = buildPayRun(build([]));
    expect(vm.cleanApproval).toEqual([]);
    expect(vm.cleanWorkerCount).toBe(0);
  });

  it("caps the sweep body at the endpoint maximum", () => {
    expect(PAY_RUN_BULK_MAX).toBe(50);
  });
});

describe("toStripCell / workerStrip", () => {
  it("produces seven cells Mon→Sun", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "approved" })]);
    const cells = workerStrip(workerById(c, "u1"));
    expect(cells.map((cell) => cell.weekday)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
  });

  it("maps status → tone and shows hours, never a fake 0", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "approved", totalHours: 8 })]);
    const cells = workerStrip(workerById(c, "u1"));
    const mon = cells[0]!;
    expect(mon.tone).toBe("approved");
    expect(mon.hoursLabel).toBe("8h");
    expect(mon.emptyGlyph).toBe("");
    // Tuesday (no entry, past weekday the server doesn't track) → empty, "·".
    const tue = cells[1]!;
    expect(tue.hoursLabel).toBeNull();
  });

  it("missing day renders the em-dash glyph and a 'missing' tone (ended week)", () => {
    const c = build(
      [entry({ userId: "u1", date: WEEK_START, status: "approved" })],
      [missing("u1", "2024-05-22")],
      { todayISO: "2024-05-27" },
    );
    const wed = workerStrip(workerById(c, "u1")).find((cell) => cell.date === "2024-05-22")!;
    expect(wed.tone).toBe("missing");
    expect(wed.emptyGlyph).toBe("—");
    expect(wed.title).toMatch(/Missing/);
  });

  it("leave and holiday days carry their reason in the title", () => {
    const c = build(
      [entry({ userId: "u1", date: WEEK_START, status: "approved" })],
      [],
      {
        leave: [{ userId: "u1", date: "2024-05-21", type: "annual" }],
        holidays: [{ date: "2024-05-22", name: "Show Day" }],
      },
    );
    const cells = workerStrip(workerById(c, "u1"));
    const tue = cells.find((cell) => cell.date === "2024-05-21")!;
    const wed = cells.find((cell) => cell.date === "2024-05-22")!;
    expect(tue.tone).toBe("leave");
    expect(tue.title).toMatch(/annual/);
    expect(wed.tone).toBe("holiday");
    expect(wed.title).toMatch(/Show Day/);
  });

  it("toStripCell builds a full title with day, status and job", () => {
    const cell = toStripCell({
      date: "2024-05-20",
      weekday: "Mon",
      status: "submitted",
      entryId: "x",
      jobLabel: "100 Arthur",
      allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: 7.6 }],
      hours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      note: null,
      rejectedReason: null,
      exportId: null,
      leaveType: null,
      holidayName: null,
    });
    expect(cell.title).toContain("Submitted");
    expect(cell.title).toContain("100 Arthur");
    expect(cell.hoursLabel).toBe("7h 36m");
    // §5 dense strip: the raw number + its compact string.
    expect(cell.hoursNumber).toBe(7.6);
    expect(cell.hoursShort).toBe("7.6");
  });

  it("toStripCell leaves hoursNumber/hoursShort null for a day with no hours", () => {
    const cell = toStripCell({
      date: "2024-05-22",
      weekday: "Wed",
      status: "missing",
      entryId: null,
      jobLabel: null,
      allocations: null,
      hours: null,
      ordinaryHours: null,
      overtimeHours: null,
      note: null,
      rejectedReason: null,
      exportId: null,
      leaveType: null,
      holidayName: null,
    });
    expect(cell.hoursNumber).toBeNull();
    expect(cell.hoursShort).toBeNull();
    expect(cell.emptyGlyph).toBe("—");
  });
});

describe("§5 hero — logged hours, labour $, need-a-look", () => {
  it("carries logged hours, the labour figure and the need-a-look count", () => {
    const closeout = buildWeeklyHoursCloseout({
      entries: [
        entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 8 }),
        entry({ userId: "u2", date: "2024-05-20", status: "rejected", totalHours: 9, rejectedReason: "x" }),
      ],
      missing: [],
      weekStart: WEEK_START,
      todayISO: TODAY,
      costRatesByWorker: { u1: 5000, u2: 5000 }, // both $50/h
    });
    const { hero } = buildPayRun(closeout);
    expect(hero.loggedHoursShort).toBe("17"); // 8 + 9
    // $50 × (8 + 9) = $850, whole-dollar with separator.
    expect(hero.labourLabel).toBe("$850");
    expect(hero.needLookCount).toBe(1); // u2 is flagged (rejected)
  });

  it("omits the labour label when NO worker has a cost rate", () => {
    const closeout = buildWeeklyHoursCloseout({
      entries: [entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 8 })],
      missing: [],
      weekStart: WEEK_START,
      todayISO: TODAY,
    });
    expect(buildPayRun(closeout).hero.labourLabel).toBeNull();
  });
});

describe("shortHours / wholeDollarsFromCents", () => {
  it("shortHours trims to a clean decimal, null for no hours", () => {
    expect(shortHours(8)).toBe("8");
    expect(shortHours(8.5)).toBe("8.5");
    expect(shortHours(10.25)).toBe("10.25");
    expect(shortHours(0)).toBeNull();
    expect(shortHours(null)).toBeNull();
  });

  it("wholeDollarsFromCents rounds to whole dollars with a separator, null for ≤0", () => {
    expect(wholeDollarsFromCents(52_500)).toBe("$525");
    expect(wholeDollarsFromCents(2_418_000)).toBe("$24,180");
    expect(wholeDollarsFromCents(0)).toBeNull();
    expect(wholeDollarsFromCents(null)).toBeNull();
  });
});
