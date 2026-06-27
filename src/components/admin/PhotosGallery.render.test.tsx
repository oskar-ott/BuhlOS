import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhotosGallery, type SourceLoadError } from "./PhotosGallery";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { PhotoCatalogEntry } from "@/domains/evidence/photo-gallery";
import type { Job } from "@/domains/jobs/types";

const JOB = { id: "job-1", name: "Lot 4 fitout" } as unknown as Job;

function ev(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev-1",
    jobId: "job-1",
    kind: "photo",
    photoId: "p1",
    photoUrl: "https://blob/p1.jpg",
    thumbnailUrl: null,
    status: "submitted",
    source: "phil",
    capturedById: "u1",
    capturedByName: "Jack",
    capturedAt: "2026-06-03T09:00:00Z",
    areaId: null,
    stage: null,
    taskId: null,
    auditLogIds: [],
    createdAt: "2026-06-03T09:00:00Z",
    updatedAt: "2026-06-03T09:00:00Z",
    ...over,
  } as unknown as EvidenceItem;
}

function snag(over: Partial<PhotoCatalogEntry> = {}): PhotoCatalogEntry {
  return {
    source: "snag",
    id: "sp-1",
    url: "https://blob/snag1.jpg",
    addedBy: "Sam",
    addedAt: "2026-06-02T08:00:00Z",
    snagId: "snag-9",
    snagDesc: "Meter-box not sealed",
    dwellingName: "Lot 4",
    ...over,
  } as PhotoCatalogEntry;
}

function render(props: {
  evidence?: EvidenceItem[];
  catalog?: PhotoCatalogEntry[];
  sourceErrors?: SourceLoadError[];
  areaNameById?: Record<string, string>;
}): string {
  return renderToString(
    createElement(PhotosGallery, {
      job: JOB,
      evidence: props.evidence ?? [],
      catalog: props.catalog ?? [],
      sourceErrors: props.sourceErrors ?? [],
      areaNameById: props.areaNameById ?? {},
    }),
  );
}

describe("PhotosGallery", () => {
  it("shows an honest empty state when there are no photos", () => {
    const html = render({});
    expect(html).toContain("No photos on this job yet");
    expect(html).toContain("Showing");
    // React inserts comment markers between text + interpolation, so the
    // "of 0 photos" segments aren't contiguous — assert the count alone.
    expect(html).toContain(">0<");
  });

  it("renders evidence + snag photos with provenance and source chips", () => {
    const html = render({
      evidence: [ev({ id: "a", stage: "roughIn", areaId: "area-7" })],
      catalog: [snag()],
      areaNameById: { "area-7": "Kitchen" },
    });
    // Real counts from real records (AC5). React inserts a comment marker
    // between the count and the label, so assert the label segment.
    expect(html).toContain(" evidence");
    expect(html).toContain(" snag");
    // Provenance lines (AC2).
    expect(html).toContain("Rough-in · Kitchen");
    expect(html).toContain("Snag: Meter-box not sealed · Lot 4");
    // Source chips name the category.
    expect(html).toContain("Evidence");
    expect(html).toContain("Snag");
  });

  it("renders the snag photo Blob URL in the grid", () => {
    const html = render({ catalog: [snag({ url: "https://blob/x.jpg" })] });
    expect(html).toContain("https://blob/x.jpg");
  });

  it("groups by capture day with a human heading", () => {
    const html = render({
      evidence: [ev({ id: "a", capturedAt: "2026-06-03T09:00:00Z" })],
    });
    expect(html).toContain("June");
    expect(html).toContain("2026");
  });

  it("names the undated bucket honestly", () => {
    const html = render({ catalog: [snag({ id: "u", addedAt: "" })] });
    expect(html).toContain("No date recorded");
  });

  it("surfaces a per-source load error as an honest note (no silent gap)", () => {
    const html = render({
      sourceErrors: [
        { label: "snag & ITP / dwelling", message: "Catalog API returned 502" },
      ],
    });
    // React splits the heading around the interpolated label; assert the
    // surrounding copy + the label segment separately.
    expect(html).toContain("Couldn’t load");
    expect(html).toContain("snag &amp; ITP / dwelling");
    expect(html).toContain("Catalog API returned 502");
  });

  it("renders the read-only badge (browse surface, not a review queue)", () => {
    const html = render({ evidence: [ev()] });
    expect(html).toContain("Read-only");
  });

  it("does not fabricate counts on an empty source error", () => {
    const html = render({
      sourceErrors: [{ label: "evidence", message: "boom" }],
    });
    // Empty state, no fabricated source chips.
    expect(html).toContain("No photos on this job yet");
    expect(html).not.toContain("1 evidence");
  });
});
