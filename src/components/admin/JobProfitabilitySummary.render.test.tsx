import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobProfitabilitySummary } from "./JobProfitabilitySummary";
import { formatMoneyCents } from "@/domains/jobs/profitability-client";

/**
 * #327 — the profitability card's initial render (renderToString skips the mount
 * fetch, so we see the loading state). The margin maths + honesty are pinned by
 * the API/pure harnesses; this guards the card title + the money formatter.
 */

describe("JobProfitabilitySummary — initial render", () => {
  it("renders the cost-rate-based title and a loading state before data arrives", () => {
    const html = renderToString(createElement(JobProfitabilitySummary, { jobId: "job-a" }));
    expect(html).toContain("Profitability");
    expect(html).toContain("cost-rate based");
    expect(html).toContain("Loading");
  });
});

describe("formatMoneyCents", () => {
  it("formats whole dollars and cents, handles negatives and null", () => {
    expect(formatMoneyCents(12_000_000)).toBe("$120,000");
    expect(formatMoneyCents(4_537_550)).toBe("$45,375.50");
    expect(formatMoneyCents(-30_000)).toBe("-$300");
    expect(formatMoneyCents(null)).toBe("—");
  });
});
