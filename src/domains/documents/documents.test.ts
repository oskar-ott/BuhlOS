import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_STAGES,
  DOCUMENT_STATUSES,
  DocumentCategorySchema,
  DocumentListResponseSchema,
  DocumentSchema,
  DocumentStageSchema,
  DocumentStatusSchema,
  LinkDocumentAreasPayloadSchema,
} from "./schema";
import {
  categoryLabel,
  clauseLabel,
  compareForQueue,
  DANGLING_AREA_LABEL,
  displayTitle,
  drawingContextLine,
  filterSpecsByArea,
  formatFileSize,
  groupByDrawing,
  groupSpecs,
  isArchived,
  isCurrent,
  isSpec,
  isSuperseded,
  mimeTypeLabel,
  normaliseCategory,
  resolveAreaLinks,
  specStageLabel,
  statusLabel,
  statusTone,
} from "./format";
import { listDocuments } from "./client";
import type { Document } from "./types";

/* ----------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------- */

const planA: Document = {
  id: "pl_a1",
  jobId: "birdwood-iv3232",
  fileName: "E-200_rev_a.pdf",
  blobPath: "jobs/birdwood-iv3232/plans/pl_a1.pdf",
  url: "https://example.com/blob/pl_a1.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1_234_567,
  drawingNumber: "E-200",
  revision: "A",
  title: "Switchboard schedule",
  level: "Level 1",
  category: "plan",
  status: "superseded",
  notes: "",
  supersedes: "",
  supersededBy: "pl_a2",
  uploadedAt: "2026-04-01T08:00:00.000Z",
  uploadedBy: "anna",
  uploadedByUserId: "user-admin-1",
};

const planB: Document = {
  ...planA,
  id: "pl_a2",
  fileName: "E-200_rev_b.pdf",
  blobPath: "jobs/birdwood-iv3232/plans/pl_a2.pdf",
  url: "https://example.com/blob/pl_a2.pdf",
  revision: "B",
  status: "current",
  supersedes: "pl_a1",
  supersededBy: "",
  uploadedAt: "2026-05-01T08:00:00.000Z",
};

const planC: Document = {
  id: "pl_c1",
  url: "https://example.com/blob/pl_c1.pdf",
  drawingNumber: "M-100",
  title: "Mech schedule",
  category: "spec",
  status: "current",
  uploadedAt: "2026-05-15T08:00:00.000Z",
};

const archivedPlan: Document = {
  id: "pl_z1",
  url: "https://example.com/blob/pl_z1.pdf",
  drawingNumber: "X-001",
  title: "Old draft",
  status: "archived",
  uploadedAt: "2025-12-01T00:00:00.000Z",
};

/* ----------------------------------------------------------------------
 * Schema — enums
 * -------------------------------------------------------------------- */

describe("Document enum schemas", () => {
  it("DOCUMENT_STATUSES matches api/plans.js VALID_STATUSES", () => {
    expect([...DOCUMENT_STATUSES]).toEqual([
      "current",
      "superseded",
      "archived",
    ]);
  });

  it("DOCUMENT_CATEGORIES matches the legacy upload UI option list", () => {
    expect([...DOCUMENT_CATEGORIES]).toEqual([
      "plan",
      "spec",
      "schedule",
      "photo",
      "certificate",
      "other",
    ]);
  });

  it("rejects unknown status / category values", () => {
    expect(DocumentStatusSchema.safeParse("draft").success).toBe(false);
    expect(DocumentCategorySchema.safeParse("drawing").success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Schema — DocumentSchema + list response
 * -------------------------------------------------------------------- */

describe("DocumentSchema", () => {
  it("accepts a fully populated plan row", () => {
    expect(DocumentSchema.safeParse(planA).success).toBe(true);
  });

  it("accepts a minimal row with just id + url", () => {
    const minimal = { id: "pl_x", url: "https://example.com/x.pdf" };
    expect(DocumentSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects when id or url is missing", () => {
    expect(
      DocumentSchema.safeParse({ url: "https://example.com/x.pdf" }).success,
    ).toBe(false);
    expect(DocumentSchema.safeParse({ id: "pl_x" }).success).toBe(false);
  });

  it("passes through forward-compat fields (Phase 9 AI takeoff)", () => {
    const future: Record<string, unknown> = {
      ...planA,
      pages: [{ pageIndex: 0, pngUrl: "https://x" }],
    };
    const parsed = DocumentSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data as { pages?: Array<{ pageIndex: number }> }).pages?.[0]
          ?.pageIndex,
      ).toBe(0);
    }
  });

  it("tolerates rows without a status field (legacy default 'current')", () => {
    const legacy: Document = { id: "pl_l", url: "https://example.com/l.pdf" };
    expect(DocumentSchema.safeParse(legacy).success).toBe(true);
  });
});

describe("DocumentListResponseSchema", () => {
  it("accepts an empty list", () => {
    expect(DocumentListResponseSchema.safeParse({ plans: [] }).success).toBe(
      true,
    );
  });

  it("accepts a populated list", () => {
    expect(
      DocumentListResponseSchema.safeParse({ plans: [planA, planB, planC] })
        .success,
    ).toBe(true);
  });

  it("rejects when plans isn't an array", () => {
    expect(
      DocumentListResponseSchema.safeParse({ plans: "not an array" }).success,
    ).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Format — labels + tones
 * -------------------------------------------------------------------- */

describe("statusLabel + statusTone", () => {
  it("labels every status", () => {
    expect(statusLabel("current")).toBe("Current");
    expect(statusLabel("superseded")).toBe("Superseded");
    expect(statusLabel("archived")).toBe("Archived");
  });

  it("falls back to 'Current' for missing status (legacy default)", () => {
    expect(statusLabel(undefined)).toBe("Current");
    expect(statusLabel(null)).toBe("Current");
  });

  it("maps statuses to tone", () => {
    expect(statusTone("current")).toBe("success");
    expect(statusTone("superseded")).toBe("info");
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone(undefined)).toBe("success");
    expect(statusTone(null)).toBe("success");
  });
});

describe("categoryLabel + normaliseCategory", () => {
  it("labels known categories", () => {
    expect(categoryLabel("plan")).toBe("Plan");
    expect(categoryLabel("spec")).toBe("Spec");
    expect(categoryLabel("schedule")).toBe("Schedule");
    expect(categoryLabel("photo")).toBe("Photo");
    expect(categoryLabel("certificate")).toBe("Certificate");
    expect(categoryLabel("other")).toBe("Other");
  });

  it("falls back to 'Other' for unknown values", () => {
    expect(categoryLabel("")).toBe("Other");
    expect(categoryLabel(null)).toBe("Other");
    expect(categoryLabel(undefined)).toBe("Other");
    expect(categoryLabel("drawing")).toBe("Other");
    expect(categoryLabel("   ")).toBe("Other");
  });

  it("normalises mixed-case input", () => {
    expect(categoryLabel("PLAN")).toBe("Plan");
    expect(normaliseCategory("Schedule")).toBe("schedule");
    expect(normaliseCategory("WeirdValue")).toBe("other");
  });
});

describe("mimeTypeLabel", () => {
  it("labels common MIME types", () => {
    expect(mimeTypeLabel("application/pdf")).toBe("PDF");
    expect(mimeTypeLabel("image/png")).toBe("PNG");
    expect(mimeTypeLabel("image/jpeg")).toBe("JPG");
    expect(mimeTypeLabel("image/jpg")).toBe("JPG");
    expect(mimeTypeLabel("image/webp")).toBe("WebP");
    expect(mimeTypeLabel("image/heic")).toBe("HEIC");
    expect(mimeTypeLabel("image/svg+xml")).toBe("Image");
    expect(mimeTypeLabel("application/vnd.unknown")).toBe("File");
    expect(mimeTypeLabel(undefined)).toBe("File");
    expect(mimeTypeLabel(null)).toBe("File");
  });
});

describe("formatFileSize", () => {
  it("returns empty for missing or zero bytes", () => {
    expect(formatFileSize(null)).toBe("");
    expect(formatFileSize(undefined)).toBe("");
    expect(formatFileSize(0)).toBe("");
    expect(formatFileSize(-10)).toBe("");
  });

  it("renders bytes / KB / MB", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1_234_567)).toBe("1.2 MB");
  });
});

/* ----------------------------------------------------------------------
 * Format — title + drawing context
 * -------------------------------------------------------------------- */

describe("displayTitle", () => {
  it("prefers title", () => {
    expect(displayTitle(planA)).toBe("Switchboard schedule");
  });

  it("falls back to drawing number", () => {
    const noTitle: Document = { ...planA, title: "" };
    expect(displayTitle(noTitle)).toBe("E-200");
  });

  it("falls back to file name", () => {
    const noTitle: Document = {
      ...planA,
      title: "",
      drawingNumber: "",
    };
    expect(displayTitle(noTitle)).toBe("E-200_rev_a.pdf");
  });

  it("ultimate fallback when nothing identifies the row", () => {
    expect(displayTitle({ id: "pl_x", url: "https://x" })).toBe(
      "(untitled document)",
    );
  });
});

describe("drawingContextLine", () => {
  it("joins drawing + revision + level", () => {
    expect(drawingContextLine(planA)).toBe("E-200 · Rev A · Level 1");
  });

  it("omits missing pieces without stutter", () => {
    expect(drawingContextLine({ id: "x", url: "y", drawingNumber: "E-200" })).toBe(
      "E-200",
    );
    expect(drawingContextLine({ id: "x", url: "y", revision: "C" })).toBe(
      "Rev C",
    );
    expect(drawingContextLine({ id: "x", url: "y", level: "Roof" })).toBe(
      "Roof",
    );
  });

  it("returns empty string when nothing is set", () => {
    expect(drawingContextLine({ id: "x", url: "y" })).toBe("");
  });
});

/* ----------------------------------------------------------------------
 * Format — predicates
 * -------------------------------------------------------------------- */

describe("isCurrent / isSuperseded / isArchived", () => {
  it("isCurrent treats missing status as current", () => {
    expect(isCurrent({ status: "current" })).toBe(true);
    expect(isCurrent({ status: undefined })).toBe(true);
    expect(isCurrent({})).toBe(true);
    expect(isCurrent({ status: "superseded" })).toBe(false);
    expect(isCurrent({ status: "archived" })).toBe(false);
  });

  it("isSuperseded matches only the literal", () => {
    expect(isSuperseded({ status: "superseded" })).toBe(true);
    expect(isSuperseded({ status: "current" })).toBe(false);
    expect(isSuperseded({ status: undefined })).toBe(false);
  });

  it("isArchived matches only the literal", () => {
    expect(isArchived({ status: "archived" })).toBe(true);
    expect(isArchived({ status: "current" })).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Format — sort + group
 * -------------------------------------------------------------------- */

describe("compareForQueue", () => {
  it("sorts current → superseded → archived", () => {
    const rows = [archivedPlan, planA, planC];
    const sorted = rows.slice().sort(compareForQueue);
    expect(sorted.map((r) => r.id)).toEqual(["pl_c1", "pl_a1", "pl_z1"]);
  });

  it("treats missing status as current", () => {
    const noStatus: Document = {
      id: "no",
      url: "https://x",
      uploadedAt: "2026-06-01T00:00:00.000Z",
    };
    const sorted = [noStatus, planA].slice().sort(compareForQueue);
    expect(sorted[0]!.id).toBe("no");
  });

  it("within same status, newest first", () => {
    const older: Document = {
      ...planC,
      id: "pl_old",
      uploadedAt: "2026-01-01T00:00:00Z",
    };
    const sorted = [older, planC].slice().sort(compareForQueue);
    expect(sorted.map((r) => r.id)).toEqual(["pl_c1", "pl_old"]);
  });
});

describe("groupByDrawing", () => {
  it("groups by drawing number, newest revision first within each group", () => {
    const groups = groupByDrawing([planA, planB, planC]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.drawingNumber).toBe("E-200");
    // planB (Rev B, May) is newer than planA (Rev A, April).
    expect(groups[0]!.documents.map((d) => d.id)).toEqual(["pl_a2", "pl_a1"]);
    expect(groups[1]!.drawingNumber).toBe("M-100");
  });

  it("buckets rows without a drawingNumber under null", () => {
    const noDrawing: Document = {
      id: "pl_nd",
      url: "https://x",
      title: "Ad-hoc note",
    };
    const groups = groupByDrawing([planA, noDrawing]);
    expect(groups[0]!.drawingNumber).toBe("E-200");
    expect(groups[1]!.drawingNumber).toBeNull();
    expect(groups[1]!.documents).toHaveLength(1);
  });

  it("preserves first-seen order of distinct drawing numbers", () => {
    const groups = groupByDrawing([planC, planA, planB]);
    expect(groups.map((g) => g.drawingNumber)).toEqual(["M-100", "E-200"]);
  });
});

/* ----------------------------------------------------------------------
 * Client — listDocuments
 * -------------------------------------------------------------------- */

const realFetch = globalThis.fetch;

function mockFetchOnce(response: {
  status: number;
  body: unknown;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: "",
    text: async () => JSON.stringify(response.body),
  } as unknown as Response));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("documentsClient — listDocuments", () => {
  it("issues GET against /api/plans?jobId=X and returns typed data", async () => {
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { plans: [planA, planB] },
    });
    const r = await listDocuments("birdwood-iv3232");
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("/api/plans?jobId=birdwood-iv3232");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.plans).toHaveLength(2);
    }
  });

  it("returns an error result when server returns 403", async () => {
    mockFetchOnce({ status: 403, body: { error: "forbidden" } });
    const r = await listDocuments("birdwood-iv3232");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(403);
  });

  it("returns an error result on schema mismatch", async () => {
    mockFetchOnce({
      status: 200,
      body: { plans: "not an array" },
    });
    const r = await listDocuments("birdwood-iv3232");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/schema/i);
  });
});

/* ----------------------------------------------------------------------
 * #196 — specifications: schema, identity, area linkage, clause label
 * -------------------------------------------------------------------- */

const specKitchen: Document = {
  id: "sp_1",
  url: "https://example.com/blob/sp_1.pdf",
  title: "Kitchen joinery spec",
  category: "spec",
  status: "current",
  level: "Section 7.2",
  areaIds: ["area-kitchen", "area-pantry"],
  areaLinks: [
    { areaId: "area-kitchen", areaName: "Kitchen" },
    { areaId: "area-pantry", areaName: "Pantry" },
  ],
  stage: "fitOff",
  uploadedAt: "2026-06-01T08:00:00.000Z",
};

describe("#196 — stage enum + link payload schema", () => {
  it("DOCUMENT_STAGES mirrors api/evidence.js VALID_STAGES", () => {
    expect([...DOCUMENT_STAGES]).toEqual(["roughIn", "fitOff"]);
    expect(DocumentStageSchema.safeParse("roughIn").success).toBe(true);
    expect(DocumentStageSchema.safeParse("fitOff").success).toBe(true);
    expect(DocumentStageSchema.safeParse("commissioning").success).toBe(false);
  });

  it("DocumentSchema accepts the additive spec linkage fields", () => {
    expect(DocumentSchema.safeParse(specKitchen).success).toBe(true);
  });

  it("DocumentSchema rejects a bad stage value", () => {
    const bad = { ...specKitchen, stage: "nope" };
    expect(DocumentSchema.safeParse(bad).success).toBe(false);
  });

  it("link payload accepts areaIds + optional/nullable stage", () => {
    expect(
      LinkDocumentAreasPayloadSchema.safeParse({
        areaIds: ["a1"],
        stage: "roughIn",
      }).success,
    ).toBe(true);
    expect(
      LinkDocumentAreasPayloadSchema.safeParse({ areaIds: [] }).success,
    ).toBe(true);
    expect(
      LinkDocumentAreasPayloadSchema.safeParse({ areaIds: ["a1"], stage: null })
        .success,
    ).toBe(true);
    expect(
      LinkDocumentAreasPayloadSchema.safeParse({ areaIds: ["a1"], stage: "x" })
        .success,
    ).toBe(false);
    expect(LinkDocumentAreasPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe("isSpec", () => {
  it("matches normalised spec category, not raw drawings", () => {
    expect(isSpec(specKitchen)).toBe(true);
    expect(isSpec({ category: "SPEC" })).toBe(true);
    expect(isSpec({ category: "plan" })).toBe(false);
    expect(isSpec({ category: undefined })).toBe(false);
    expect(isSpec({ category: "drawing" })).toBe(false);
  });
});

describe("specStageLabel + clauseLabel", () => {
  it("labels the two stages, empty otherwise", () => {
    expect(specStageLabel("roughIn")).toBe("Rough-in");
    expect(specStageLabel("fitOff")).toBe("Fit-off");
    expect(specStageLabel(null)).toBe("");
    expect(specStageLabel(undefined)).toBe("");
  });

  it("reads the clause from the level field, trimmed", () => {
    expect(clauseLabel(specKitchen)).toBe("Section 7.2");
    expect(clauseLabel({ level: "  Clause 3  " })).toBe("Clause 3");
    expect(clauseLabel({ level: "" })).toBe("");
    expect(clauseLabel({})).toBe("");
  });
});

describe("filterSpecsByArea", () => {
  const specRoughIn: Document = {
    ...specKitchen,
    id: "sp_2",
    title: "Rough-in spec",
    stage: "roughIn",
    areaIds: ["area-kitchen"],
  };
  const specNoStage: Document = {
    ...specKitchen,
    id: "sp_3",
    title: "Both-stage spec",
    stage: undefined,
    areaIds: ["area-kitchen"],
  };
  const drawing: Document = {
    id: "dr_1",
    url: "https://x",
    category: "plan",
    areaIds: ["area-kitchen"],
  };

  it("returns only specs linked to the area", () => {
    const out = filterSpecsByArea(
      [specKitchen, specRoughIn, drawing],
      "area-kitchen",
    );
    expect(out.map((d) => d.id).sort()).toEqual(["sp_1", "sp_2"]);
    // a non-spec doc with the same areaId never leaks in
    expect(out.some((d) => d.id === "dr_1")).toBe(false);
  });

  it("excludes specs not linked to the area", () => {
    expect(filterSpecsByArea([specKitchen], "area-bathroom")).toHaveLength(0);
  });

  it("a stage filter keeps matching + unstaged specs, drops the other stage", () => {
    const fitOff = filterSpecsByArea(
      [specKitchen, specRoughIn, specNoStage],
      "area-kitchen",
      "fitOff",
    );
    // sp_1 (fitOff) + sp_3 (no stage → governs both); sp_2 (roughIn) dropped
    expect(fitOff.map((d) => d.id).sort()).toEqual(["sp_1", "sp_3"]);
  });
});

describe("groupSpecs", () => {
  it("pulls specs out newest-first, leaving drawings behind", () => {
    const older: Document = {
      ...specKitchen,
      id: "sp_old",
      uploadedAt: "2026-01-01T00:00:00.000Z",
    };
    const drawing: Document = { id: "dr", url: "https://x", category: "plan" };
    const out = groupSpecs([older, specKitchen, drawing]);
    expect(out.map((d) => d.id)).toEqual(["sp_1", "sp_old"]);
  });
});

describe("resolveAreaLinks — denormalise + dangling-link honesty (P7)", () => {
  it("prefers the LIVE area name over the denormalised cache (rename shows through)", () => {
    const live = new Map([
      ["area-kitchen", "Kitchen (renamed)"],
      ["area-pantry", "Pantry"],
    ]);
    const chips = resolveAreaLinks(specKitchen, live);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toMatchObject({
      areaId: "area-kitchen",
      name: "Kitchen (renamed)",
      live: true,
    });
    expect(chips[1]!.live).toBe(true);
  });

  it("labels a dangling link honestly — never a fabricated name, never dropped", () => {
    // area-pantry was removed from the job after linking → not in the live map.
    const live = new Map([["area-kitchen", "Kitchen"]]);
    const chips = resolveAreaLinks(specKitchen, live);
    expect(chips).toHaveLength(2); // both kept, in areaIds order
    expect(chips[1]).toMatchObject({
      areaId: "area-pantry",
      name: DANGLING_AREA_LABEL,
      live: false,
    });
    // the stale denormalised name "Pantry" is NOT shown for a dangling link
    expect(chips[1]!.name).not.toBe("Pantry");
  });

  it("empty when the spec has no areaIds", () => {
    expect(resolveAreaLinks({}, new Map())).toHaveLength(0);
    expect(resolveAreaLinks({ areaIds: [] }, new Map())).toHaveLength(0);
  });
});
