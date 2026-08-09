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
  mergeSavedEntries,
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
    // Default split mirrors the server's autoSplitOT (OT after the standard
    // day, 7.6h — owner-directed 2026-08-09).
    ordinaryHours: over.ordinaryHours ?? Math.min(totalHours, 7.6),
    overtimeHours: over.overtimeHours ?? Math.max(0, Math.round((totalHours - 7.6) * 100) / 100),
    status: over.status,
    allocations: over.allocations ?? [{ jobId: "j1", hours: totalHours }],
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    notes: over.notes ?? null,
    rejectedReason: over.rejectedReason ?? null,
  } as TimeEntry;
}

describe("buildHoursWeeks", () => {
  it("always includes the current AND previous week (even with no entries); older weeks stay entry-only", () => {
    // 2026-08-10 field incident: with no last-week card there were no
    // missed-row "Log" pills, and the this-week day dial offered no other
    // path — the worker could neither see nor backfill the week even though
    // every day was still inside the 14-day backdate window.
    const { weeks } = buildHoursWeeks([], {
      todayISO: TODAY,
      assignedJobs: JOBS,
      jobsError: false,
    });
    expect(weeks).toHaveLength(2);
    expect(weeks[0]!.weekStart).toBe(MONDAY);
    expect(weeks[0]!.isCurrent).toBe(true);
    expect(weeks[0]!.totalHours).toBe(0);
    // The empty previous week renders honestly: no entries, no hours, a
    // neutral dot — its card exists purely so the "Not logged" day rows
    // (and their window-guarded Log pills) have somewhere to live.
    expect(weeks[1]!.weekStart).toBe(LAST_MONDAY);
    expect(weeks[1]!.isCurrent).toBe(false);
    expect(weeks[1]!.entries).toEqual([]);
    expect(weeks[1]!.totalHours).toBe(0);
    expect(weeks[1]!.dot).toBe("neutral");
    // Two weeks back stays absent without entries — those days age out of
    // the backdate window; empty cards would bury the real history.
    expect(weeks.some((w) => w.weekStart === addDays(MONDAY, -14))).toBe(false);
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
    // The week's stored-OT sum rides alongside the total (owner-directed
    // 2026-08-09): the 8h day carries 0.4h stored OT, the standard days none.
    expect(weeks[0]!.overtimeHours).toBe(0.4);
    expect(weeks[1]!.overtimeHours).toBe(0);
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

  it("reuses the allocation's server-enriched jobName for an off-roster job — same rule as the day rows", () => {
    const rows = buildJobBreakdown(
      [
        entry({
          date: MONDAY,
          status: "approved",
          allocations: [
            // Enriched: the server sent the real name of a job the worker is
            // no longer assigned to — the breakdown must not relabel it
            // "A job you're no longer on" while the day row shows "Old Depot".
            { jobId: "gone-named", jobName: "Old Depot", hours: 3 },
            // Not enriched: no name exists anywhere — the honest label stays.
            { jobId: "gone-bare", hours: 2 },
          ],
        }),
      ],
      JOBS,
    );
    const named = rows.find((r) => r.jobId === "gone-named")!;
    expect(named).toMatchObject({ name: "Old Depot", ref: null, hours: 3, known: false });
    const bare = rows.find((r) => r.jobId === "gone-bare")!;
    expect(bare).toMatchObject({ name: UNKNOWN_JOB_LABEL, hours: 2, known: false });
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

describe("mergeSavedEntries (optimistic overlay for confirmed saves)", () => {
  it("adds a just-saved day the lagging server list is missing", () => {
    const server = [entry({ date: LAST_MONDAY, status: "approved" })];
    const saved = entry({ date: MONDAY, status: "submitted" });
    const merged = mergeSavedEntries(server, [saved]);
    expect(merged.map((e) => e.date)).toEqual([MONDAY, LAST_MONDAY]);
    expect(merged[0]!.status).toBe("submitted");
  });

  it("replaces a stale server copy of the same date (saved is same-or-newer)", () => {
    const stale = entry({ date: MONDAY, status: "draft" });
    stale.updatedAt = "2026-06-18T01:00:00Z";
    const saved = entry({ date: MONDAY, status: "submitted", totalHours: 9 });
    saved.updatedAt = "2026-06-18T02:00:00Z";
    const merged = mergeSavedEntries([stale], [saved]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe("submitted");
    expect(merged[0]!.totalHours).toBe(9);
  });

  it("keeps a strictly newer server copy (the office decided in between)", () => {
    const saved = entry({ date: MONDAY, status: "submitted" });
    saved.updatedAt = "2026-06-18T02:00:00Z";
    const decided = entry({ date: MONDAY, status: "approved" });
    decided.updatedAt = "2026-06-18T03:00:00Z";
    const merged = mergeSavedEntries([decided], [saved]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe("approved");
  });

  it("no saves → the server list unchanged (same reference, no churn)", () => {
    const server = [entry({ date: MONDAY, status: "approved" })];
    expect(mergeSavedEntries(server, [])).toBe(server);
  });
});
