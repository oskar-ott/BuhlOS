import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobPurchasesBody } from "./PhilJobPurchasesCard";
import type { JobPurchase } from "@/domains/invoices/schema";

const p = (over: Partial<JobPurchase> & { id: string }): JobPurchase => ({
  date: "2026-09-10",
  supplier: "Wholesale Wires",
  supplierInvoiceNumber: "WW-9",
  boughtBy: "Tom",
  kind: "invoice",
  lines: [
    { description: "2.5MM TPS 100M ROLL", quantity: 3, unit: "roll", category: "cable", categoryLabel: "Cable", measure: { amount: 300, unit: "m" } },
    { description: "9W LED DOWNLIGHT", quantity: 12, unit: "ea", category: "lighting", categoryLabel: "Lighting", measure: { amount: 12, unit: "pcs" } },
  ],
  ...over,
});

describe("PhilJobPurchasesBody — What's been bought (no prices, ever)", () => {
  it("lists the latest purchases with who/where and the items, and never renders money even if an amount slipped in", () => {
    const html = renderToString(
      createElement(PhilJobPurchasesBody, {
        purchases: [p({ id: "a", amountCents: 41550 }), p({ id: "b", kind: "return", boughtBy: null, lines: [] })],
        totalCount: 2,
        awaitingCount: 0,
      })
    );
    expect(html).toContain("Wholesale Wires · Tom");
    expect(html).toContain("3 × 2.5MM TPS 100M ROLL · 300 m");
    expect(html).toContain("12 × 9W LED DOWNLIGHT");
    expect(html).toContain("Return · Wholesale Wires");
    expect(html).toContain("couldn’t be read");
    expect(html).not.toMatch(/\$|415\.50|41550/);
    // glove-sized rows that open without script
    expect(html).toContain("<details");
    expect(html).toContain("min-h-[48px]");
  });
  it("shows three, offers the rest, and says honestly what's still with the office", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => p({ id }));
    const html = renderToString(createElement(PhilJobPurchasesBody, { purchases: many, totalCount: 25, awaitingCount: 2 }));
    expect(html.match(/<details/g)).toHaveLength(3);
    expect(html).toContain("Show 2 more");
    expect(html).toContain("Latest 5 of 25.");
    expect(html).toContain("2 more are still with the office.");
  });
});
