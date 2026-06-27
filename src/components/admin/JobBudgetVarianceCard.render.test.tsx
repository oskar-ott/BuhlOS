import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobBudgetVarianceCard } from "./JobBudgetVarianceCard";

/**
 * #341 — the budget-variance card's initial render (renderToString skips the
 * mount fetch). The variance maths are pinned by the pure/API harnesses; this
 * guards the card mounts with its title + loading state.
 */
describe("JobBudgetVarianceCard — initial render", () => {
  it("renders the budget-vs-actual title and a loading state", () => {
    const html = renderToString(createElement(JobBudgetVarianceCard, { jobId: "job-a" }));
    expect(html).toContain("Budget vs actual");
    expect(html).toContain("Loading");
  });
});
