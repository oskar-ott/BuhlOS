import { describe, it, expect } from "vitest";
import { suggestTasksFromFittings } from "./tasks-from-fittings";

describe("suggestTasksFromFittings", () => {
  it("aggregates GPO labels into rough-in + fit-off power tasks with the real count", () => {
    const out = suggestTasksFromFittings([
      { label: "Double GPO", count: 12 },
      { label: "single gpo", count: 4 },
    ]);
    const rough = out.roughIn.find((t) => /power/i.test(t.name));
    const fit = out.fitOff.find((t) => /GPO/.test(t.name));
    expect(rough?.quantity).toBe(16);
    expect(fit?.name).toContain("16");
    expect(fit?.sourceLabels).toEqual(["Double GPO", "single gpo"]);
  });

  it("keeps switchboard distinct from light switches", () => {
    const out = suggestTasksFromFittings([
      { label: "Switchboard", count: 1 },
      { label: "2-gang switch", count: 5 },
    ]);
    expect(out.roughIn.some((t) => /Switchboard rough-in/.test(t.name))).toBe(true);
    expect(out.fitOff.some((t) => /Terminate & label switchboard/.test(t.name))).toBe(true);
    expect(out.fitOff.some((t) => /Fit off 5 switches/.test(t.name))).toBe(true);
  });

  it("routes 'data outlet' to data, not power (no bare-outlet mis-match)", () => {
    const out = suggestTasksFromFittings([{ label: "Data outlet", count: 6 }]);
    expect(out.fitOff.map((t) => t.name)).toContain("Terminate 6 data outlets");
    expect(out.roughIn.map((t) => t.name)).toContain("Rough-in data — 6 outlets");
    expect(out.fitOff.some((t) => /GPO/.test(t.name))).toBe(false);
  });

  it("reports unrecognised fittings honestly instead of inventing tasks (P7)", () => {
    const out = suggestTasksFromFittings([{ label: "Mystery symbol", count: 3 }]);
    expect(out.roughIn).toHaveLength(0);
    expect(out.fitOff).toHaveLength(0);
    expect(out.unmatched).toEqual([{ label: "Mystery symbol", count: 3 }]);
  });

  it("ignores zero/negative counts and blank labels", () => {
    const out = suggestTasksFromFittings([
      { label: "GPO", count: 0 },
      { label: "", count: 5 },
      { label: "Downlight", count: -2 },
    ]);
    expect(out.roughIn).toHaveLength(0);
    expect(out.fitOff).toHaveLength(0);
    expect(out.unmatched).toHaveLength(0);
  });

  it("singularises names for a count of one", () => {
    const out = suggestTasksFromFittings([{ label: "downlight", count: 1 }]);
    expect(out.fitOff[0]!.name).toBe("Install 1 light");
  });

  it("maps smoke + exhaust to their fit-off tasks", () => {
    const out = suggestTasksFromFittings([
      { label: "Smoke detector", count: 2 },
      { label: "Exhaust fan", count: 3 },
    ]);
    expect(out.fitOff.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Install 2 smoke alarms", "Install 3 exhaust fans"]),
    );
  });
});
