import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Pure-function tests for api/_lib/tag-compliance.js (#305) — the SINGLE
 * computation behind GET /api/tags-expiring, the daily reminder cron and the
 * admin /gear compliance board. Everything here runs with a FIXED `now` so
 * window math is deterministic.
 *
 * The dedupe contract (newCrossings) is the heart of "no spam by design":
 *   - first sighting inside a band → alert
 *   - same band on later runs → silent
 *   - moving t14 → t7 → expired → one alert per band crossing
 *   - retested (leaves the window) → state pruned, lifecycle resets
 */

const requireFromHere = createRequire(import.meta.url);
const lib = requireFromHere("../../../api/_lib/tag-compliance.js") as {
  parseDdmmyyyy: (s: string) => number;
  toIsoDay: (ms: number) => string;
  expiringTagRows: (
    jobs: unknown[],
    tagsByJobId: Record<string, unknown[]>,
    opts?: { withinDays?: number; now?: Date },
  ) => Array<Record<string, unknown> & { key: string; daysToExpiry: number; status: string }>;
  expiringCalibrationRows: (
    assets: unknown[],
    opts?: { withinDays?: number; now?: Date; nameById?: Record<string, string> },
  ) => Array<Record<string, unknown> & { key: string; daysToExpiry: number; status: string }>;
  thresholdFor: (days: number) => string | null;
  newCrossings: (
    rows: Array<{ key: string; daysToExpiry: number }>,
    state: Record<string, { threshold: string; notifiedAt: string | null }>,
    now?: number,
  ) => {
    crossed: Array<{ key: string; threshold: string }>;
    nextState: Record<string, { threshold: string; notifiedAt: string | null }>;
  };
};

// Fixed clock: Friday 2026-06-12 (local midnight maths inside the lib).
const NOW = new Date(2026, 5, 12, 10, 30);

function tag(id: string, expiryDate: string, extra: Record<string, unknown> = {}) {
  return { id, tagNumber: `T-${id}`, applianceType: "Drill", owner: "Sam", result: "pass", expiryDate, ...extra };
}

describe("parseDdmmyyyy", () => {
  it("parses dd/mm/yyyy as local midnight", () => {
    expect(lib.parseDdmmyyyy("12/06/2026")).toBe(new Date(2026, 5, 12).getTime());
  });
  it("accepts ISO yyyy-mm-dd as a fallback", () => {
    expect(lib.parseDdmmyyyy("2026-06-12")).toBe(new Date(2026, 5, 12).getTime());
  });
  it("returns NaN for garbage / empty", () => {
    expect(Number.isNaN(lib.parseDdmmyyyy(""))).toBe(true);
    expect(Number.isNaN(lib.parseDdmmyyyy("soon"))).toBe(true);
    expect(Number.isNaN(lib.parseDdmmyyyy("12-06-2026"))).toBe(true);
  });
});

describe("expiringTagRows", () => {
  const jobs = [
    { id: "j1", name: "Riverside Apartments" },
    { id: "j2", name: "Depot Fitout" },
  ];

  it("keeps expired + in-window tags, drops far-future and unparseable", () => {
    const rows = lib.expiringTagRows(
      jobs,
      {
        j1: [tag("t_exp", "10/06/2026"), tag("t_soon", "20/06/2026"), tag("t_far", "01/12/2026")],
        j2: [tag("t_bad", "not-a-date")],
      },
      { withinDays: 14, now: NOW },
    );
    expect(rows.map((r) => r.id)).toEqual(["t_exp", "t_soon"]);
    expect(rows[0]).toMatchObject({
      kind: "tag",
      key: "tag:j1:t_exp",
      jobId: "j1",
      jobName: "Riverside Apartments",
      status: "expired",
      daysToExpiry: -2,
      expiryISO: "2026-06-10",
    });
    expect(rows[1]).toMatchObject({ status: "expiring", daysToExpiry: 8 });
  });

  it("sorts expired-first (oldest first), then earliest upcoming", () => {
    const rows = lib.expiringTagRows(
      jobs,
      {
        j1: [tag("a", "20/06/2026"), tag("b", "01/06/2026")],
        j2: [tag("c", "11/06/2026"), tag("d", "13/06/2026")],
      },
      { withinDays: 14, now: NOW },
    );
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("keeps the legacy response fields — raw id, ''-defaulted strings, result", () => {
    const rows = lib.expiringTagRows(
      [{ id: "j1", name: "Riverside" }],
      { j1: [{ id: "t1", expiryDate: "10/06/2026" }] },
      { withinDays: 14, now: NOW },
    );
    expect(rows[0]).toMatchObject({
      id: "t1",
      tagNumber: "",
      applianceType: "",
      owner: "",
      result: "",
    });
  });

  it("a tag expiring exactly today counts as expiring (daysToExpiry 0), not expired", () => {
    const rows = lib.expiringTagRows(
      [{ id: "j1", name: "J" }],
      { j1: [tag("t0", "12/06/2026")] },
      { withinDays: 14, now: NOW },
    );
    expect(rows[0]).toMatchObject({ daysToExpiry: 0, status: "expiring" });
  });
});

describe("expiringCalibrationRows", () => {
  const assets = [
    { id: "a1", name: "Fluke 1587", identifier: "FLK-01", currentHolderId: "u1", calibrationDue: "2026-06-08" },
    { id: "a2", name: "Megger", currentHolderId: null, calibrationDue: "2026-06-20" },
    { id: "a3", name: "No cal", currentHolderId: "u1" },
    { id: "a4", name: "Archived", archived: true, calibrationDue: "2026-06-01" },
    { id: "a5", name: "Far future", calibrationDue: "2026-12-01" },
  ];

  it("skips archived, missing-calibrationDue and far-future assets", () => {
    const rows = lib.expiringCalibrationRows(assets, { withinDays: 14, now: NOW });
    expect(rows.map((r) => r.assetId)).toEqual(["a1", "a2"]);
    expect(rows[0]).toMatchObject({
      kind: "calibration",
      key: "cal:a1",
      status: "expired",
      daysToExpiry: -4,
    });
    expect(rows[1]).toMatchObject({ status: "expiring", daysToExpiry: 8 });
  });

  it("joins holderName from nameById (records do not store names)", () => {
    const rows = lib.expiringCalibrationRows(assets, {
      withinDays: 14,
      now: NOW,
      nameById: { u1: "sparky" },
    });
    expect(rows[0]).toMatchObject({ holderId: "u1", holderName: "sparky" });
    expect(rows[1]).toMatchObject({ holderId: null, holderName: null });
  });
});

describe("thresholdFor — alert bands", () => {
  it("maps signed daysToExpiry to expired / t7 / t14 / null", () => {
    expect(lib.thresholdFor(-1)).toBe("expired");
    expect(lib.thresholdFor(0)).toBe("t7");
    expect(lib.thresholdFor(7)).toBe("t7");
    expect(lib.thresholdFor(8)).toBe("t14");
    expect(lib.thresholdFor(14)).toBe("t14");
    expect(lib.thresholdFor(15)).toBeNull();
  });
});

describe("newCrossings — the no-spam dedupe", () => {
  const row = (key: string, daysToExpiry: number) => ({ key, daysToExpiry });

  it("first sighting in a band alerts and records the band", () => {
    const { crossed, nextState } = lib.newCrossings([row("k1", 10)], {});
    expect(crossed).toHaveLength(1);
    expect(crossed[0]).toMatchObject({ key: "k1", threshold: "t14" });
    expect(nextState.k1!.threshold).toBe("t14");
    expect(nextState.k1!.notifiedAt).toBeTruthy();
  });

  it("same band on the next run is SILENT (state carried forward)", () => {
    const run1 = lib.newCrossings([row("k1", 10)], {});
    const run2 = lib.newCrossings([row("k1", 9)], run1.nextState);
    expect(run2.crossed).toHaveLength(0);
    expect(run2.nextState.k1!.threshold).toBe("t14");
    expect(run2.nextState.k1!.notifiedAt).toBe(run1.nextState.k1!.notifiedAt);
  });

  it("moving into a deeper band re-alerts: t14 → t7 → expired = 3 alerts total", () => {
    const r1 = lib.newCrossings([row("k1", 10)], {});
    const r2 = lib.newCrossings([row("k1", 5)], r1.nextState);
    const r3 = lib.newCrossings([row("k1", -1)], r2.nextState);
    expect(r1.crossed.map((c) => c.threshold)).toEqual(["t14"]);
    expect(r2.crossed.map((c) => c.threshold)).toEqual(["t7"]);
    expect(r3.crossed.map((c) => c.threshold)).toEqual(["expired"]);
  });

  it("a row that leaves the window (retested) is pruned and re-alerts next lapse", () => {
    const r1 = lib.newCrossings([row("k1", 5)], {});
    // retested → no longer in the computed rows at all
    const r2 = lib.newCrossings([], r1.nextState);
    expect(r2.nextState).toEqual({});
    // a year later it drifts into the window again → fresh alert
    const r3 = lib.newCrossings([row("k1", 14)], r2.nextState);
    expect(r3.crossed).toHaveLength(1);
  });

  it("rows above every band do not enter state", () => {
    const { crossed, nextState } = lib.newCrossings([row("k1", 30)], {});
    expect(crossed).toHaveLength(0);
    expect(nextState).toEqual({});
  });
});
