import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WeekShapeStrip, WeekShapeLegend } from "./WeekShapeStrip";
import type { StripCell, StripTone } from "@/domains/timesheets/pay-run";

function cell(p: Partial<StripCell> & { date: string; weekday: string }): StripCell {
  return {
    status: "approved",
    tone: "approved",
    hoursLabel: "8h",
    emptyGlyph: "",
    title: `${p.weekday} · Approved · 8h`,
    ...p,
  };
}

describe("WeekShapeStrip (render)", () => {
  it("renders one square per cell with the weekday and an accessible label", () => {
    const cells: StripCell[] = [
      cell({ date: "2024-05-20", weekday: "Mon" }),
      cell({
        date: "2024-05-21",
        weekday: "Tue",
        status: "missing",
        tone: "missing",
        hoursLabel: null,
        emptyGlyph: "—",
        title: "Tue · Missing",
      }),
    ];
    const html = renderToString(
      createElement(WeekShapeStrip, { cells, workerName: "Jack Smith" }),
    );
    expect(html).toContain("Mon");
    expect(html).toContain("Tue");
    // The strip is an image with a per-worker label, not colour-only.
    expect(html).toContain('aria-label="Jack Smith — week at a glance"');
    expect(html).toContain("Jack Smith: Tue · Missing");
    // Missing cell shows the glyph, never a fabricated 0.
    expect(html).toContain("—");
  });

  it("strips internal whitespace from the hours label inside the square", () => {
    const html = renderToString(
      createElement(WeekShapeStrip, {
        cells: [cell({ date: "2024-05-20", weekday: "Mon", hoursLabel: "7h 36m" })],
        workerName: "Tom",
      }),
    );
    // "7h 36m" → "7h36m" so the tiny square doesn't wrap.
    expect(html).toContain("7h36m");
  });
});

describe("WeekShapeLegend (render)", () => {
  it("shows only the tones present in the run", () => {
    const tones = new Set<StripTone>(["approved", "missing"]);
    const html = renderToString(createElement(WeekShapeLegend, { tones }));
    expect(html).toContain("Approved");
    expect(html).toContain("Missing");
    // Not present in the set → not in the legend.
    expect(html).not.toContain("Rejected");
    expect(html).not.toContain("Holiday");
  });

  it("renders nothing when no tones are present", () => {
    const html = renderToString(
      createElement(WeekShapeLegend, { tones: new Set<StripTone>() }),
    );
    expect(html).toBe("");
  });
});
