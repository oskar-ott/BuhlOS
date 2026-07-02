import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { LegendVocabularyCard } from "./LegendVocabularyCard";
import type { LegendEntry } from "@/domains/ai-drawings/schema";

/**
 * SSR smoke for the #201 legend vocabulary. renderToString draws the default
 * state; the review/add behaviour is covered by the API tests
 * (src/domains/ai-drawings/ai-drawings-api.test.ts).
 */

function entry(over: Partial<LegendEntry>): LegendEntry {
  return {
    id: "le_1",
    origin: "ai",
    status: "suggested",
    label: "DOUBLE GPO",
    effectiveLabel: "DOUBLE GPO",
    description: null,
    category: "Power",
    symbolText: "circle with two lines",
    symbolCropUrl: null,
    cropRegion: null,
    sourcePlanId: "pl1",
    sourcePageIndex: 0,
    confidence: 0.92,
    model: "claude-opus-4-8",
    promptVersion: "lv-v1",
    createdAt: "2026-07-03T00:00:00.000Z",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    ...over,
  };
}

function strip(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("LegendVocabularyCard (#201)", () => {
  it("renders grouped entries with honest review states + the add form", () => {
    const html = strip(
      renderToString(
        createElement(LegendVocabularyCard, {
          jobId: "j1",
          entries: [
            entry({}),
            entry({
              id: "le_2",
              status: "edited",
              label: "DOWNLIGHT",
              effectiveLabel: "LED DOWNLIGHT 90mm",
              category: "Lighting",
            }),
            entry({
              id: "le_3",
              origin: "human",
              status: "accepted",
              label: "EXHAUST FAN",
              effectiveLabel: "EXHAUST FAN",
              category: "Mechanical",
              confidence: null,
              model: null,
            }),
            entry({
              id: "le_4",
              status: "rejected",
              label: "BOGUS",
              effectiveLabel: "BOGUS",
              reviewNote: "not on this job",
            }),
          ],
          onEntry: () => undefined,
        }),
      ),
    );
    expect(html).toContain('data-testid="legend-vocabulary"');
    expect(html).toContain("Legend vocabulary");
    expect(html).toContain("3 entries"); // rejected excluded from the live count
    expect(html).toContain("1 awaiting review");
    expect(html).toContain("review · 92%"); // suggested rows carry confidence
    expect(html).toContain("LED DOWNLIGHT 90mm"); // edited label wins
    expect(html).toContain("added by hand"); // human origin marked
    expect(html).toContain("Show 1 rejected");
    expect(html).toContain("Add an entry the AI missed");
    // suggested rows expose review actions
    expect(html).toContain('aria-label="Accept &quot;DOUBLE GPO&quot;"');
  });

  it("states the empty case honestly", () => {
    const html = strip(
      renderToString(
        createElement(LegendVocabularyCard, { jobId: "j1", entries: [], onEntry: () => undefined }),
      ),
    );
    expect(html).toContain("No legend entries yet");
  });
});
