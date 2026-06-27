import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { dollarsToCents, formatCents } from "./schema";

/**
 * #304 — confidential cost-rate store helpers. Pure: effective-dating (a past
 * week is costed at the rate effective THEN), append-only history, input
 * validation, and coverage over hours-tracked workers.
 */
const requireFromHere = createRequire(import.meta.url);
const store = requireFromHere("../../../api/_lib/cost-rates.js") as {
  historyFor: (data: unknown, userId: string) => Array<Record<string, unknown>>;
  effectiveCostRate: (history: unknown[], date: string) => Record<string, unknown> | null;
  validateRateInput: (body: unknown) => { ok: boolean; value?: unknown; error?: string };
  appendRate: (data: unknown, userId: string, value: unknown, actor: unknown) => { rates: Record<string, unknown[]> };
  costRateCoverage: (
    users: unknown[],
    data: unknown,
  ) => { tracked: number; rated: number; unrated: Array<{ id: string }> };
};

const ACTOR = { id: "u_admin", username: "Daniel", role: "admin" };

describe("effectiveCostRate — the rate effective on a given date", () => {
  const history = [
    { id: "a", costRateCents: 5000, chargeOutRateCents: null, effectiveFrom: "2026-01-01" },
    { id: "b", costRateCents: 5500, chargeOutRateCents: 9500, effectiveFrom: "2026-06-01" },
  ];

  it("uses the rate effective THAT week, not today's (mid-history change)", () => {
    expect(store.effectiveCostRate(history, "2026-03-15")?.costRateCents).toBe(5000);
    expect(store.effectiveCostRate(history, "2026-06-01")?.costRateCents).toBe(5500); // boundary inclusive
    expect(store.effectiveCostRate(history, "2026-09-01")?.costRateCents).toBe(5500);
  });

  it("returns null before the worker had any rate", () => {
    expect(store.effectiveCostRate(history, "2025-12-31")).toBeNull();
    expect(store.effectiveCostRate([], "2026-03-15")).toBeNull();
  });
});

describe("historyFor — sorted oldest → newest, tolerant of missing", () => {
  it("sorts by effectiveFrom ascending", () => {
    const data = {
      rates: {
        u1: [
          { id: "b", effectiveFrom: "2026-06-01", costRateCents: 5500 },
          { id: "a", effectiveFrom: "2026-01-01", costRateCents: 5000 },
        ],
      },
    };
    expect(store.historyFor(data, "u1").map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns [] for an unknown worker or malformed store", () => {
    expect(store.historyFor({ rates: {} }, "nope")).toEqual([]);
    expect(store.historyFor(null, "u1")).toEqual([]);
  });
});

describe("validateRateInput — positive integer cents + a real effective date", () => {
  it("accepts a valid rate", () => {
    const r = store.validateRateInput({ costRateCents: 5250, effectiveFrom: "2026-06-01" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ costRateCents: 5250, chargeOutRateCents: null, effectiveFrom: "2026-06-01" });
  });

  it("rejects non-integer / non-positive cost rates", () => {
    expect(store.validateRateInput({ costRateCents: 52.5, effectiveFrom: "2026-06-01" }).ok).toBe(false);
    expect(store.validateRateInput({ costRateCents: 0, effectiveFrom: "2026-06-01" }).ok).toBe(false);
    expect(store.validateRateInput({ costRateCents: -100, effectiveFrom: "2026-06-01" }).ok).toBe(false);
  });

  it("rejects a bad effective date", () => {
    expect(store.validateRateInput({ costRateCents: 5000, effectiveFrom: "June" }).ok).toBe(false);
    expect(store.validateRateInput({ costRateCents: 5000 }).ok).toBe(false);
  });

  it("accepts an optional charge-out rate but rejects an invalid one", () => {
    expect(store.validateRateInput({ costRateCents: 5000, chargeOutRateCents: 9500, effectiveFrom: "2026-06-01" }).ok).toBe(true);
    expect(store.validateRateInput({ costRateCents: 5000, chargeOutRateCents: -1, effectiveFrom: "2026-06-01" }).ok).toBe(false);
  });
});

describe("appendRate — append-only history with editor + timestamp", () => {
  it("appends without overwriting and records who/when", () => {
    const v1 = store.appendRate({ rates: {} }, "u1", { costRateCents: 5000, chargeOutRateCents: null, effectiveFrom: "2026-01-01" }, ACTOR);
    const v2 = store.appendRate(v1, "u1", { costRateCents: 5500, chargeOutRateCents: null, effectiveFrom: "2026-06-01" }, ACTOR);
    const u1 = (v2.rates.u1 ?? []) as Array<Record<string, unknown>>;
    expect(u1).toHaveLength(2);
    const last = u1[1] as Record<string, unknown>;
    expect(last.costRateCents).toBe(5500);
    expect(last.setBy).toBe("u_admin");
    expect(last.setByName).toBe("Daniel");
    expect(typeof last.setAt).toBe("string");
    expect(typeof last.id).toBe("string");
    // original input not mutated
    expect((v1.rates.u1 ?? []).length).toBe(1);
  });
});

describe("costRateCoverage — hours-tracked workers without a rate", () => {
  const users = [
    { id: "u_field", username: "Sparky", role: "electrician", assignedJobIds: [] },
    { id: "u_lh", username: "Lead", role: "leadingHand", assignedJobIds: [] },
    { id: "u_admin", username: "Boss", role: "admin", assignedJobIds: [] }, // not hours-tracked
  ];

  it("counts only hours-tracked workers and lists the unrated", () => {
    const data = { rates: { u_field: [{ id: "x", effectiveFrom: "2026-01-01", costRateCents: 5000 }] } };
    const cov = store.costRateCoverage(users, data);
    expect(cov.tracked).toBe(2); // field + LH, not admin
    expect(cov.rated).toBe(1);
    expect(cov.unrated.map((u) => u.id)).toEqual(["u_lh"]);
  });
});

describe("dollarsToCents / formatCents — UI money conversion", () => {
  it("parses dollars to integer cents", () => {
    expect(dollarsToCents("52.50")).toBe(5250);
    expect(dollarsToCents("52")).toBe(5200);
    expect(dollarsToCents("$95.00")).toBe(9500);
    expect(dollarsToCents("0")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents("52.555")).toBeNull(); // > 2dp
  });

  it("formats cents to dollars", () => {
    expect(formatCents(5250)).toBe("$52.50");
    expect(formatCents(null)).toBe("—");
  });
});
