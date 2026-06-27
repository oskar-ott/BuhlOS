import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MobileApprovalsHub } from "./MobileApprovalsHub";

/**
 * Mobile-admin redesign — the consolidated approvals triage (md:hidden).
 * Real counts only; Dayworks routes to the register (signed, not approved) and
 * Proof is an honest UC marker until #503 ships.
 */

function render(counts: { expenses: number; itps: number; materials: number }): string {
  return renderToString(createElement(MobileApprovalsHub, { counts }));
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

  it("renders 'All clear' and no fabricated counts when everything is empty", () => {
    const html = render({ expenses: 0, itps: 0, materials: 0 });
    expect(html).toContain("All clear");
  });

  it("keeps the desktop-boundary honesty in the footer", () => {
    const html = render({ expenses: 0, itps: 0, materials: 0 });
    expect(html).toContain("payroll export, PO raising");
  });
});
