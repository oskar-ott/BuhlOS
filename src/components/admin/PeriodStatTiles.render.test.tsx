import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PeriodStatTiles } from "./PeriodStatTiles";

/**
 * The pay-period stat tiles (owner redesign 2026-08-16): four headline
 * numbers, amber "hot" styling only where a look is deserved — overtime that
 * exists, or approved hours not yet in a payroll run.
 */

const base = { approvedHours: 76, ordinaryHours: 72, overtimeHours: 4, unexportedApprovedHours: 76 };

const render = (summary: Partial<typeof base> = {}) =>
  renderToString(createElement(PeriodStatTiles, { summary: { ...base, ...summary } })).replace(
    /<!-- -->/g,
    "",
  );

describe("PeriodStatTiles", () => {
  it("shows the four tiles with their labels and hour values", () => {
    const html = render();
    for (const label of ["Approved hours", "Ordinary", "Overtime", "Not in a run yet"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("76h");
    expect(html).toContain("72h");
    expect(html).toContain("4h");
  });

  it("overtime and not-in-a-run tiles run hot only when non-zero", () => {
    expect(render().match(/bg-amber-50/g)?.length).toBe(2);
    expect(render({ overtimeHours: 0, unexportedApprovedHours: 0 })).not.toContain("bg-amber-50");
  });
});
