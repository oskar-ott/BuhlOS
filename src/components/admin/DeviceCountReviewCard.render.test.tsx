import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DeviceCountReviewCard } from "./DeviceCountReviewCard";
import type { CountReviewPage, LegendEntry } from "@/domains/ai-drawings/schema";

/**
 * SSR smoke for the #205 count-review card. renderToString draws the default
 * state (the marker overlay itself mounts after the raster is measured
 * client-side); the verify-loop behaviour is covered by the API + reducer
 * tests.
 */

function marker(over: Partial<CountReviewPage["markers"][number]>) {
  return {
    key: "d:d1",
    source: "ai" as const,
    detectionId: "d1",
    reviewId: null,
    bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
    legendEntryId: "le_gpo",
    label: "Double GPO",
    confidence: 0.9,
    status: "live" as const,
    appliedReviewIds: [],
    roomId: null,
    roomPinned: false,
    ...over,
  };
}

function page(over: Partial<CountReviewPage>): CountReviewPage {
  return {
    planId: "pl1",
    pageIndex: 0,
    pageSha256: "sha0",
    markers: [
      marker({}),
      marker({ key: "d:d2", detectionId: "d2", status: "deleted", appliedReviewIds: ["rv_1"] }),
      marker({
        key: "r:rv_2",
        source: "human",
        detectionId: null,
        reviewId: "rv_2",
        confidence: null,
        appliedReviewIds: ["rv_2"],
      }),
    ],
    uncertain: [
      {
        id: "u1",
        planId: "pl1",
        pageIndex: 0,
        pageSha256: "sha0",
        kind: "uncertain-region",
        legendEntryId: null,
        label: null,
        bbox: { x: 0.8, y: 0.1, w: 0.15, h: 0.15 },
        confidence: null,
        note: "dense grid",
        runId: "run_1",
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    ],
    rooms: [],
    byRoom: [],
    cable: { pins: [], calibration: null, run: null },
    counts: [
      {
        legendEntryId: "le_gpo",
        label: "Double GPO",
        liveCount: 2,
        removedCount: 1,
        addedCount: 1,
        accepted: null,
      },
      {
        legendEntryId: "le_dl",
        label: "LED downlight",
        liveCount: 4,
        removedCount: 0,
        addedCount: 0,
        accepted: {
          id: "ac_1",
          planId: "pl1",
          pageIndex: 0,
          pageSha256: "sha0",
          legendEntryId: "le_dl",
          label: "LED downlight",
          count: 4,
          basis: { markerKeys: [], markers: [], reviewIds: [] },
          acceptedAt: "2026-07-03T01:00:00.000Z",
          acceptedBy: "boss",
          stale: false,
        },
      },
    ],
    ...over,
  };
}

const vocabulary: LegendEntry[] = [];

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("DeviceCountReviewCard (#205)", () => {
  it("renders count rows with live/removed/added honesty, accept buttons, and verified badges", () => {
    const html = strip(
      renderToString(
        createElement(DeviceCountReviewCard, {
          jobId: "j1",
          pages: [page({})],
          vocabulary,
          lookup: {
            pngUrlFor: () => "https://blob.test/p.png",
            labelFor: () => "E-101 · Rev C",
          },
          onPage: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="count-review"');
    expect(html).toContain("E-101 · Rev C · p1");
    // unaccepted entry: unverified + an accept CTA with the live number
    expect(html).toContain("unverified");
    expect(html).toContain("Accept 2 as verified");
    expect(html).toContain("1 removed");
    expect(html).toContain("1 added by review");
    // accepted entry: verified badge with acceptor
    expect(html).toContain("4 verified · boss");
    // uncertain area is called out for hand counting
    expect(html).toContain("need a hand");
    expect(html).toContain("count those by hand");
    // the page pill stays unverified while any type is unaccepted
    expect(html).not.toContain("counts verified");
  });

  it("marks a stale sign-off as changed since accept, never silently verified", () => {
    const p = page({});
    p.counts[1]!.accepted!.stale = true;
    const html = strip(
      renderToString(
        createElement(DeviceCountReviewCard, {
          jobId: "j1",
          pages: [p],
          vocabulary,
          lookup: { pngUrlFor: () => null, labelFor: () => "E-101" },
          onPage: () => undefined,
        }),
      ),
    );
    expect(html).toContain("changed since sign-off (4 accepted)");
    expect(html).toContain("Accept 4 as verified"); // re-accept CTA
    expect(html).toContain("(document no longer on this job");
  });

  it("renders rooms with review actions and the by-room grouping incl. the explicit unzoned bucket (#206)", () => {
    const p = page({
      rooms: [
        {
          id: "rm_1",
          planId: "pl1",
          pageIndex: 0,
          pageSha256: "sha0",
          origin: "ai",
          status: "suggested",
          name: "KITCHEN",
          effectiveName: "KITCHEN",
          bbox: { x: 0.35, y: 0.35, w: 0.2, h: 0.2 },
          effectiveBbox: { x: 0.35, y: 0.35, w: 0.2, h: 0.2 },
          confidence: 0.85,
          createdAt: "2026-07-03T00:00:00.000Z",
          reviewedAt: null,
          reviewedBy: null,
          reviewNote: null,
        },
        {
          id: "rm_2",
          planId: "pl1",
          pageIndex: 0,
          pageSha256: "sha0",
          origin: "human",
          status: "accepted",
          name: "RUMPUS",
          effectiveName: "RUMPUS",
          bbox: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 },
          effectiveBbox: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 },
          confidence: null,
          createdAt: "2026-07-03T00:00:00.000Z",
          reviewedAt: "2026-07-03T00:00:00.000Z",
          reviewedBy: "boss",
          reviewNote: null,
        },
      ],
      byRoom: [
        {
          roomId: "rm_1",
          roomName: "KITCHEN",
          total: 2,
          entries: [{ legendEntryId: "le_gpo", label: "Double GPO", count: 2 }],
        },
        {
          roomId: null,
          roomName: null,
          total: 1,
          entries: [{ legendEntryId: "le_dl", label: "LED downlight", count: 1 }],
        },
      ],
    });
    const html = strip(
      renderToString(
        createElement(DeviceCountReviewCard, {
          jobId: "j1",
          pages: [p],
          vocabulary,
          lookup: { pngUrlFor: () => "https://blob.test/p.png", labelFor: () => "E-101" },
          onPage: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="rooms-section"');
    expect(html).toContain("KITCHEN");
    expect(html.match(/data-testid="room-row"/g) ?? []).toHaveLength(2);
    // an AI suggestion carries its honest confidence; a human room says added
    expect(html).toContain("AI · 85%");
    expect(html).toContain("added");
    // review affordances exist for rename / redraw / reject / accept
    expect(html).toContain('aria-label="Accept room KITCHEN"');
    expect(html).toContain('aria-label="Redraw room RUMPUS"');
    expect(html).toContain("Not a room");
    // by-room grouping with the unzoned bucket explicit and last
    expect(html).toContain('data-testid="by-room-row"');
    expect(html).toContain("2× Double GPO");
    expect(html).toContain('data-testid="by-room-unzoned"');
    expect(html).toContain("Unzoned (outside every room)");
    expect(html).toContain("1× LED downlight");
  });

  it("renders the cable estimate with assumptions attached and estimate-everywhere labelling (#211)", () => {
    const p = page({
      cable: {
        pins: [
          { id: "bp_1", boardIdentifier: "DB-1", point: { x: 0.1, y: 0.1 }, createdBy: "boss" },
        ],
        calibration: {
          id: "cal_1",
          pointA: { x: 0.25, y: 0.5 },
          pointB: { x: 0.75, y: 0.5 },
          realMm: 8100,
          rasterAspect: 0.7,
          mmPerNormX: 16200,
          mmPerNormY: 11340,
          titleScaleText: "1:100",
          createdAt: "2026-07-03T00:00:00.000Z",
          createdBy: "boss",
        },
        run: {
          id: "cr_1",
          status: "draft",
          factors: { routingFactor: 1.15, riseDropMm: 4000, slackFactor: 1.1 },
          inputs: {
            markerKeys: ["d:d1"],
            markers: [
              { key: "d:d1", label: "Double GPO", bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 } },
            ],
            pins: [{ boardIdentifier: "DB-1", point: { x: 0.1, y: 0.1 } }],
            calibration: {
              id: "cal_1",
              mmPerNormX: 16200,
              mmPerNormY: 11340,
              realMm: 8100,
              titleScaleText: "1:100",
            },
          },
          results: {
            perDevice: [
              {
                markerKey: "d:d1",
                label: "Double GPO",
                legendEntryId: "le_gpo",
                boardIdentifier: "DB-1",
                manhattanMm: 8830,
                estimateMm: 15170,
              },
            ],
            boards: [
              {
                boardIdentifier: "DB-1",
                deviceCount: 1,
                totalMm: 15170,
                byLabel: [
                  { label: "Double GPO", legendEntryId: "le_gpo", deviceCount: 1, totalMm: 15170 },
                ],
              },
            ],
            totalMm: 15170,
            deviceCount: 1,
          },
          createdAt: "2026-07-03T00:00:00.000Z",
          createdBy: "boss",
          acceptedAt: null,
          acceptedBy: null,
          stale: false,
        },
      },
    });
    const html = strip(
      renderToString(
        createElement(DeviceCountReviewCard, {
          jobId: "j1",
          pages: [p],
          vocabulary,
          lookup: { pngUrlFor: () => "https://blob.test/p.png", labelFor: () => "E-101" },
          onPage: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="cable-section"');
    expect(html).toContain("estimate — assumptions attached");
    expect(html).toContain("Calibrated against a 8100mm reference");
    expect(html).toContain("title block says 1:100 (cross-check)");
    expect(html).toContain("15 m est. total");
    expect(html).toContain("draft — not accepted");
    expect(html).toContain("Accept estimate");
    expect(html).toContain("Manhattan distance × routing");
    expect(html).toContain("not a measurement");
    expect(html).toContain('data-testid="cable-board-row"');
  });

  it("flags a stale cable run and never shows accepted state for it", () => {
    const p = page({});
    // uncalibrated page with live markers: the section renders the refusal state
    const html = strip(
      renderToString(
        createElement(DeviceCountReviewCard, {
          jobId: "j1",
          pages: [p],
          vocabulary,
          lookup: { pngUrlFor: () => "https://blob.test/p.png", labelFor: () => "E-101" },
          onPage: () => undefined,
        }),
      ),
    );
    expect(html).toContain("Not calibrated — estimates need a known dimension");
  });

  it("shows the all-verified page state when every count is accepted and fresh", () => {
    const p = page({});
    p.counts[0]!.accepted = {
      ...p.counts[1]!.accepted!,
      legendEntryId: "le_gpo",
      label: "Double GPO",
      count: 2,
    };
    const html = strip(
      renderToString(
        createElement(DeviceCountReviewCard, {
          jobId: "j1",
          pages: [p],
          vocabulary,
          lookup: { pngUrlFor: () => "https://blob.test/p.png", labelFor: () => "E-101" },
          onPage: () => undefined,
        }),
      ),
    );
    expect(html).toContain("counts verified");
  });
});
