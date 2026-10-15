import { describe, expect, it } from "vitest";
import type { MissingLog, TimeEntry } from "./types";
import { buildWeeklyHoursCloseout } from "./weekly-closeout";
import {
  applyCloseoutPatches,
  applyDayPatches,
  pruneConfirmedPatches,
  withDayPatch,
  withDayPatches,
  type DayPatches,
} from "./closeout-patches";

// Pinned, ENDED week: Monday 2024-05-20 … Sunday 2024-05-26; today = Mon 27 May.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-27";

function entry(p: Partial<TimeEntry> & { userId: string; date: string }): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userName: p.userId === "u1" ? "Ari Boland" : "Rhys Kelly",
    userRole: "Electrician",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "j1", jobName: "UTS Building 11", hours: p.totalHours ?? 8 }],
    ...p,
  } as unknown as TimeEntry;
}

function missing(userId: string, date: string): MissingLog {
  return { userId, date, userName: "Rhys Kelly", role: "Electrician" } as MissingLog;
}

function build(entries: TimeEntry[], missingLogs: MissingLog[] = []) {
  return buildWeeklyHoursCloseout({
    entries,
    missing: missingLogs,
    weekStart: WEEK_START,
    todayISO: TODAY,
  });
}

const week = build(
  [
    entry({ userId: "u1", date: "2024-05-20", status: "submitted", totalHours: 7.6 }),
    entry({ userId: "u1", date: "2024-05-21", status: "submitted", totalHours: 9.6, overtimeHours: 2 }),
    entry({ userId: "u2", date: "2024-05-20", status: "approved" }),
  ],
  [missing("u2", "2024-05-24")],
);
const ari = () => week.workers.find((w) => w.workerId === "u1")!;
const rhys = () => week.workers.find((w) => w.workerId === "u2")!;

describe("applyDayPatches — the row moves the moment the server answers", () => {
  it("an approved day flips the status, the counts, the chip's readiness and the week's blockers", () => {
    const w = ari();
    expect(w.readiness).toBe("needs-review");
    const patched = applyDayPatches(
      w,
      withDayPatch({}, "u1", "2024-05-20", { status: "approved", rejectedReason: null }),
    );
    expect(patched.days[0]!.status).toBe("approved");
    expect(patched.days[1]!.status).toBe("submitted");
    expect(patched.approvedCount).toBe(1);
    expect(patched.approvedHours).toBe(7.6);
    expect(patched.submittedCount).toBe(1);
    expect(patched.readiness).toBe("needs-review");
    expect(patched.blockers).toEqual(["Tue waiting for review"]);
    // The stored overtime line is re-derived from the day, exactly as the build does.
    expect(patched.needsLookReasons).toEqual(["Tue carries 2h overtime — needs your nod."]);
  });

  it("a whole week approved is payroll-ready with no blockers — same roll-up as the server", () => {
    const w = ari();
    const patched = applyDayPatches(
      w,
      withDayPatches(
        {},
        [
          { userId: "u1", date: "2024-05-20" },
          { userId: "u1", date: "2024-05-21" },
        ],
        { status: "approved", rejectedReason: null },
      ),
    );
    expect(patched.readiness).toBe("payroll-ready");
    expect(patched.submittedCount).toBe(0);
    expect(patched.approvedHours).toBe(17.2);
    expect(patched.blockers).toEqual([]);
    // The server's own build of the same facts agrees line for line.
    const server = build([
      entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 7.6 }),
      entry({ userId: "u1", date: "2024-05-21", status: "approved", totalHours: 9.6, overtimeHours: 2 }),
    ]).workers[0]!;
    expect(patched.needsLookReasons).toEqual(server.needsLookReasons);
    expect(patched.blockers).toEqual(server.blockers);
  });

  it("a sent-back day carries the reason into the 'needs a look' line and flips to needs-worker", () => {
    const w = ari();
    const patched = applyDayPatches(
      w,
      withDayPatches(
        {},
        [
          { userId: "u1", date: "2024-05-20" },
          { userId: "u1", date: "2024-05-21" },
        ],
        { status: "rejected", rejectedReason: "Wrong job on Monday" },
      ),
    );
    expect(patched.readiness).toBe("needs-worker");
    expect(patched.rejectedCount).toBe(2);
    expect(patched.days[0]!.rejectedReason).toBe("Wrong job on Monday");
    expect(patched.needsLookReasons[0]).toBe(
      'Mon bounced back — "Wrong job on Monday". Waiting on the worker.',
    );
  });

  it("a reopen clears the old reason; a leave mark stops the day counting as missing", () => {
    const w = rhys();
    expect(w.missingCount).toBe(1);
    const marked = applyDayPatches(
      w,
      withDayPatch({}, "u2", "2024-05-24", { status: "leave", leaveType: "annual" }),
    );
    expect(marked.missingCount).toBe(0);
    expect(marked.readiness).toBe("payroll-ready");
    expect(marked.days[4]!.leaveType).toBe("annual");

    const reopened = applyDayPatches(
      w,
      withDayPatch({}, "u2", "2024-05-20", { status: "submitted", rejectedReason: null }),
    );
    expect(reopened.approvedCount).toBe(0);
    expect(reopened.submittedCount).toBe(1);
    expect(reopened.readiness).toBe("needs-review");
  });

  it("returns the same worker when no patch touches them (stable refs, no churn)", () => {
    const w = ari();
    const patches = withDayPatch({}, "u2", "2024-05-20", { status: "submitted" });
    expect(applyDayPatches(w, patches)).toBe(w);
    expect(applyCloseoutPatches(week, {})).toBe(week);
  });
});

describe("applyCloseoutPatches — the Week-of hero re-sums from the patched rows", () => {
  it("re-sums the summary and keeps the page's worker order", () => {
    const patched = applyCloseoutPatches(
      week,
      withDayPatches(
        {},
        [
          { userId: "u1", date: "2024-05-20" },
          { userId: "u1", date: "2024-05-21" },
        ],
        { status: "approved", rejectedReason: null },
      ),
    );
    expect(patched.summary.submittedDays).toBe(0);
    expect(patched.summary.approvedHours).toBe(25.2);
    expect(patched.summary.workersReady).toBe(1);
    expect(patched.summary.workersNeedAction).toBe(1); // Rhys still has a missing day
    expect(patched.summary.payrollReady).toBe(false);
    expect(patched.workers.map((w) => w.workerId)).toEqual(week.workers.map((w) => w.workerId));
    // Entry-level slices stay the page's until the reconcile.
    expect(patched.approvedByJob).toBe(week.approvedByJob);
  });
});

describe("pruneConfirmedPatches — the page is the truth again once it agrees", () => {
  it("drops a patch the page now confirms and keeps one it still trails", () => {
    const patches: DayPatches = withDayPatches(
      {},
      [
        { userId: "u1", date: "2024-05-20" },
        { userId: "u1", date: "2024-05-21" },
      ],
      { status: "approved", rejectedReason: null },
    );
    // The next read confirms Monday only (the CDN still serves Tuesday stale).
    const next = build([
      entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 7.6 }),
      entry({ userId: "u1", date: "2024-05-21", status: "submitted", totalHours: 9.6 }),
    ]);
    const pruned = pruneConfirmedPatches(patches, next);
    expect(Object.keys(pruned)).toEqual(["u1|2024-05-21"]);
    // Nothing confirmed → the same object back (a setter can bail out).
    expect(pruneConfirmedPatches(pruned, week)).toBe(pruned);
    expect(pruneConfirmedPatches({}, week)).toEqual({});
  });

  it("once confirmed, a later change by the worker shows through (never masked)", () => {
    const sentBack = withDayPatch({}, "u1", "2024-05-20", {
      status: "rejected",
      rejectedReason: "Fix the job",
    });
    const confirmed = build([entry({ userId: "u1", date: "2024-05-20", status: "rejected" })]);
    const pruned = pruneConfirmedPatches(sentBack, confirmed);
    expect(pruned).toEqual({});
    const resubmitted = build([entry({ userId: "u1", date: "2024-05-20", status: "submitted" })]);
    expect(applyCloseoutPatches(resubmitted, pruned).workers[0]!.days[0]!.status).toBe("submitted");
  });
});
