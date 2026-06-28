import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PlanOverlayController, asBuiltPillLabel } from "./PlanOverlayController";
import type { Plan } from "@/domains/plans/types";

/**
 * SSR smoke for the overlay controller. renderToString does not run effects, so
 * no markup fetch fires and `natural` is unset (the SVG layer needs a measured
 * raster) — this asserts the *chrome*: admins get the overlay toolbar, Phil
 * gets the read-only hint and NO add/edit controls. Marker rendering is covered
 * by PlanOverlayLayer.render.test.tsx; mutation by the API test.
 */

// The client is import-only here (effects don't run under SSR), but stub it so
// the module graph never attempts a real fetch.
vi.mock("@/domains/plan-markups/client", () => ({
  listMarkups: () => Promise.resolve({ ok: true, data: { markups: [] } }),
  createMarkup: () => Promise.resolve({ ok: false, error: { status: 0, body: null, message: "noop" } }),
  updateMarkup: () => Promise.resolve({ ok: false, error: { status: 0, body: null, message: "noop" } }),
  archiveMarkup: () => Promise.resolve({ ok: false, error: { status: 0, body: null, message: "noop" } }),
  errorText: () => "noop",
}));

const PLAN = {
  id: "plan-1",
  url: "https://example.test/plan.pdf",
  status: "current",
  drawingNumber: "E-01",
  revision: "B",
  pages: [{ pageIndex: 0, pngUrl: "https://example.test/0.png", width: 100, height: 100 }],
} as unknown as Plan;

describe("PlanOverlayController", () => {
  it("renders the admin overlay toolbar (add pin/note/line + select)", () => {
    const html = renderToString(createElement(PlanOverlayController, { jobId: "job-1", plan: PLAN, mode: "admin" }));
    expect(html).toContain('data-testid="overlay-toolbar"');
    expect(html).toContain("Add pin");
    expect(html).toContain("Add note");
    expect(html).toContain("Add line");
    expect(html).toContain("Select");
    expect(html).toContain('data-testid="overlay-summary"');
  });

  it("renders Phil read-only (no toolbar, no add/edit controls)", () => {
    const html = renderToString(createElement(PlanOverlayController, { jobId: "job-1", plan: PLAN, mode: "phil" }));
    expect(html).toContain('data-testid="overlay-phil-hint"');
    expect(html).not.toContain('data-testid="overlay-toolbar"');
    expect(html).not.toContain("Add pin");
    expect(html).not.toContain("Show to Phil");
    expect(html).not.toContain("Archive");
    // #233 — the as-built designation is admin-only; Phil never sees the toggle.
    expect(html).not.toContain("Mark as-built");
    expect(html).not.toContain('data-testid="overlay-asbuilt-toggle"');
  });
});

describe("#233 asBuiltPillLabel — revision-context honesty", () => {
  it("carries the revision when known (superseded plan reads honestly)", () => {
    expect(asBuiltPillLabel("A", "E-01")).toBe("As-built · Rev A");
  });

  it("falls back to the drawing number when no revision", () => {
    expect(asBuiltPillLabel(undefined, "E-01")).toBe("As-built · E-01");
  });

  it("is a bare label when neither is known — never invents a revision", () => {
    expect(asBuiltPillLabel()).toBe("As-built");
    expect(asBuiltPillLabel("  ", "  ")).toBe("As-built");
  });
});
