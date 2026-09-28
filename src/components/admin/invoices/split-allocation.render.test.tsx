import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SplitAllocationRequired } from "./InvoiceReviewClient";
import { CONFIRM_BLOCKER_LABELS, EVENT_LABELS, confirmBlockerLabel } from "@/domains/invoices/format";

/**
 * Task E (2026-09-27): what the office sees on a document that prints several
 * job references — rendered on its own (pure props) so the contract holds
 * without a mount fetch: the references are named, the limitation is stated,
 * and exactly the three honest ways forward are offered.
 */
describe("SplitAllocationRequired — render contract", () => {
  it("names the references, says BuhlOS cannot split, and offers the three ways forward", () => {
    const html = renderToString(createElement(SplitAllocationRequired, { references: ["IV0041", "IV0042"] }));
    expect(html).toContain("Split allocation required");
    expect(html).toContain("IV0041, IV0042");
    expect(html).toContain("cannot divide one invoice between jobs");
    expect(html).toContain("never automatically");
    expect(html).toContain("Allocate the whole invoice to one job");
    expect(html).toContain("Exclude it from job costing");
    expect(html).toContain("Leave it here");
    expect(html).toContain('data-testid="invoice-split-required"');
  });

  it("the blocker and event have office wording (no raw codes leak to the page)", () => {
    expect(confirmBlockerLabel("multi_reference")).toBe(CONFIRM_BLOCKER_LABELS.multi_reference);
    expect(CONFIRM_BLOCKER_LABELS.multi_reference).toMatch(/split allocation required/i);
    expect(EVENT_LABELS.multi_reference_override).toMatch(/whole invoice/i);
  });
});
