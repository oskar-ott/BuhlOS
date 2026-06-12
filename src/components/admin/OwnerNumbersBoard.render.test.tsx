import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { OwnerNumbersBoard } from "./OwnerNumbersBoard";
import {
  approvalsWaitingTile,
  crewOnClockTile,
  defectsAttentionTile,
  hoursThisWeekTile,
  overContractTile,
  quotePipelineTile,
  sourceErrorTile,
  CompareWeeksResponseSchema,
  OwnerJobsResponseSchema,
  QuoteStatsResponseSchema,
  type OwnerNumberTile,
} from "@/domains/analytics/owner-numbers";

/**
 * #316 — the /reports board paints whatever the owner-numbers module
 * returns: all six tiles, and per-source degradation (one failed source
 * = one explicit error tile, five live numbers).
 */

const NOW = Date.parse("2026-06-12T00:00:00Z");

function sixTiles(): OwnerNumberTile[] {
  return [
    hoursThisWeekTile(
      CompareWeeksResponseSchema.parse({
        thisWeek: {
          weekStart: "2026-06-08",
          weekEnd: "2026-06-14",
          hours: { submittedTotal: 31.5, approvedTotal: 76 },
        },
        lastWeek: {
          weekStart: "2026-06-01",
          weekEnd: "2026-06-07",
          hours: { submittedTotal: 0, approvedTotal: 120 },
        },
      }),
      "2026-06-12",
    ),
    approvalsWaitingTile({ entries: [{}, {}, {}] }),
    crewOnClockTile({
      date: "2026-06-12",
      hours: { submittedTotal: 34, approvedTotal: 4.5, crewOnSite: 5 },
    }),
    defectsAttentionTile(
      {
        snags: [
          {
            status: "open",
            priority: "urgent",
            createdAt: new Date(NOW - 86_400_000).toISOString(),
          },
        ],
      },
      NOW,
    ),
    quotePipelineTile(
      QuoteStatsResponseSchema.parse({
        total: 14,
        active: 9,
        stale: { draft: 1, reviewing: 0, estimating: 1, submitted: 2, accepted: 0 },
      }),
    ),
    overContractTile(
      OwnerJobsResponseSchema.parse({
        jobs: [
          {
            id: "job_a",
            name: "Hilltop Rewire",
            status: "active",
            contractValue: 120000,
            cashWatch: {
              lastAlertedAt: "2026-06-11T19:01:02.000Z",
              forecastEnd: 131400,
              contractValue: 120000,
              spent: 96100,
            },
          },
        ],
      }),
    ),
  ];
}

function render(tiles: ReadonlyArray<OwnerNumberTile>): string {
  return renderToString(createElement(OwnerNumbersBoard, { tiles }));
}

describe("OwnerNumbersBoard (#316)", () => {
  it("paints all six ratified numbers with their values and drill-downs", () => {
    const html = render(sixTiles());
    for (const id of [
      "hours_week",
      "approvals_waiting",
      "crew_on_clock",
      "defects_attention",
      "quotes_pipeline",
      "over_contract",
    ]) {
      expect(html).toContain(`owner-number-${id}`);
    }
    expect(html).toContain("107.5 h");
    expect(html).toContain("Approvals waiting");
    expect(html).toContain("On the clock today");
    expect(html).toContain("Hilltop Rewire");
    // Deep links into the record surfaces.
    expect(html).toContain('href="/hours/approvals"');
    expect(html).toContain('href="/defects?status=open"');
    expect(html).toContain('href="/v2/jobs/job_a"');
    // Honest labelling — never "on site" for time-entry-derived numbers.
    expect(html).not.toContain("On site");
  });

  it("quotes tile renders WITHOUT a link (no quoting surface exists — no dead ends)", () => {
    const html = render(sixTiles());
    expect(html).toContain("No quoting surface to open yet");
    // No anchor wraps the quotes tile: the only hrefs are the five real drills.
    expect(html).not.toContain('href="/quotes"');
    expect(html).not.toContain('href="/admin/quotes"');
  });

  it("one failed source → its explicit error tile, the other five still paint", () => {
    const tiles = sixTiles();
    tiles[0] = sourceErrorTile("hours_week", "Compare-weeks API returned 500");
    const html = render(tiles);
    expect(html).toContain("Couldn&#x27;t load this number — Compare-weeks API returned 500.");
    expect(html).toContain("Couldn’t load");
    expect(html).toContain('role="alert"');
    // The five live tiles are untouched.
    expect(html).toContain("On the clock today");
    expect(html).toContain("Hilltop Rewire");
    expect(html).toContain('owner-number-approvals_waiting');
    expect(html).toContain('owner-number-quotes_pipeline');
    expect(html).toContain('owner-number-defects_attention');
  });

  it("missing state shows the explainer instead of a fake zero (tile 6 no-contract case)", () => {
    const tiles = sixTiles();
    tiles[5] = overContractTile(
      OwnerJobsResponseSchema.parse({ jobs: [{ id: "a", name: "A", status: "active" }] }),
    );
    const html = render(tiles);
    expect(html).toContain("No contract values set on active jobs");
    expect(html).toContain("No data");
    expect(html).not.toContain("$0");
  });
});
