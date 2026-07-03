import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RevisionDiffCard } from "./RevisionDiffCard";
import type { DiffRegion, PageDiff } from "@/domains/ai-drawings/schema";

/**
 * SSR smoke for the #203 revision-diff review card. renderToString draws the
 * default state; run/review behaviour is covered by the API + engine tests.
 */

function diff(over: Partial<PageDiff>): PageDiff {
  return {
    id: "pd_1",
    basePlanId: "plB",
    basePageIndex: 0,
    basePageSha256: "shaB",
    headPlanId: "plC",
    headPageIndex: 0,
    headPageSha256: "shaC",
    algoVersion: "pd-v1",
    identical: false,
    alignment: { dx: 2, dy: 0, quality: 0.97 },
    basis: { threshold: 48, mask: { x: 0.6, y: 0.7, w: 0.4, h: 0.3 } },
    regionCount: 2,
    createdAt: "2026-07-03T00:00:00.000Z",
    ...over,
  };
}

function region(over: Partial<DiffRegion>): DiffRegion {
  return {
    id: "dr_1",
    diffId: "pd_1",
    regionIndex: 0,
    bbox: { x: 0.2, y: 0.3, w: 0.1, h: 0.08 },
    areaCells: 12,
    status: "pending",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    ...over,
  };
}

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("RevisionDiffCard (#203)", () => {
  it("renders pair actions, the diff basis, and walkable regions", () => {
    const html = strip(
      renderToString(
        createElement(RevisionDiffCard, {
          jobId: "j1",
          diffs: [
            diff({}),
            diff({ id: "pd_2", headPageIndex: 1, basePageIndex: 1, identical: true, alignment: null, basis: { byteIdentical: true }, regionCount: 0 }),
          ],
          regions: [region({}), region({ id: "dr_2", regionIndex: 1, status: "reviewed", reviewedBy: "boss" })],
          pairs: [
            {
              headPlanId: "plC",
              basePlanId: "plB",
              headLabel: "E-SET · Rev C",
              baseLabel: "E-SET · Rev B",
              pageCount: 12,
            },
          ],
          comparing: null,
          onComparePair: () => undefined,
          lookup: {
            pngUrlFor: () => "https://blob.test/p.png",
            labelFor: (id) => (id === "plC" ? "E-SET · Rev C" : "E-SET · Rev B"),
          },
          onRegion: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="revision-diff"');
    expect(html).toContain("Compare E-SET · Rev C against E-SET · Rev B (12 pages)");
    expect(html.match(/data-testid="diff-section"/g) ?? []).toHaveLength(2);
    // the basis rides every diff — "no changes" never appears naked
    expect(html).toContain("alignment 97% · pixel threshold 48 · title block masked · pd-v1");
    expect(html).toContain("byte-identical");
    expect(html).toContain("identical rasters (same sha256)");
    expect(html).toContain("2 changed regions");
    expect(html).toContain("1/2 walked");
    expect(html).toContain("to walk"); // pending region marked
    expect(html).toContain('aria-label="Mark region 1 reviewed"');
  });

  it("states the empty case honestly", () => {
    const html = strip(
      renderToString(
        createElement(RevisionDiffCard, {
          jobId: "j1",
          diffs: [],
          regions: [],
          pairs: [],
          comparing: null,
          onComparePair: () => undefined,
          lookup: { pngUrlFor: () => null, labelFor: () => "?" },
          onRegion: () => undefined,
        }),
      ),
    );
    expect(html).toContain("No comparisons yet");
  });
});
