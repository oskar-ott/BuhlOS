import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #349 — job closeout snapshot builder. Pure: composes profitability + duration
 * + snag lifecycle into a frozen report card, naming missing inputs (never
 * zero-filling). CJS (the serverless handler requires it).
 */
const requireFromHere = createRequire(import.meta.url);
const { buildCloseoutSnapshot, snagLifecycleStats, daysBetween } = requireFromHere(
  "../../../api/_lib/job-closeout.js",
) as {
  buildCloseoutSnapshot: (input: Record<string, unknown>) => {
    revenue: { contractValueCents: number | null; claimedToDateCents: number | null };
    labour: { costCents: number; varianceCents: number | null; estimateCents: number | null };
    margin: { cents: number | null };
    duration: { plannedDays: number | null; actualDays: number | null };
    snags: { openNow: number };
    backfilled: boolean;
    badges: string[];
  };
  snagLifecycleStats: (snags: unknown[]) => { opened: number; closed: number; openNow: number; meanDaysToClose: number | null };
  daysBetween: (a: string | null, b: string | null) => number | null;
};

const META = { closedBy: "u_admin", closedByName: "Boss", closedAt: "2026-06-30T00:00:00.000Z", backfilled: false, version: 1, fromStatus: "active" };

describe("buildCloseoutSnapshot — frozen final numbers + honesty", () => {
  it("freezes revenue / labour / material / margin and the duration", () => {
    const snap = buildCloseoutSnapshot({
      contractValueCents: 12_000_000,
      claimedToDateCents: 5_000_000,
      labourCostCents: 4_000_000,
      unratedWorkers: [],
      hoursTotal: 760,
      labourEstimateCents: 4_000_000,
      materialCostCents: 3_000_000,
      materialSource: "received_proxy",
      duration: { startDate: "2026-01-01", dueDate: "2026-03-01", programmedDurationDays: null, firstActivity: "2026-01-03", lastActivity: "2026-03-10" },
      snags: { opened: 5, closed: 4, openNow: 1, meanDaysToClose: 6.5 },
      meta: META,
    });
    expect(snap.revenue.contractValueCents).toBe(12_000_000);
    expect(snap.revenue.claimedToDateCents).toBe(5_000_000);
    expect(snap.labour.costCents).toBe(4_000_000);
    expect(snap.labour.varianceCents).toBe(0); // cost == estimate
    expect(snap.margin.cents).toBe(12_000_000 - 4_000_000 - 3_000_000);
    expect(snap.duration.plannedDays).toBe(daysBetween("2026-01-01", "2026-03-01"));
    expect(snap.duration.actualDays).toBe(daysBetween("2026-01-03", "2026-03-10"));
    expect(snap.snags.openNow).toBe(1);
    expect(snap.badges).toContain("1 snag still open");
  });

  it("names missing inputs instead of zero-filling them", () => {
    const snap = buildCloseoutSnapshot({
      contractValueCents: null,
      claimedToDateCents: null,
      labourCostCents: 100_000,
      unratedWorkers: ["Mate"],
      hoursTotal: 20,
      labourEstimateCents: null,
      materialCostCents: null,
      materialSource: "none",
      duration: {},
      snags: { opened: 0, closed: 0, openNow: 0, meanDaysToClose: null },
      meta: META,
    });
    expect(snap.margin.cents).toBeNull();
    expect(snap.labour.estimateCents).toBeNull();
    expect(snap.duration.plannedDays).toBeNull();
    expect(snap.badges).toEqual(expect.arrayContaining([
      "no contract value set",
      "no labour estimate set",
      "no planned duration",
      "1 worker unrated",
    ]));
  });

  it("marks a backfilled closeout", () => {
    const snap = buildCloseoutSnapshot({
      contractValueCents: 100_000, labourCostCents: 0, unratedWorkers: [], hoursTotal: 0,
      labourEstimateCents: null, materialCostCents: null, materialSource: "none",
      duration: {}, snags: { opened: 0, closed: 0, openNow: 0, meanDaysToClose: null },
      meta: { ...META, backfilled: true, fromStatus: "archived" },
    });
    expect(snap.backfilled).toBe(true);
    expect(snap.badges).toContain("backfilled closeout");
  });
});

describe("snagLifecycleStats — defensive over legacy + v2 vocab", () => {
  it("counts opened / closed / openNow and excludes rejected", () => {
    const stats = snagLifecycleStats([
      { status: "Open", createdAt: "2026-01-01" },         // legacy open
      { status: "open" },                                   // v2 open
      { status: "in_progress" },
      { status: "closed", createdAt: "2026-01-01", updatedAt: "2026-01-08" }, // 7d
      { status: "verified", createdAt: "2026-01-01", closedAt: "2026-01-06" }, // 5d
      { status: "rejected" },                               // dismissed — excluded
    ]);
    expect(stats.opened).toBe(5); // 6 minus the rejected
    expect(stats.closed).toBe(2);
    expect(stats.openNow).toBe(3);
    expect(stats.meanDaysToClose).toBe(6); // mean(7,5)
  });

  it("returns null mean when no closed snag carries usable timestamps", () => {
    const stats = snagLifecycleStats([{ status: "closed" }, { status: "open" }]);
    expect(stats.closed).toBe(1);
    expect(stats.meanDaysToClose).toBeNull();
  });
});
