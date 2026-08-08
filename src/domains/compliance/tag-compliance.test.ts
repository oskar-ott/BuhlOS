import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Pure-function tests for api/_lib/tag-compliance.js (#305) — the SINGLE
 * computation behind GET /api/tags-expiring, the daily reminder cron and the
 * admin /gear compliance board. Everything here runs with a FIXED `now` so
 * window math is deterministic. (The per-job tag-row scan and its tests left
 * with the Test & Tag teardown — the job-page rebuild; calibrations remain.)
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
