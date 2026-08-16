import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PayRunCard } from "./PayRunCard";

/**
 * Static-render guard for the 3-step pay-run card (owner redesign 2026-08-16).
 * It self-fetches on mount, so a server render can only pin the honest first
 * face: "Checking this period…" — never a fabricated stepper state, and no
 * action buttons before the engine has answered.
 */

const render = () =>
  renderToString(
    createElement(PayRunCard, {
      fromDate: "2026-08-10",
      toDate: "2026-08-16",
      notClosed: false,
      exportEnabled: true,
    }),
  );

describe("PayRunCard", () => {
  it("first face is the loading check, never a fabricated stepper", () => {
    const html = render();
    expect(html).toContain("Payroll run");
    expect(html).toContain("Checking this period…");
    expect(html).not.toContain('data-testid="payrun-create"');
    expect(html).not.toContain('data-testid="payrun-send"');
  });
});
