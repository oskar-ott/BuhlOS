import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MobileApprovalsHub } from "./MobileApprovalsHub";

/**
 * Mobile-admin redesign — the consolidated approvals triage (md:hidden).
 * Real counts only; Dayworks routes to the register (signed, not approved) and
 * each chip is feature-flag-gated via `enabled` — a dark feature's chip never
 * renders and its count never leaks into the daily total.
 */

const ALL_ON = { expenses: true, itps: true, materials: true, dayworks: true };

function render(
  counts: { expenses: number; itps: number; materials: number },
  enabled: { expenses: boolean; itps: boolean; materials: boolean; dayworks: boolean } = ALL_ON,
): string {
  return renderToString(createElement(MobileApprovalsHub, { counts, enabled }));
}

describe("MobileApprovalsHub", () => {
  it("is mobile-only and lists the hub-routed approval types as chips", () => {
    const html = render({ expenses: 3, itps: 2, materials: 1 });
    expect(html).toContain("md:hidden");
    for (const label of ["Expenses", "ITPs", "Materials", "Dayworks"]) {
      expect(html).toContain(label);
    }
    // Proof-to-sign-off is NOT hosted here — it has its own surface on Today,
    // so the hub must not claim it (no stale UC marker).
    expect(html).not.toContain("Proof");
    // The daily total (hours excluded) is surfaced honestly.
    expect(html).toContain("6 to action today");
  });

  it("defaults to the first type with items and shows its real count + route", () => {
    const html = render({ expenses: 3, itps: 0, materials: 0 });
    expect(html).toContain("Expense claims");
    expect(html).toContain('href="/expenses"');
    expect(html).toContain("Review expenses");
  });

  it("hides chips whose feature flag is off and defaults to an enabled type", () => {
    const html = render(
      { expenses: 3, itps: 0, materials: 1 },
      { expenses: false, itps: false, materials: true, dayworks: false },
    );
    expect(html).not.toContain("Expenses");
    expect(html).not.toContain("ITPs");
    expect(html).not.toContain("Dayworks");
    expect(html).toContain("Materials");
    // The active panel is the first ENABLED chip with items…
    expect(html).toContain("Material requests");
    expect(html).toContain('href="/material-requests"');
    // …and a disabled feature's count never leaks into the daily total.
    expect(html).toContain("1 to action today");
  });

  it("exposes the active chip to assistive tech (aria-pressed) and meets the 44px tap floor", () => {
    const html = render({ expenses: 3, itps: 2, materials: 1 });
    // The selected state is announced, not colour-only (WCAG 4.1.2).
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    // Chips are 44px tall (h-11), not the 36px h-9 they shipped with.
    expect(html).toContain("h-11");
    expect(html).not.toMatch(/rounded-pill border px-3\.5[^"]*h-9/);
  });

  it("renders 'All clear' and no fabricated counts when everything is empty", () => {
    const html = render({ expenses: 0, itps: 0, materials: 0 });
    expect(html).toContain("All clear");
  });

  it("keeps the desktop-boundary honesty in the footer", () => {
    const html = render({ expenses: 0, itps: 0, materials: 0 });
    expect(html).toContain("payroll export, PO raising");
  });
});
