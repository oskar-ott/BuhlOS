import { describe, expect, it } from "vitest";
import type { MissingLog, TimeEntry } from "./types";
import { buildWeeklyHoursCloseout } from "./weekly-closeout";
import { submittedWeekSelection } from "./weekly-closeout";
import {
  dayCount,
  effectiveDayStatus,
  effectiveWorker,
  holdsTheSend,
  holdUpHelp,
  sessionKey,
  settleApproveResult,
  weekHoldUps,
  withSessionDays,
} from "./week-holdups";

// Pinned, ENDED week: Monday 2024-05-20 … Sunday 2024-05-26; today = Mon 27 May.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-27";

function entry(p: Partial<TimeEntry> & { userId: string; date: string }): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userName: p.userId === "u1" ? "Ari Boland" : p.userId === "u2" ? "Rhys Kelly" : "Sam Pryce",
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

function missing(userId: string, date: string, userName = "Sam Pryce"): MissingLog {
  return { userId, date, userName, role: "Electrician" } as MissingLog;
}

function build(entries: TimeEntry[], missingLogs: MissingLog[] = []) {
  return buildWeeklyHoursCloseout({ entries, missing: missingLogs, weekStart: WEEK_START, todayISO: TODAY });
}

describe("weekHoldUps — every hold-up, with the fix the office can make there", () => {
  const week = build(
    [
      entry({ userId: "u1", date: "2024-05-20", status: "submitted", totalHours: 7.6 }),
      entry({ userId: "u1", date: "2024-05-21", status: "submitted", totalHours: 9.6 }),
      entry({ userId: "u1", date: "2024-05-22", status: "rejected" }),
      entry({ userId: "u2", date: "2024-05-20", status: "approved" }),
      entry({ userId: "u2", date: "2024-05-24", status: "draft", totalHours: 7.6 }),
    ],
    [missing("u3", "2024-05-24")],
  );

  it("names each person's days per kind, in fix order, people A→Z", () => {
    expect(weekHoldUps(week.workers, {}, {})).toEqual([
      {
        workerId: "u1",
        workerName: "Ari Boland",
        kind: "waiting",
        dates: ["2024-05-20", "2024-05-21"],
        days: "Mon 20 May, Tue 21 May",
        hours: 17.2,
      },
      {
        workerId: "u1",
        workerName: "Ari Boland",
        kind: "sentBack",
        dates: ["2024-05-22"],
        days: "Wed 22 May",
        hours: 8,
      },
      {
        workerId: "u2",
        workerName: "Rhys Kelly",
        kind: "draft",
        dates: ["2024-05-24"],
        days: "Fri 24 May",
        hours: 7.6,
      },
      {
        workerId: "u3",
        workerName: "Sam Pryce",
        kind: "missing",
        dates: ["2024-05-24"],
        days: "Fri 24 May",
        hours: 0,
      },
    ]);
  });

  it("an approve that didn't go through reads as 'failed' with its reason — not as waiting", () => {
    const lines = weekHoldUps(week.workers, {}, {}, { u1: "No signal." });
    expect(lines[0]).toMatchObject({ workerId: "u1", kind: "failed", why: "No signal." });
    expect(holdUpHelp(lines[0]!)).toBe("No signal. Nothing's lost — approve again.");
  });

  it("the session overlay settles a worker's submitted days (approved / sent back)", () => {
    expect(weekHoldUps(week.workers, { u1: { status: "approved" } }, {}).map((l) => l.kind)).toEqual([
      "sentBack",
      "draft",
      "missing",
    ]);
    const queried = weekHoldUps(week.workers, { u1: { status: "queried" } }, {});
    expect(queried[0]).toMatchObject({ kind: "sentBack", dates: ["2024-05-20", "2024-05-21", "2024-05-22"] });
  });

  it("a day taken back or sent in moves to 'waiting' the moment its write lands", () => {
    const session = {
      [sessionKey("u1", "2024-05-22")]: "submitted" as const,
      [sessionKey("u2", "2024-05-24")]: "submitted" as const,
    };
    const lines = weekHoldUps(week.workers, {}, session);
    expect(lines.filter((l) => l.kind === "waiting").map((l) => [l.workerId, l.dates])).toEqual([
      ["u1", ["2024-05-20", "2024-05-21", "2024-05-22"]],
      ["u2", ["2024-05-24"]],
    ]);
    expect(lines.some((l) => l.kind === "sentBack" || l.kind === "draft")).toBe(false);
  });

  it("a day approved this session leaves the list even while the page still says submitted", () => {
    const session = {
      [sessionKey("u1", "2024-05-20")]: "approved" as const,
      [sessionKey("u1", "2024-05-21")]: "approved" as const,
    };
    expect(weekHoldUps(week.workers, {}, session).some((l) => l.kind === "waiting")).toBe(false);
  });

  it("only mid-flight days hold the send — drafts and missing days inform (owner call 2026-08-17)", () => {
    const lines = weekHoldUps(week.workers, {}, {});
    expect(lines.filter(holdsTheSend).map((l) => l.kind)).toEqual(["waiting", "sentBack"]);
    expect(dayCount(lines.filter(holdsTheSend))).toBe(3);
  });

  it("a clean, fully approved week has nothing holding it up", () => {
    const clean = build([entry({ userId: "u1", date: "2024-05-20", status: "approved" })]);
    expect(weekHoldUps(clean.workers, {}, {})).toEqual([]);
  });

  it("every line says what's going on and what the button does, in site words", () => {
    for (const l of weekHoldUps(week.workers, {}, {})) {
      const help = holdUpHelp(l);
      expect(help.length).toBeGreaterThan(10);
      expect(help).not.toMatch(/\b(40\d|50\d|error|status|conflict)\b/i);
    }
  });
});

describe("withSessionDays — the worker as it stands after this session's writes", () => {
  const week = build([
    entry({ userId: "u1", date: "2024-05-20", status: "submitted" }),
    entry({ userId: "u1", date: "2024-05-22", status: "rejected", totalHours: 6 }),
  ]);
  const ari = week.workers.find((w) => w.workerId === "u1")!;

  it("a taken-back day is approvable with the rest — Approve sends it too", () => {
    const now = withSessionDays(ari, { [sessionKey("u1", "2024-05-22")]: "submitted" });
    expect(submittedWeekSelection(now).map((s) => s.date)).toEqual(["2024-05-20", "2024-05-22"]);
    expect(now.rejectedCount).toBe(0);
    expect(now.submittedCount).toBe(2);
  });

  it("an approved day counts toward approved hours", () => {
    const now = withSessionDays(ari, { [sessionKey("u1", "2024-05-20")]: "approved" });
    expect(now.approvedHours).toBe(8);
    expect(now.approvedCount).toBe(1);
  });

  it("returns the same worker when nothing changed", () => {
    expect(withSessionDays(ari, {})).toBe(ari);
  });

  it("effectiveDayStatus: the session's own write outranks the overlay and the page", () => {
    const day = ari.days.find((d) => d.date === "2024-05-20")!;
    expect(effectiveDayStatus("u1", day, { u1: { status: "approved" } }, {})).toBe("approved");
    expect(
      effectiveDayStatus("u1", day, { u1: { status: "approved" } }, { [sessionKey("u1", "2024-05-20")]: "submitted" }),
    ).toBe("submitted");
  });
});

describe("settleApproveResult — an already-approved day is done, not a failure", () => {
  it("counts a retry that finds the day approved as done", () => {
    const out = settleApproveResult({
      approved: [{ userId: "u1", date: "2024-05-20" }],
      failed: [
        { userId: "u1", date: "2024-05-21", error: "entry is not submitted (status: approved)" },
        { userId: "u1", date: "2024-05-22", error: "changed moments ago — try again in a minute", code: "conflict" },
        { userId: "u1", date: "2024-05-23", error: "entry is not submitted (status: rejected)" },
      ],
    });
    expect(out.done.map((d) => d.date)).toEqual(["2024-05-20", "2024-05-21"]);
    expect(out.failed.map((f) => f.date)).toEqual(["2024-05-22", "2024-05-23"]);
  });
});

describe("effectiveWorker — overlay and session both applied", () => {
  it("a worker approved this session counts their approved hours before the page catches up", () => {
    const week = buildWeeklyHoursCloseout({
      entries: [
        { id: "a", userId: "u1", userName: "Ari Boland", date: "2024-05-20", status: "submitted", totalHours: 8, ordinaryHours: 8, overtimeHours: 0, allocations: [] } as unknown as TimeEntry,
      ],
      missing: [],
      weekStart: WEEK_START,
      todayISO: TODAY,
    });
    const ari = week.workers[0]!;
    expect(ari.approvedHours).toBe(0);
    expect(effectiveWorker(ari, { u1: { status: "approved" } }, {}).approvedHours).toBe(8);
  });
});
