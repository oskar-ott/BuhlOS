import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PlanMarkupManagePanel } from "./PlanMarkupManagePanel";
import type { DrawingMarkup } from "@/domains/plan-markups/types";

/**
 * SSR smoke for the #651 manage panel. renderToString draws the panel in its
 * default filter state (all types, all visibility, nothing checked) — enough to
 * assert the LIST, the FILTER controls, and the BULK action chrome. Filtering /
 * checkbox-selection are driven by local useState (no DOM lib in this repo), so
 * those branches are exercised through the pure data the panel projects: every
 * row renders, each carries its type label + visibility pill, and the bulk
 * buttons start disabled (0 selected).
 */

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
  mk({ id: "pin1", type: "pin", x: 0.5, y: 0.5, visibleToPhil: true, label: "Board" }),
  mk({ id: "note1", type: "note", x: 0.2, y: 0.2, visibleToPhil: false, text: "Office note" }),
  mk({ id: "arrow1", type: "arrow", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], visibleToPhil: true }),
  mk({ id: "text1", type: "text", x: 0.4, y: 0.4, label: "GPO here" }),
];

const NOOP = () => {};

function render(props: Parameters<typeof PlanMarkupManagePanel>[0]): string {
  return renderToString(createElement(PlanMarkupManagePanel, props));
}

describe("PlanMarkupManagePanel (#651)", () => {
  const base = {
    selectedId: null,
    onSelect: NOOP,
    onBulkSetVisible: NOOP,
    onBulkArchive: NOOP,
  } as const;

  it("renders the panel, the filters, and a row per markup", () => {
    const html = render({ ...base, markups: MARKUPS });
    expect(html).toContain('data-testid="overlay-manage-panel"');
    expect(html).toContain('data-testid="manage-filters"');
    expect(html).toContain('data-testid="manage-list"');
    // a row per markup (4)
    expect(html.match(/data-testid="manage-row"/g) ?? []).toHaveLength(4);
    // labels / fallbacks surface
    expect(html).toContain("Board");
    expect(html).toContain("GPO here");
    expect(html).toContain("Office note");
  });

  it("offers a type filter (incl. the #651 types) and a visibility filter", () => {
    const html = render({ ...base, markups: MARKUPS });
    expect(html).toContain('aria-label="Filter by type"');
    expect(html).toContain('aria-label="Filter by visibility"');
    // the type options include the new shapes
    expect(html).toContain(">arrow<");
    expect(html).toContain(">text<");
    expect(html).toContain("Visible to Phil");
    expect(html).toContain("Office only");
  });

  it("shows a visibility pill per row (Visible vs Office)", () => {
    const html = render({ ...base, markups: MARKUPS });
    expect(html).toContain(">Visible<");
    expect(html).toContain(">Office<");
  });

  it("renders bulk actions, disabled while nothing is selected", () => {
    const html = render({ ...base, markups: MARKUPS });
    expect(html).toContain('data-testid="manage-bulk-show"');
    expect(html).toContain('data-testid="manage-bulk-hide"');
    expect(html).toContain('data-testid="manage-bulk-archive"');
    expect(html).toContain("0 selected");
    // each bulk button starts disabled (no checkbox checked under SSR)
    expect(html.match(/disabled=""/g) ?? []).not.toHaveLength(0);
  });

  it("shows an empty state when there are no markups", () => {
    const html = render({ ...base, markups: [] });
    expect(html).toContain('data-testid="manage-empty"');
    expect(html).not.toContain('data-testid="manage-row"');
  });

  it("highlights the selected row via aria-current", () => {
    const html = render({ ...base, markups: MARKUPS, selectedId: "arrow1" });
    expect(html).toContain('aria-current="true"');
  });
});
