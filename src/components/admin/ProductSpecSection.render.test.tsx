import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ProductSpecSection } from "./ProductSpecSection";

/**
 * SSR smoke for the "Spec & circuits" product-spec editor (Job Builder
 * redesign · Wave 3). renderToString draws the initial state — effects don't
 * run server-side, so the GET never fires and the panel shows its honest
 * loading state. The save/validation behaviour is pinned by the API tests
 * (src/domains/job-spec/job-spec-api.test.ts).
 */
describe("ProductSpecSection (Job Builder redesign · Wave 3)", () => {
  it("renders the spec framing, loading state, and the circuits link-out", () => {
    const html = renderToString(createElement(ProductSpecSection, { jobId: "j1" }));
    expect(html).toContain("Product spec");
    // supplier semantics stated up front
    expect(html).toContain("Blank");
    expect(html).toContain("we supply");
    // initial state before the client-side fetch resolves
    expect(html).toContain("Loading product spec");
    // the Power half reuses the shipped circuit schedule — link-out, no duplicate
    expect(html).toContain("circuits &amp; board schedule");
    expect(html).toContain("Open circuit schedule");
  });
});
