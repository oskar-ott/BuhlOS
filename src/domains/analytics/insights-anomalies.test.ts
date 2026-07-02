import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #347 — the deterministic anomaly rules (api/_lib/insights-anomalies.js).
 * Pure module on fixtures: each rule fires exactly at its documented
 * threshold, quiet weeks produce zero findings, and the deterministic
 * rendering (the grounding basis + no-model fallback) carries text + link
 * per finding.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = requireFromHere("../../../api/_lib/insights-anomalies.js");

// A Wednesday; its Monday is 2026-06-29, last week starts 2026-06-22.
const TODAY = "2026-07-01";

const entry = (over: Record<string, unknown> = {}) => ({
  id: "te1",
  userId: "u1",
  date: "2026-06-30",
  status: "approved",
  allocations: [{ jobId: "j1", hours: 8 }],
  ...over,
});

const snag = (over: Record<string, unknown> = {}) => ({
  id: "sn1",
  jobId: "j1",
  jobName: "Riverside",
  status: "open",
  priority: "normal",
  createdAt: "2026-06-28T00:00:00.000Z",
  ...over,
});

describe("weekStartOf", () => {
  it("returns the Monday of the containing week", () => {
    expect(mod.weekStartOf("2026-07-01")).toBe("2026-06-29"); // Wed → Mon
    expect(mod.weekStartOf("2026-06-29")).toBe("2026-06-29"); // Mon → itself
    expect(mod.weekStartOf("2026-07-05")).toBe("2026-06-29"); // Sun → prior Mon
  });
});

describe("collectAnomalies — quiet week", () => {
  it("no records → no findings (quiet weeks send nothing, invent nothing)", () => {
    const r = mod.collectAnomalies({ today: TODAY, entries: [], snags: [] });
    expect(r.weekStart).toBe("2026-06-29");
    expect(r.findings).toEqual([]);
  });

  it("ordinary activity below every threshold → no findings", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [
        entry({ date: "2026-06-30", status: "approved" }), // this week 8h
        entry({ id: "te2", date: "2026-06-23", status: "approved" }), // last week 8h
        // pending 1 day only, tiny hours — keeps this week's total inside the
        // ±30% band so no rule trips
        entry({ id: "te3", date: "2026-06-30", status: "submitted", allocations: [{ jobId: "j1", hours: 1 }] }),
      ],
      snags: [snag({ createdAt: "2026-06-28T00:00:00.000Z" })], // 3 days old, not urgent
    });
    expect(r.findings).toEqual([]);
  });
});

describe("rule A — approvals waiting", () => {
  it("fires at the 3-day floor, escalates to red at 7 days", () => {
    const amber = mod.collectAnomalies({
      today: TODAY,
      entries: [entry({ status: "submitted", date: "2026-06-28" })],
      snags: [],
    });
    const f = amber.findings.find((x: { key: string }) => x.key === "hours.approvals_waiting");
    expect(f).toMatchObject({ severity: "amber", facts: { count: 1, oldestDays: 3 } });
    expect(f.href).toBe("/hours/approvals");
    expect(f.sources[0].store).toBe("users/u1/time-entries/2026-06-28.json");

    const red = mod.collectAnomalies({
      today: TODAY,
      entries: [entry({ status: "submitted", date: "2026-06-24" })],
      snags: [],
    });
    expect(red.findings[0].severity).toBe("red");
  });

  it("stays quiet below the floor", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [entry({ status: "submitted", date: "2026-06-29" })],
      snags: [],
    });
    expect(r.findings.filter((x: { kind: string }) => x.kind === "approvals_waiting")).toEqual([]);
  });
});

describe("rule B — hours week-over-week", () => {
  it("fires on a ≥30% and ≥5h swing, with real numbers in the facts", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [
        entry({ date: "2026-06-30", allocations: [{ jobId: "j1", hours: 18 }] }), // this week
        entry({ id: "te2", date: "2026-06-23", allocations: [{ jobId: "j1", hours: 6 }] }), // last week
      ],
      snags: [],
    });
    const f = r.findings.find((x: { key: string }) => x.key === "hours.week_over_week");
    expect(f.facts).toMatchObject({ thisWeek: 18, lastWeek: 6, pctRounded: 200, direction: "up" });
    expect(f.text).toContain("18h");
    expect(f.text).toContain("6h");
  });

  it("last week zero → the pct-null honesty case, phrased as first hours (≥8h)", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [entry({ date: "2026-06-30", allocations: [{ jobId: "j1", hours: 9 }] })],
      snags: [],
    });
    const f = r.findings.find((x: { key: string }) => x.key === "hours.first_hours_week");
    expect(f.facts.pct).toBeNull();
    expect(f.text).not.toContain("%");
  });

  it("small swings stay quiet (5h floor)", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [
        entry({ date: "2026-06-30", allocations: [{ jobId: "j1", hours: 4 }] }),
        entry({ id: "te2", date: "2026-06-23", allocations: [{ jobId: "j1", hours: 2 }] }),
      ],
      snags: [],
    });
    expect(r.findings.filter((x: { kind: string }) => x.kind === "hours_wow")).toEqual([]);
  });
});

describe("rule C — snags ageing", () => {
  it("fires when the oldest open snag passes 14 days", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [],
      snags: [snag({ createdAt: "2026-06-15T00:00:00.000Z" }), snag({ id: "sn2", status: "closed" })],
    });
    const f = r.findings.find((x: { key: string }) => x.key === "snags.open_ageing");
    expect(f).toMatchObject({ severity: "amber", facts: { openCount: 1, oldestDays: 16 } });
    expect(f.href).toBe("/defects");
  });

  it("any urgent open snag fires red regardless of age", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [],
      snags: [snag({ priority: "urgent", createdAt: "2026-06-30T00:00:00.000Z" })],
    });
    expect(r.findings[0]).toMatchObject({ severity: "red", facts: { urgentCount: 1 } });
  });

  it("closed snags never count", () => {
    const r = mod.collectAnomalies({
      today: TODAY,
      entries: [],
      snags: [snag({ status: "closed", createdAt: "2026-01-01T00:00:00.000Z" })],
    });
    expect(r.findings).toEqual([]);
  });
});

describe("renderDeterministic", () => {
  it("one bullet per finding with text, href and the finding key", () => {
    const { findings } = mod.collectAnomalies({
      today: TODAY,
      entries: [entry({ status: "submitted", date: "2026-06-24" })],
      snags: [snag({ priority: "urgent" })],
    });
    const bullets = mod.renderDeterministic(findings);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(bullets).toHaveLength(findings.length);
    for (const [i, b] of bullets.entries()) {
      expect(b.text).toBe(findings[i].text);
      expect(b.href).toBe(findings[i].href);
      expect(b.findingKey).toBe(findings[i].key);
    }
  });
});

describe("coverage honesty", () => {
  it("names what the digest does and does not see", () => {
    expect(mod.COVERAGE.sees.length).toBeGreaterThan(0);
    expect(mod.COVERAGE.doesNotSee.length).toBeGreaterThan(0);
    expect(mod.COVERAGE.doesNotSee.join(" ")).toMatch(/materials/i);
  });
});
