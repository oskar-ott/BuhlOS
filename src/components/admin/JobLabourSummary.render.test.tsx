import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobLabourSummary } from "./JobLabourSummary";
import type { CostRateEntry } from "@/domains/cost-rates/schema";
import type { TimeEntry } from "@/domains/timesheets/types";

// Plain server component (no hooks / next-navigation), so renderToString needs
// no mocks. Asserts the Labour card shows real, job-scoped hours AND their
// cost (owner pull 2026-08-23), names every worker, and is honest when rates
// are unknown or missing.
function entry(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "te-1",
    userId: "u1",
    userName: "Jack",
    date: "2026-06-04",
    status: "submitted",
    totalHours: 8,
    allocations: [{ jobId: "job-1", hours: 8 }],
    ...over,
  } as unknown as TimeEntry;
}

function rate(costRateCents: number, effectiveFrom = "2026-01-01"): CostRateEntry {
  return {
    id: `cr-${costRateCents}-${effectiveFrom}`,
    costRateCents,
    chargeOutRateCents: null,
    effectiveFrom,
    setBy: "u_admin",
    setByName: "boss",
    setAt: "2026-01-01T00:00:00.000Z",
  };
}

function render(props: {
  entries: TimeEntry[];
  jobId: string;
  fetchError: string | null;
  estimatedHours?: number | null;
  progressPct?: number | null;
  ratesByUser?: Record<string, CostRateEntry[]> | null;
  employeeIdByUserId?: Record<string, string>;
}): string {
  return renderToString(createElement(JobLabourSummary, props));
}

describe("JobLabourSummary", () => {
  it("is honest when nothing is logged and links the week board (never /hours/approvals)", () => {
    const html = render({ entries: [], jobId: "job-1", fetchError: null });
    expect(html).toContain("No hours logged yet");
    expect(html).not.toContain("Awaiting approval"); // no stat tiles
    expect(html).toContain("/hours/weekly");
    expect(html).toContain("Week board");
    expect(html).not.toContain("/hours/approvals");
  });

  it("labels the link 'Approve on the week board' while hours await approval", () => {
    const html = render({ entries: [entry()], jobId: "job-1", fetchError: null });
    expect(html).toContain("Approve on the week board");
    expect(html).toContain("Awaiting approval");
  });

  it("shows approved AND awaiting hours by status, both workers in the table", () => {
    const html = render({
      entries: [
        entry({
          id: "a",
          userId: "u1",
          userName: "Jack",
          status: "submitted",
          allocations: [{ jobId: "job-1", hours: 8 }],
        } as Partial<TimeEntry>),
        entry({
          id: "b",
          userId: "u2",
          userName: "Sam",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 12 }],
        } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain(">Approved<"); // tile label
    expect(html).toContain("12h"); // approved
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("8h"); // pending
    expect(html).toContain("Jack");
    expect(html).toContain("Sam");
    expect(html).toContain('data-testid="labour-workers"');
  });

  it("with rates UNKNOWN (null) every cost reads — and says 'office only'; no Cost column", () => {
    const html = render({
      entries: [entry({ status: "approved" })],
      jobId: "job-1",
      fetchError: null,
      ratesByUser: null,
    });
    expect(html).toContain("office only");
    expect(html).not.toContain(">Cost<");
    expect(html).not.toContain("$");
  });

  it("costs approved hours per worker at the effective rate — the Money card's number", () => {
    const html = render({
      entries: [
        entry({
          id: "a",
          userId: "u1",
          userName: "Jack",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 8 }],
        } as Partial<TimeEntry>),
        entry({
          id: "b",
          userId: "u2",
          userName: "Sam",
          status: "submitted",
          allocations: [{ jobId: "job-1", hours: 4 }],
        } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
      ratesByUser: { u1: [rate(5000)], u2: [rate(5000)] },
    });
    expect(html).toContain("Labour cost");
    expect(html).toContain("$400"); // 8h × $50 approved
    expect(html).toContain("If approved");
    expect(html).toContain("$200"); // 4h × $50 awaiting, shown separately
    expect(html).toContain(">Cost<");
    expect(html).toContain("approved hours × cost rate");
  });

  it("an unrated worker gets a 'Set rate' link to THEIR employee record and the tile says so", () => {
    const html = render({
      entries: [
        entry({
          id: "a",
          userId: "u1",
          userName: "Jack",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 8 }],
        } as Partial<TimeEntry>),
        entry({
          id: "c",
          userId: "u3",
          userName: "Alfredo Rossi",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 2 }],
        } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
      ratesByUser: { u1: [rate(5000)] }, // u3 has no history → unrated
      employeeIdByUserId: { u3: "emp_3" },
    });
    expect(html).toContain("Set rate →");
    expect(html).toContain("/employees/emp_3");
    expect(html).toContain("1 worker without a rate");
    expect(html).toContain("$400"); // the rated worker is still costed
  });

  it("with hours but no rates at all the cost tile says 'no cost rates yet' — never 'no hours'", () => {
    const html = render({
      entries: [entry({ status: "approved" })],
      jobId: "job-1",
      fetchError: null,
      ratesByUser: {},
    });
    expect(html).toContain("no cost rates yet");
    expect(html).not.toContain("no hours yet");
  });

  it("lists EVERY worker — no six-worker cut", () => {
    const names = ["Ana", "Ben", "Cal", "Dee", "Eli", "Fay", "Gus"];
    const html = render({
      entries: names.map((n, i) =>
        entry({
          id: `e${i}`,
          userId: `u${i}`,
          userName: n,
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 1 + i }],
        } as Partial<TimeEntry>)
      ),
      jobId: "job-1",
      fetchError: null,
    });
    for (const n of names) expect(html).toContain(n);
  });

  it("carries an 'all days' ledger with every day, its worker, hours and status", () => {
    const html = render({
      entries: [
        entry({ id: "a", date: "2026-06-04", userId: "u1", userName: "Jack", status: "submitted" }),
        entry({
          id: "b",
          date: "2026-06-03",
          userId: "u2",
          userName: "Sam",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 7.6 }],
        } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("All days on this job");
    expect(html).toContain('data-testid="labour-days"');
    expect(html).toContain("7h 36m");
    expect(html).toContain("Submitted");
    expect(html).toContain(">Approved<");
  });

  it("filters to this job — other jobs' hours never leak in", () => {
    const html = render({
      entries: [entry({ allocations: [{ jobId: "job-OTHER", hours: 8 }] } as Partial<TimeEntry>)],
      jobId: "job-1",
      fetchError: null,
    });
    expect(html).toContain("No hours logged yet");
    expect(html).not.toContain("Awaiting approval");
  });

  it("shows an honest error note but still links the week board", () => {
    const html = render({ entries: [], jobId: "job-1", fetchError: "API returned 500" });
    expect(html).toContain("load hours for this job");
    expect(html).toContain("API returned 500");
    expect(html).toContain("/hours/weekly");
  });

  // #343 — time-overrun early-warning, surfaced honestly on the Labour card.
  it("with NO estimate (every job today) shows 'No time estimate set', never a fabricated ratio", () => {
    const html = render({
      entries: [
        entry({
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 40 }],
        } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
      estimatedHours: null,
      progressPct: 20,
    });
    expect(html).toContain("No time estimate set");
  });

  it("flags an overrun with its exact math when hours outpace progress", () => {
    const html = render({
      entries: [
        entry({
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 80 }],
        } as Partial<TimeEntry>),
      ],
      jobId: "job-1",
      fetchError: null,
      estimatedHours: 100, // 80/100 = 80% burnt
      progressPct: 30, // 30% complete → flag fires
    });
    expect(html).toContain("Hours outpacing progress");
  });
});
