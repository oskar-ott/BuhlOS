import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { JobMoneyCard } from "./JobMoneyCard";
import { formatMoneyCents } from "@/domains/jobs/profitability-client";

/**
 * The hub's ONE money card (2026-08-09 job-hub audit: replaces the #327
 * Profitability + #341 Budget cards and their duplicate fetch). renderToString
 * skips the mount fetch, so this pins the initial contract: title, ex-GST
 * framing, and a skeleton — no "Loading…" text, no fabricated figures.
 * The variance/margin maths stay pinned by the API/pure harnesses.
 */
describe("JobMoneyCard — initial render", () => {
  it("renders the Money title, ex-GST note, and a loading skeleton", () => {
    const html = renderToString(createElement(JobMoneyCard, { jobId: "job-a" }));
    expect(html).toContain("Money");
    expect(html).toContain("ex GST");
    expect(html).toContain("money-skeleton");
    expect(html).not.toContain("$");
  });
});

/** Kept from the deleted JobProfitabilitySummary test — the formatter contract. */
describe("formatMoneyCents", () => {
  it("formats whole dollars and cents, handles negatives and null", () => {
    expect(formatMoneyCents(12_000_000)).toBe("$120,000");
    expect(formatMoneyCents(4_537_550)).toBe("$45,375.50");
    expect(formatMoneyCents(-30_000)).toBe("-$300");
    expect(formatMoneyCents(null)).toBe("—");
  });
});
