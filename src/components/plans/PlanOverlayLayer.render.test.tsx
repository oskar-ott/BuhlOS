import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PlanOverlayLayer } from "./PlanOverlayLayer";
import type { PageView } from "@/domains/plans/coords";
import type { DrawingMarkup } from "@/domains/plan-markups/types";

/**
 * SSR smoke for the SVG overlay layer (node env, no browser). renderToString is
 * enough here because the layer is presentational — it draws from props with no
 * effects. Interaction (click-to-add / select) is covered by the API test +
 * the controller wiring.
 */

const VIEW: PageView = { baseWidth: 100, baseHeight: 100, zoom: 1, rotation: 0, offsetX: 0, offsetY: 0 };

function mk(over: Partial<DrawingMarkup> & { id: string; type: DrawingMarkup["type"] }): DrawingMarkup {
  return {
    jobId: "job-1",
    planId: "plan-1",
    pageIndex: 0,
    visibleToPhil: true,
    archived: false,
    ...over,
  } as DrawingMarkup;
}

const MARKUPS: DrawingMarkup[] = [
  mk({ id: "pin1", type: "pin", x: 0.5, y: 0.5, visibleToPhil: true }),
  mk({ id: "note1", type: "note", x: 0.2, y: 0.2, visibleToPhil: false }), // office-only
  mk({ id: "line1", type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
  mk({ id: "area1", type: "area", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] }),
];

function render(props: Parameters<typeof PlanOverlayLayer>[0]): string {
  return renderToString(createElement(PlanOverlayLayer, props));
}

describe("PlanOverlayLayer", () => {
  it("renders the layer with a marker per type", () => {
    const html = render({ markups: MARKUPS, view: VIEW, boxW: 100, boxH: 100, selectedId: null, onSelect: () => {} });
    expect(html).toContain('data-testid="plan-overlay-layer"');
    expect(html).toContain('data-testid="plan-markup-pin"');
    expect(html).toContain('data-testid="plan-markup-note"');
    expect(html).toContain("<line");
    expect(html).toContain("<polygon");
  });

  it("marks office-only markers with a dashed ring (admin glance)", () => {
    const html = render({ markups: [MARKUPS[1]!], view: VIEW, boxW: 100, boxH: 100, selectedId: null, onSelect: () => {} });
    expect(html).toContain('stroke-dasharray="2 2"');
  });

  it("does not render the dashed office-only ring for a visibleToPhil marker", () => {
    const html = render({ markups: [MARKUPS[0]!], view: VIEW, boxW: 100, boxH: 100, selectedId: null, onSelect: () => {} });
    expect(html).not.toContain('stroke-dasharray="2 2"');
  });

  it("shows the click-capture rect only in add-mode", () => {
    const view = render({ markups: [], view: VIEW, boxW: 100, boxH: 100, selectedId: null, onSelect: () => {} });
    expect(view).not.toContain('data-testid="plan-overlay-add-capture"');
    const add = render({ markups: [], view: VIEW, boxW: 100, boxH: 100, selectedId: null, onSelect: () => {}, addMode: "pin", onAddPoint: () => {} });
    expect(add).toContain('data-testid="plan-overlay-add-capture"');
  });

  it("renders empty (just the layer) with no markups", () => {
    const html = render({ markups: [], view: VIEW, boxW: 100, boxH: 100, selectedId: null, onSelect: () => {} });
    expect(html).toContain('data-testid="plan-overlay-layer"');
    expect(html).not.toContain("plan-markup-");
  });
});
