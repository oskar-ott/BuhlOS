import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PlansClient } from "./PlansClient";
import type { Document } from "@/domains/documents/types";

/**
 * Server-render smoke for the Phase 1 Plans surface (PlansClient + PlanViewer).
 * Node env, no browser — mirrors the project's renderToString approach
 * (MaterialRequestsInbox.render.test.tsx). Interactive behaviour (zoom / rotate /
 * page selection) can't be driven by renderToString and rides on the
 * unit-tested coords + scale math instead; this catches SSR crashes, broken
 * composition, the admin↔phil revision gate, the loud superseded guard, and the
 * honest no-raster fallback.
 */

function makeDoc(
  over: Partial<Document> & { id: string; pages?: unknown[] },
): Document {
  return { url: "https://example.com/x.pdf", ...over } as Document;
}

const rasterPages = [
  { pageIndex: 0, pngUrl: "https://blob/p0.png" },
  { pageIndex: 1, pngUrl: "https://blob/p1.png" },
  { pageIndex: 2, pngUrl: "https://blob/p2.png" },
];

describe("PlansClient — empty + error states", () => {
  it("admin empty state", () => {
    const html = renderToString(
      createElement(PlansClient, { mode: "admin", initialDocuments: [] }),
    );
    expect(html).toContain("No plans uploaded yet");
  });

  it("phil empty state", () => {
    const html = renderToString(
      createElement(PlansClient, { mode: "phil", initialDocuments: [] }),
    );
    expect(html).toContain("No plans for this job yet");
  });

  it("fetch-error state surfaces the error", () => {
    const html = renderToString(
      createElement(PlansClient, {
        mode: "admin",
        initialDocuments: [],
        fetchError: "API returned 503",
      }),
    );
    expect(html).toContain("Couldn");
    expect(html).toContain("API returned 503");
  });
});

describe("PlansClient — admin vs phil revision gate", () => {
  const current = makeDoc({ id: "c", title: "Current Plan", status: "current", pages: rasterPages });
  const superseded = makeDoc({ id: "s", title: "Old Plan", status: "superseded", pages: rasterPages });
  const archived = makeDoc({ id: "a", title: "Dead Plan", status: "archived", pages: rasterPages });

  it("phil sees current only — superseded + archived are filtered out", () => {
    const html = renderToString(
      createElement(PlansClient, {
        mode: "phil",
        initialDocuments: [current, superseded, archived],
      }),
    );
    expect(html).toContain("Current Plan");
    expect(html).not.toContain("Old Plan");
    expect(html).not.toContain("Dead Plan");
    // Nothing superseded is reachable, so the guard never shows for phil.
    expect(html).not.toContain("not for construction");
  });

  it("admin sees current + superseded but never archived", () => {
    const html = renderToString(
      createElement(PlansClient, {
        mode: "admin",
        initialDocuments: [current, superseded, archived],
      }),
    );
    expect(html).toContain("Current Plan");
    expect(html).toContain("Old Plan");
    expect(html).not.toContain("Dead Plan");
    // List status pills are admin-only.
    expect(html).toContain("Superseded");
  });
});

describe("PlanViewer (via PlansClient) — raster, fallback, guard", () => {
  it("renders the raster toolbar + page image + original link for a rastered plan", () => {
    const html = renderToString(
      createElement(PlansClient, {
        mode: "admin",
        initialDocuments: [makeDoc({ id: "c", title: "L1 Power", status: "current", pages: rasterPages })],
      }),
    );
    expect(html).toContain("Fit width");
    expect(html).toContain("Rotate");
    // The default page raster is the lowest pageIndex.
    expect(html).toContain("https://blob/p0.png");
    // Multi-page → page indicator + an open-original link.
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain("Open original");
    // List page-count indicator.
    expect(html).toContain("3 pages");
  });

  it("falls back honestly when a plan has no raster (no fake render)", () => {
    const html = renderToString(
      createElement(PlansClient, {
        mode: "admin",
        initialDocuments: [makeDoc({ id: "c", title: "Spec PDF", status: "current", mimeType: "application/pdf" })],
      }),
    );
    expect(html).toContain("Not available in the in-app viewer");
    expect(html).toContain("Open original PDF");
    // List indicator marks it as not-rasterised.
    expect(html).toContain("Original PDF only");
    // No toolbar when there's nothing to drive.
    expect(html).not.toContain("Fit width");
  });

  it("shows the loud superseded guard when the selected plan is superseded", () => {
    // Single superseded plan → it is the default selection (admin).
    const html = renderToString(
      createElement(PlansClient, {
        mode: "admin",
        initialDocuments: [makeDoc({ id: "s", title: "Old Rev", status: "superseded", pages: rasterPages })],
      }),
    );
    expect(html).toContain("Superseded revision");
    expect(html).toContain("not for construction");
  });
});
