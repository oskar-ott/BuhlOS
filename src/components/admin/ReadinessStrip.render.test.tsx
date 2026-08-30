import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ReadinessStrip } from "./ReadinessStrip";

/**
 * The pay-period readiness strip (owner redesign 2026-08-16): green when the
 * period is fully decided, amber with a way back to the weekly board while
 * workers still block it, and NOTHING at all for an empty period (no verdict
 * without weeks to judge).
 */

const render = (props: Partial<Parameters<typeof ReadinessStrip>[0]> = {}) =>
  renderToString(
    createElement(ReadinessStrip, {
      fullyClosed: true,
      workersNeedingAction: 0,
      weeksTotal: 1,
      ...props,
    }),
  ).replace(/<!-- -->/g, "");

describe("ReadinessStrip", () => {
  it("closed period → the green final-totals line", () => {
    const html = render();
    expect(html).toContain('data-testid="period-readiness-closed"');
    expect(html).toContain("totals below are final");
  });

  it("open period → amber count and the way back to This week", () => {
    const html = render({ fullyClosed: false, workersNeedingAction: 2 });
    expect(html).toContain('data-testid="period-readiness-open"');
    expect(html).toContain("2");
    expect(html).toContain("workers still have undecided days");
    expect(html).toContain('href="/hours/weekly"');
  });

  it("singular worker reads naturally", () => {
    expect(render({ fullyClosed: false, workersNeedingAction: 1 })).toContain(
      "worker still has undecided days",
    );
  });

  it("no weeks → no verdict at all", () => {
    expect(render({ weeksTotal: 0 })).toBe("");
  });
});
