import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * "Not on this sheet" (api/_lib/not-on-sheet.js) — every worker-day the
 * approved payroll sheet does NOT carry, and why, printed on the sheet itself
 * (2026-10-09: Dylan's and Stephen's unlogged Fridays were a bare count on the
 * phone and nowhere on the sheet that went to accounts).
 *
 * The missing-day rule is the boards' own (api/_lib/missing-days.js, extracted
 * verbatim from the overview), so these pin how the sheet USES it.
 */

const requireFromHere = createRequire(import.meta.url);
const nos = requireFromHere("../../../api/_lib/not-on-sheet.js") as {
  buildNotOnSheet: (input: {
    fromDate: string;
    toDate: string;
    entries: Array<Record<string, unknown>>;
    userById: Record<string, Record<string, unknown>>;
    todayISO?: string;
    deps?: { readLeave?: () => Promise<{ requests: Array<Record<string, unknown>> }> };
  }) => Promise<{
    items: Array<{ workerName: string; date: string; kind: string; reason: string; hours: number | null }>;
    leaveChecked: boolean;
    periodComplete: boolean;
  }>;
  notOnSheetLines: (
    items: Array<Record<string, unknown>>,
  ) => Array<{ workerName: string; reason: string; kind: string; days: string }>;
};

// The 5 Oct week: Mon 28 Sep – Sun 4 Oct 2026, sent Monday 5 Oct.
const FROM = "2026-09-28";
const TO = "2026-10-04";
const TODAY = "2026-10-05";

const users = {
  u_dylan: { id: "u_dylan", name: "Dylan Sinclair", role: "electrician" },
  u_stephen: { id: "u_stephen", name: "Stephen Mayne", role: "electrician" },
  u_louis: { id: "u_louis", name: "Louis Kane", role: "electrician" },
  u_sub: { id: "u_sub", name: "Sam Subbie", role: "subcontractor" },
  u_gone: { id: "u_gone", name: "Old Mate", role: "electrician", archived: true },
  u_boss: { id: "u_boss", name: "Tom", role: "admin" },
};

function day(userId: string, date: string, status = "approved", totalHours = 7.6) {
  return { id: `te_${userId}_${date}`, userId, date, status, totalHours };
}
const weekdays = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
const noLeave = { readLeave: async () => ({ requests: [] }) };

describe("buildNotOnSheet", () => {
  it("the 5 Oct week: names Dylan's and Stephen's Fridays as 'nothing logged' — and nothing else", async () => {
    const entries = [
      ...weekdays.slice(0, 4).map((d) => day("u_dylan", d)),
      ...weekdays.slice(0, 4).map((d) => day("u_stephen", d)),
      ...weekdays.map((d) => day("u_louis", d)),
    ];
    const out = await nos.buildNotOnSheet({ fromDate: FROM, toDate: TO, entries, userById: users, todayISO: TODAY, deps: noLeave });
    expect(out.items.map((i) => [i.workerName, i.date, i.reason])).toEqual([
      ["Dylan Sinclair", "2026-10-02", "nothing logged"],
      ["Stephen Mayne", "2026-10-02", "nothing logged"],
    ]);
    expect(out.periodComplete).toBe(true);
    expect(out.leaveChecked).toBe(true);
  });

  it("every non-approved entry is named with its reason and hours — any role", async () => {
    const entries = [
      ...weekdays.map((d) => day("u_louis", d)),
      day("u_dylan", "2026-09-28", "submitted", 9.6),
      day("u_dylan", "2026-09-29", "rejected"),
      day("u_dylan", "2026-09-30", "draft"),
      day("u_sub", "2026-10-03", "submitted", 5),
    ];
    const out = await nos.buildNotOnSheet({
      fromDate: FROM,
      toDate: TO,
      entries,
      userById: { u_louis: users.u_louis, u_dylan: users.u_dylan, u_sub: users.u_sub },
      todayISO: TODAY,
      deps: noLeave,
    });
    const lines = nos.notOnSheetLines(out.items);
    expect(lines).toEqual([
      { workerName: "Dylan Sinclair", reason: "waiting for approval", kind: "submitted", days: "Mon 28 Sep (9.6h)" },
      { workerName: "Dylan Sinclair", reason: "sent back for a fix", kind: "rejected", days: "Tue 29 Sep (7.6h)" },
      { workerName: "Dylan Sinclair", reason: "not sent in (draft)", kind: "draft", days: "Wed 30 Sep (7.6h)" },
      { workerName: "Dylan Sinclair", reason: "nothing logged", kind: "missing", days: "Thu 1 Oct, Fri 2 Oct" },
      // A subbie's logged-but-unapproved Saturday is named; their quiet
      // weekdays are not (no daily-hours expectation for subbies).
      { workerName: "Sam Subbie", reason: "waiting for approval", kind: "submitted", days: "Sat 3 Oct (5h)" },
    ]);
  });

  it("never asks the office, archived accounts or subbies for hours", async () => {
    const out = await nos.buildNotOnSheet({
      fromDate: FROM,
      toDate: TO,
      entries: [],
      userById: { u_boss: users.u_boss, u_gone: users.u_gone, u_sub: users.u_sub },
      todayISO: TODAY,
      deps: noLeave,
    });
    expect(out.items).toEqual([]);
  });

  it("approved leave is named as leave, not 'nothing logged'; public holidays are never required", async () => {
    // Labour Day (NSW) — Mon 5 Oct 2026 — inside a Mon 5 – Fri 9 Oct range.
    const out = await nos.buildNotOnSheet({
      fromDate: "2026-10-05",
      toDate: "2026-10-09",
      entries: [day("u_louis", "2026-10-06"), day("u_louis", "2026-10-07"), day("u_louis", "2026-10-08")],
      userById: { u_louis: users.u_louis },
      todayISO: "2026-10-12",
      deps: {
        readLeave: async () => ({
          requests: [{ userId: "u_louis", fromDate: "2026-10-09", toDate: "2026-10-09", status: "approved", type: "annual" }],
        }),
      },
    });
    expect(out.items.map((i) => [i.date, i.kind, i.reason])).toEqual([["2026-10-09", "leave", "on annual leave"]]);
  });

  it("says when leave couldn't be checked — never guesses", async () => {
    const out = await nos.buildNotOnSheet({
      fromDate: FROM,
      toDate: TO,
      entries: weekdays.map((d) => day("u_louis", d)),
      userById: { u_louis: users.u_louis },
      todayISO: TODAY,
      deps: {
        readLeave: async () => {
          throw new Error("blob down");
        },
      },
    });
    expect(out.leaveChecked).toBe(false);
  });

  it("a period that isn't over yet is not 'complete', and future days are never 'missing'", async () => {
    const out = await nos.buildNotOnSheet({
      fromDate: FROM,
      toDate: TO,
      entries: [day("u_louis", "2026-09-28")],
      userById: { u_louis: users.u_louis },
      todayISO: "2026-09-29",
      deps: noLeave,
    });
    expect(out.periodComplete).toBe(false);
    expect(out.items.map((i) => i.date)).toEqual(["2026-09-29"]); // today counts, Wed+ doesn't
  });

  it("never asks for hours from before the company go-live (3 Aug 2026)", async () => {
    const out = await nos.buildNotOnSheet({
      fromDate: "2026-07-27",
      toDate: "2026-08-04",
      entries: [],
      userById: { u_louis: users.u_louis },
      todayISO: "2026-08-10",
      deps: noLeave,
    });
    expect(out.items.map((i) => i.date)).toEqual(["2026-08-03", "2026-08-04"]);
  });
});
