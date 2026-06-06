import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobMaterialsPanel } from "./JobMaterialsPanel";

/**
 * The Materials panel is an honest under-construction stub. These guard the
 * two things that must stay true for a field surface: no fabricated data, and
 * no link that drops a worker onto an admin-only route they can't open.
 */
describe("JobMaterialsPanel", () => {
  it("is an honest under-construction stub (no fake stock counts)", () => {
    const html = renderToString(createElement(JobMaterialsPanel));
    expect(html).toContain("Materials");
    expect(html).toContain("Under construction");
    expect(html).toContain("UC");
  });

  it("never links a field worker to an admin route", () => {
    const html = renderToString(createElement(JobMaterialsPanel));
    expect(html).not.toContain("/admin");
    // the leak was the only anchor in this panel — there should be no link now
    expect(html).not.toContain("<a ");
  });

  it("points the worker to a real, field-safe next step (their PM)", () => {
    const html = renderToString(createElement(JobMaterialsPanel));
    expect(html).toContain("PM");
  });
});
