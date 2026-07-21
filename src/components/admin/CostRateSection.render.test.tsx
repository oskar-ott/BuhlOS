import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CostRateSection } from "./CostRateSection";

/**
 * Server-render guards for the cost-rate drawer section (#304). The store + the
 * confidentiality gate are pinned by the API harnesses; these pin what the
 * office SEES: the admin-only heading, the honest "no account yet" / "no rate
 * yet" states, and never a fabricated zero. (renderToString skips effects, so
 * the mount fetch never fires — we see the initial state only.)
 */

describe("CostRateSection — honest initial states", () => {
  it("shows the admin-only heading and a 'finish BuhlOS setup' note when there's no worker account", () => {
    const html = renderToString(
      createElement(CostRateSection, { userId: null, workerName: "Sparky" }),
    );
    expect(html).toContain("Cost rate (admin only)");
    expect(html).toContain("finishes BuhlOS setup");
    // never a fabricated rate
    expect(html).not.toContain("$0.00");
  });

  it("shows the set-rate affordance + a loading state when a worker account exists", () => {
    const html = renderToString(
      createElement(CostRateSection, { userId: "u_field", workerName: "Sparky" }),
    );
    expect(html).toContain("Cost rate (admin only)");
    expect(html).toContain("cost-rate-add-open");
    expect(html).toContain("Loading");
  });
});
