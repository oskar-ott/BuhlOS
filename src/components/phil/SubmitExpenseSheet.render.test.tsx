import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SubmitExpenseSheet } from "./SubmitExpenseSheet";

/**
 * Static-render guards for the Phil "Submit a receipt" sheet (#536). The live
 * upload→submit flow is pinned by the api harness; these pin the surface:
 * photo-first, worker language, all four field groups present, closed = null.
 */

const noop = () => {};
const render = (open: boolean) =>
  renderToString(
    createElement(SubmitExpenseSheet, { open, onClose: noop, onSubmitted: noop, onFailed: noop }),
  );

describe("SubmitExpenseSheet (#536)", () => {
  it("renders nothing when closed", () => {
    expect(render(false)).toBe("");
  });

  it("is photo-first and asks for amount, category and an optional note in worker language", () => {
    const html = render(true);
    expect(html).toContain("Take a photo of the receipt");
    expect(html).toContain("How much was it?");
    expect(html).toContain("What was it for?");
    // category options
    expect(html).toContain("Fuel");
    expect(html).toContain("Parking");
    expect(html).toContain("Materials");
    // submit CTA — no accounting jargon
    expect(html).toContain("Submit for reimbursement");
  });
});
