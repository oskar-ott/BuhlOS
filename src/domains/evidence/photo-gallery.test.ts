import { describe, expect, it } from "vitest";
import {
  buildGalleryPhotos,
  EMPTY_GALLERY_FILTER,
  galleryUploaders,
  groupPhotosByDay,
  matchesGalleryFilter,
  PhotoCatalogResponseSchema,
  sourceKindLabel,
  type GalleryFilter,
  type GalleryPhoto,
  type PhotoCatalogEntry,
} from "./photo-gallery";
import type { EvidenceItem } from "./types";

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

function snagPhoto(over: Partial<PhotoCatalogEntry> = {}): PhotoCatalogEntry {
  return {
    source: "snag",
    id: "sp-1",
    url: "https://blob/snag1.jpg",
    addedBy: "Sam",
    addedAt: "2026-06-02T08:00:00Z",
    snagId: "snag-9",
    snagDesc: "Meter-box not sealed",
    snagPriority: "High",
    snagStatus: "Open",
    dwellingId: "lot-4",
    dwellingName: "Lot 4",
    ...over,
  } as PhotoCatalogEntry;
}

function dwellingPhoto(over: Partial<PhotoCatalogEntry> = {}): PhotoCatalogEntry {
  return {
    source: "dwelling",
    id: "dp-1",
    url: "https://blob/dw1.jpg",
    addedBy: "Anna",
    addedAt: "2026-06-01T07:00:00Z",
    dwellingId: "unit-2",
    dwellingName: "Unit 2",
    stage: "roughIn",
    ...over,
  } as PhotoCatalogEntry;
}

describe("buildGalleryPhotos", () => {
  it("merges evidence + catalog into one model, newest first", () => {
    const photos = buildGalleryPhotos({
      evidence: [ev({ id: "a", capturedAt: "2026-06-03T09:00:00Z" })],
      catalog: [
        snagPhoto({ id: "s", addedAt: "2026-06-02T08:00:00Z" }),
        dwellingPhoto({ id: "d", addedAt: "2026-06-04T10:00:00Z" }),
      ],
    });
    expect(photos.map((p) => p.id)).toEqual([
      "itp:d", // 4 Jun
      "evidence:a", // 3 Jun
      "snag:s", // 2 Jun
    ]);
    expect(photos.map((p) => p.sourceKind)).toEqual(["itp", "evidence", "snag"]);
  });

  it("namespaces ids by source so an evidence id can't collide with a snag id", () => {
    const photos = buildGalleryPhotos({
      evidence: [ev({ id: "x" })],
      catalog: [snagPhoto({ id: "x", snagId: "x" })],
    });
    const ids = photos.map((p) => p.id);
    expect(ids).toContain("evidence:x");
    expect(ids).toContain("snag:x");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the evidence row ONLY for evidence photos (drawer reuse)", () => {
    const photos = buildGalleryPhotos({
      evidence: [ev({ id: "a" })],
      catalog: [snagPhoto(), dwellingPhoto()],
    });
    const evidencePhoto = photos.find((p) => p.sourceKind === "evidence");
    const snag = photos.find((p) => p.sourceKind === "snag");
    const itp = photos.find((p) => p.sourceKind === "itp");
    expect(evidencePhoto?.evidenceItem).not.toBeNull();
    expect(snag?.evidenceItem).toBeNull();
    expect(itp?.evidenceItem).toBeNull();
    // The snag deep-link target is carried; ITP/dwelling has none.
    expect(snag?.snagId).toBe("snag-9");
    expect(itp?.snagId).toBeNull();
  });

  it("resolves the evidence area id to a name in the provenance line", () => {
    const photos = buildGalleryPhotos({
      evidence: [ev({ id: "a", stage: "roughIn", areaId: "area-7" })],
      catalog: [],
      areaNameById: { "area-7": "Kitchen" },
    });
    expect(photos[0]?.provenance).toBe("Rough-in · Kitchen");
  });

  it("labels the unsplit dwelling/ITP source honestly (named gap)", () => {
    const photos = buildGalleryPhotos({
      evidence: [],
      catalog: [dwellingPhoto({ stage: "fitOff", dwellingName: "Unit 9" })],
    });
    expect(photos[0]?.provenance).toBe("ITP / dwelling · Fit-off · Unit 9");
    expect(photos[0]?.sourceKind).toBe("itp");
  });

  it("includes evidence notes as isNote with no url (no broken tile)", () => {
    const photos = buildGalleryPhotos({
      evidence: [ev({ id: "n", kind: "note", photoUrl: null, note: "done" })],
      catalog: [],
    });
    expect(photos[0]?.isNote).toBe(true);
    expect(photos[0]?.url).toBe("");
  });

  it("drops a photo evidence row with no url rather than rendering a broken tile", () => {
    const photos = buildGalleryPhotos({
      evidence: [ev({ id: "broken", kind: "photo", photoUrl: null })],
      catalog: [],
    });
    expect(photos).toHaveLength(0);
  });

  it("drops client-only uploading / pending_sync rows", () => {
    const photos = buildGalleryPhotos({
      evidence: [
        ev({ id: "u", status: "uploading" }),
        ev({ id: "p", status: "pending_sync" }),
        ev({ id: "ok", status: "reviewed" }),
      ],
      catalog: [],
    });
    expect(photos.map((p) => p.id)).toEqual(["evidence:ok"]);
  });

  it("reads admin/system evidence as office, phil as field; catalog always field", () => {
    const photos = buildGalleryPhotos({
      evidence: [
        ev({ id: "f", source: "phil" }),
        ev({ id: "o", source: "admin" }),
        ev({ id: "s", source: "system" }),
      ],
      catalog: [snagPhoto({ id: "c" })],
    });
    const side = (id: string) => photos.find((p) => p.id === id)?.provenanceSide;
    expect(side("evidence:f")).toBe("field");
    expect(side("evidence:o")).toBe("office");
    expect(side("evidence:s")).toBe("office");
    expect(side("snag:c")).toBe("field");
  });

  it("falls back to the uploader id when no name is recorded", () => {
    const photos = buildGalleryPhotos({
      evidence: [ev({ id: "a", capturedByName: "", capturedById: "u-42" })],
      catalog: [],
    });
    expect(photos[0]?.uploader).toBe("u-42");
    expect(photos[0]?.uploaderKey).toBe("u-42");
  });
});

describe("groupPhotosByDay", () => {
  it("buckets by capture day, newest day first", () => {
    const photos = buildGalleryPhotos({
      evidence: [
        ev({ id: "a", capturedAt: "2026-06-03T09:00:00Z" }),
        ev({ id: "b", capturedAt: "2026-06-03T18:00:00Z" }),
        ev({ id: "c", capturedAt: "2026-06-01T07:00:00Z" }),
      ],
      catalog: [],
    });
    const groups = groupPhotosByDay(photos);
    expect(groups.map((g) => g.day)).toEqual(["2026-06-03", "2026-06-01"]);
    expect(groups[0]?.photos).toHaveLength(2);
    expect(groups[1]?.photos).toHaveLength(1);
  });

  it("collects undated photos under the empty-day key, sorted last", () => {
    const undated: GalleryPhoto = {
      id: "x:1",
      url: "https://blob/x.jpg",
      thumbnailUrl: null,
      capturedAt: "",
      uploader: "Unknown",
      uploaderKey: "unknown",
      provenance: "ITP / dwelling photo",
      sourceKind: "itp",
      isNote: false,
      provenanceSide: "field",
      evidenceItem: null,
      snagId: null,
    };
    const dated = buildGalleryPhotos({
      evidence: [ev({ id: "a", capturedAt: "2026-06-03T09:00:00Z" })],
      catalog: [],
    });
    const groups = groupPhotosByDay([...dated, undated]);
    expect(groups[groups.length - 1]?.day).toBe("");
    expect(groups[groups.length - 1]?.photos[0]?.id).toBe("x:1");
  });
});

describe("matchesGalleryFilter", () => {
  const base = buildGalleryPhotos({
    evidence: [
      ev({ id: "p1", source: "phil", kind: "photo", capturedAt: "2026-06-03T09:00:00Z", capturedById: "u1", capturedByName: "Jack" }),
      ev({ id: "n1", source: "admin", kind: "note", photoUrl: null, note: "x", capturedAt: "2026-06-02T09:00:00Z", capturedById: "u2", capturedByName: "Anna" }),
    ],
    catalog: [snagPhoto({ id: "s1", addedAt: "2026-06-01T09:00:00Z", addedBy: "Sam" })],
  });

  function only(filter: Partial<GalleryFilter>): string[] {
    const f: GalleryFilter = { ...EMPTY_GALLERY_FILTER, ...filter };
    return base.filter((p) => matchesGalleryFilter(p, f)).map((p) => p.id);
  }

  it("empty filter matches everything", () => {
    expect(only({})).toHaveLength(3);
  });

  it("filters by date range inclusive", () => {
    expect(only({ fromDate: "2026-06-02", toDate: "2026-06-03" })).toEqual([
      "evidence:p1",
      "evidence:n1",
    ]);
  });

  it("filters by uploader key", () => {
    expect(only({ uploaderKey: "u1" })).toEqual(["evidence:p1"]);
    expect(only({ uploaderKey: "Sam" })).toEqual(["snag:s1"]);
  });

  it("filters by field/office provenance", () => {
    expect(only({ side: "field" })).toEqual(["evidence:p1", "snag:s1"]);
    expect(only({ side: "office" })).toEqual(["evidence:n1"]);
  });

  it("filters by photo/note kind", () => {
    expect(only({ kind: "note" })).toEqual(["evidence:n1"]);
    expect(only({ kind: "photo" })).toEqual(["evidence:p1", "snag:s1"]);
  });

  it("filters by source kind", () => {
    expect(only({ sourceKind: "snag" })).toEqual(["snag:s1"]);
    expect(only({ sourceKind: "evidence" })).toEqual(["evidence:p1", "evidence:n1"]);
  });

  it("excludes undated photos the moment any date bound is set", () => {
    const undatedOnly = buildGalleryPhotos({
      evidence: [],
      catalog: [dwellingPhoto({ id: "d", addedAt: "" })],
    });
    const f: GalleryFilter = { ...EMPTY_GALLERY_FILTER, fromDate: "2026-01-01" };
    expect(undatedOnly.filter((p) => matchesGalleryFilter(p, f))).toHaveLength(0);
  });
});

describe("galleryUploaders", () => {
  it("returns distinct uploaders sorted by name", () => {
    const photos = buildGalleryPhotos({
      evidence: [
        ev({ id: "a", capturedById: "u1", capturedByName: "Zoe" }),
        ev({ id: "b", capturedById: "u1", capturedByName: "Zoe" }),
        ev({ id: "c", capturedById: "u2", capturedByName: "Anna" }),
      ],
      catalog: [],
    });
    expect(galleryUploaders(photos)).toEqual([
      { key: "u2", name: "Anna" },
      { key: "u1", name: "Zoe" },
    ]);
  });
});

describe("sourceKindLabel", () => {
  it("labels every source kind", () => {
    expect(sourceKindLabel("evidence")).toBe("Evidence");
    expect(sourceKindLabel("snag")).toBe("Snag");
    expect(sourceKindLabel("itp")).toBe("ITP / dwelling");
  });
});

describe("PhotoCatalogResponseSchema", () => {
  it("parses the documented api/photos-catalog.js shape", () => {
    const parsed = PhotoCatalogResponseSchema.safeParse({
      jobId: "job-1",
      jobName: "Lot 4 fitout",
      counts: { total: 2, snag: 1, dwelling: 1 },
      photos: [snagPhoto(), dwellingPhoto()],
    });
    expect(parsed.success).toBe(true);
  });

  it("tolerates a missing counts block and extra fields (passthrough)", () => {
    const parsed = PhotoCatalogResponseSchema.safeParse({
      jobId: "job-1",
      photos: [{ source: "snag", id: "s", url: "u", futureField: 1 }],
    });
    expect(parsed.success).toBe(true);
  });
});
