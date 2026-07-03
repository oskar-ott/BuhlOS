import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DeviceDetectionCard } from "./DeviceDetectionCard";
import type { DeviceDetection } from "@/domains/ai-drawings/schema";

/**
 * SSR smoke for the #204 device-detection card. renderToString draws the
 * default state; detection behaviour (tiling, dedupe, vocabulary gate) is
 * covered by the API tests.
 */

function detection(over: Partial<DeviceDetection>): DeviceDetection {
  return {
    id: "dd_1",
    planId: "pl1",
    pageIndex: 0,
    pageSha256: "sha0",
    kind: "device",
    legendEntryId: "le_gpo",
    label: "Double GPO",
    bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
    confidence: 0.9,
    note: null,
    runId: "run_1",
    createdAt: "2026-07-03T00:00:00.000Z",
    ...over,
  };
}

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("DeviceDetectionCard (#204)", () => {
  it("renders per-page groups with unverified framing, per-label counts, and uncertain areas", () => {
    const html = strip(
      renderToString(
        createElement(DeviceDetectionCard, {
          detections: [
            detection({}),
            detection({ id: "dd_2", bbox: { x: 0.6, y: 0.2, w: 0.04, h: 0.04 }, confidence: 0.8 }),
            detection({
              id: "dd_3",
              legendEntryId: "le_dl",
              label: "LED downlight",
              confidence: 0.75,
            }),
            detection({
              id: "dd_4",
              kind: "uncertain-region",
              legendEntryId: null,
              label: null,
              confidence: null,
              note: "dense ceiling grid",
            }),
            detection({ id: "dd_5", planId: "pl2", pageIndex: 1 }),
          ],
          lookup: {
            pngUrlFor: () => "https://blob.test/p.png",
            labelFor: (planId) => (planId === "pl1" ? "E-SET · Rev C" : "E-SET · Rev B"),
          },
        }),
      ),
    );
    expect(html).toContain('data-testid="device-detections"');
    // counts stay raw and clearly unverified — never presented as takeoff numbers
    expect(html).toContain("unverified");
    expect(html).toContain("Nothing becomes a count");
    expect(html.match(/data-testid="detection-page"/g) ?? []).toHaveLength(2);
    expect(html).toContain("E-SET · Rev C · p1");
    expect(html).toContain("E-SET · Rev B · p2");
    expect(html).toContain("3 detections across 2 types");
    expect(html).toContain("Double GPO");
    expect(html).toContain("2 found (raw)");
    expect(html).toContain("LED downlight");
    expect(html).toContain("1 uncertain area");
    expect(html).toContain("dense ceiling grid");
    expect(html).toContain("needs a human count");
  });

  it("says when a detection's document is no longer on the job", () => {
    const html = strip(
      renderToString(
        createElement(DeviceDetectionCard, {
          detections: [detection({})],
          lookup: {
            pngUrlFor: () => null,
            labelFor: () => "(document no longer on this job)",
          },
        }),
      ),
    );
    expect(html).toContain("(document no longer on this job)");
    expect(html).toContain('data-testid="detection-label"');
  });
});
