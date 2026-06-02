import { describe, expect, it } from "vitest";
import {
  currentPlans,
  defaultPage,
  findPlan,
  hasRaster,
  isSupersededId,
  pageCount,
  planPages,
  toPlan,
  viewablePlans,
} from "./format";
import type { Document } from "@/domains/documents/types";

/* ----------------------------------------------------------------------
 * The plans domain is a read-only VIEW layer over the documents register
 * (api/plans.js). It does not re-model the register or re-implement the
 * documents status/title/grouping helpers — it adds only viewer-specific
 * logic: typed page extraction, raster-vs-PDF-fallback, current-revision
 * selection (Phil sees current only), and the superseded guard.
 * -------------------------------------------------------------------- */

function makeDoc(over: Partial<Document> & { pages?: unknown[] } = {}): Document {
  return { id: "pl", url: "https://example.com/x.pdf", ...over } as Document;
}

describe("planPages", () => {
  it("extracts a typed page list sorted by pageIndex", () => {
    const doc = makeDoc({
      pages: [
        { pageIndex: 2, pngUrl: "https://b/2.png", sizeBytes: 10 },
        { pageIndex: 0, pngUrl: "https://b/0.png", sha256: "abc" },
        { pageIndex: 1, pngUrl: "https://b/1.png" },
      ],
    });
    expect(planPages(doc).map((p) => p.pageIndex)).toEqual([0, 1, 2]);
    expect(planPages(doc)[0]).toMatchObject({ pageIndex: 0, pngUrl: "https://b/0.png", sha256: "abc" });
  });

  it("skips malformed page entries (no url / bad index / non-object)", () => {
    const doc = makeDoc({
      pages: [
        { pageIndex: 0, pngUrl: "https://b/0.png" },
        { pageIndex: 1 }, // no pngUrl
        { pngUrl: "https://b/x.png" }, // no pageIndex
        null,
        "nope",
      ],
    });
    expect(planPages(doc).map((p) => p.pageIndex)).toEqual([0]);
  });

  it("returns an empty array when pages is missing or not an array", () => {
    expect(planPages(makeDoc())).toEqual([]);
    expect(planPages(makeDoc({ pages: "not-an-array" as unknown as unknown[] }))).toEqual([]);
  });
});

describe("hasRaster / pageCount / defaultPage", () => {
  const rasterised = makeDoc({
    pages: [
      { pageIndex: 1, pngUrl: "https://b/1.png" },
      { pageIndex: 0, pngUrl: "https://b/0.png" },
    ],
  });
  const noRaster = makeDoc();

  it("hasRaster reflects whether any renderable page exists", () => {
    expect(hasRaster(rasterised)).toBe(true);
    expect(hasRaster(noRaster)).toBe(false);
  });

  it("pageCount counts renderable pages", () => {
    expect(pageCount(rasterised)).toBe(2);
    expect(pageCount(noRaster)).toBe(0);
  });

  it("defaultPage is the lowest-index page, or null when not rasterised", () => {
    expect(defaultPage(rasterised)?.pageIndex).toBe(0);
    expect(defaultPage(noRaster)).toBeNull();
  });
});

describe("toPlan", () => {
  it("decorates a document with its typed pages without losing fields", () => {
    const doc = makeDoc({ drawingNumber: "E-200", pages: [{ pageIndex: 0, pngUrl: "https://b/0.png" }] });
    const plan = toPlan(doc);
    expect(plan.drawingNumber).toBe("E-200");
    expect(plan.pages).toHaveLength(1);
  });
});

describe("currentPlans (Phil) vs viewablePlans (admin)", () => {
  const current = makeDoc({ id: "c", status: "current" });
  const legacyNoStatus = makeDoc({ id: "n" });
  const superseded = makeDoc({ id: "s", status: "superseded" });
  const archived = makeDoc({ id: "a", status: "archived" });
  const all = [current, legacyNoStatus, superseded, archived];

  it("currentPlans keeps only current (and legacy no-status) revisions", () => {
    expect(currentPlans(all).map((d) => d.id)).toEqual(["c", "n"]);
  });

  it("viewablePlans keeps current + superseded but drops archived", () => {
    expect(viewablePlans(all).map((d) => d.id)).toEqual(["c", "n", "s"]);
  });
});

describe("findPlan / isSupersededId (superseded guard)", () => {
  const current = makeDoc({ id: "c", status: "current" });
  const superseded = makeDoc({ id: "s", status: "superseded" });
  const docs = [current, superseded];

  it("findPlan returns the matching row or null", () => {
    expect(findPlan(docs, "s")?.id).toBe("s");
    expect(findPlan(docs, "missing")).toBeNull();
  });

  it("isSupersededId is true only for a superseded row that exists", () => {
    expect(isSupersededId(docs, "s")).toBe(true);
    expect(isSupersededId(docs, "c")).toBe(false);
    expect(isSupersededId(docs, "missing")).toBe(false);
  });
});
