import { describe, expect, it } from "vitest";
import {
  defineKpi,
  evaluateKpi,
  KpiRegistry,
  createKpiRegistry,
  hoursThisWeekKpi,
} from "./kpi-engine";

const ASOF = "2026-06-22T00:00:00.000Z";

describe("defineKpi / evaluateKpi envelope", () => {
  const sum = defineKpi<number[]>({
    id: "test.sum",
    label: "Sum",
    unit: "count",
    definitionVersion: 1,
    describe: "Sum of the inputs.",
    compute: (xs) => xs.reduce((a, b) => a + b, 0),
  });

  it("stamps a KpiValue from the definition + input", () => {
    expect(evaluateKpi(sum, [1, 2, 3], ASOF)).toEqual({
      id: "test.sum",
      label: "Sum",
      value: 6,
      unit: "count",
      asOf: ASOF,
      definitionVersion: 1,
    });
  });

  it("throws on a non-finite result (a definition bug never ships NaN)", () => {
    const bad = defineKpi<number>({ id: "bad", label: "Bad", unit: "x", definitionVersion: 1, describe: "", compute: (n) => n / 0 });
    expect(() => evaluateKpi(bad, 0, ASOF)).toThrow();
  });
});

describe("KpiRegistry — one definition per id", () => {
  it("register/get/has/ids/list and evaluate by id", () => {
    const r = new KpiRegistry().register(hoursThisWeekKpi);
    expect(r.has("hours.week.total")).toBe(true);
    expect(r.ids()).toEqual(["hours.week.total"]);
    expect(r.get("hours.week.total")?.label).toBe("Hours this week");
    expect(r.list()).toHaveLength(1);
  });

  it("refuses a duplicate id (one definition per number)", () => {
    const r = new KpiRegistry().register(hoursThisWeekKpi);
    expect(() => r.register(hoursThisWeekKpi)).toThrow(/already defined/);
  });

  it("throws evaluating an unknown id", () => {
    expect(() => new KpiRegistry().evaluate("nope", {}, ASOF)).toThrow(/unknown KPI/);
  });
});

describe("hoursThisWeekKpi (built on the canonical week)", () => {
  const entries = [
    { date: "2026-06-22", hours: 8 }, // Mon — in week
    { date: "2026-06-28", hours: 4.5 }, // Sun — in week
    { date: "2026-06-21", hours: 9 }, // prev Sun — OUT
    { date: "2026-06-29", hours: 7 }, // next Mon — OUT
  ];
  it("sums only entries in the Mon–Sun week containing localToday", () => {
    const r = createKpiRegistry();
    const v = r.evaluate("hours.week.total", { entries, localToday: "2026-06-24" }, ASOF);
    expect(v.value).toBe(12.5);
    expect(v.unit).toBe("h");
  });
  it("empty / no in-week entries → 0", () => {
    expect(hoursThisWeekKpi.compute({ entries: [], localToday: "2026-06-24" })).toBe(0);
  });
});
