import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateEvidencePayloadSchema,
  EVIDENCE_KINDS,
  EVIDENCE_NOTE_MAX,
  EVIDENCE_SOURCES,
  EVIDENCE_STAGES,
  EVIDENCE_STATUSES,
  EvidenceCreateResponseSchema,
  EvidenceItemSchema,
  EvidenceListResponseSchema,
  EvidenceReviewResponseSchema,
  REJECTION_REASON_MAX,
  ReviewEvidencePayloadSchema,
  SERVER_EVIDENCE_STATUSES,
} from "./schema";
import { kindLabel, stageLabel, statusLabel, statusTone } from "./format";
import { canTransition, humanFileSize } from "./service";
import { createEvidence, listEvidence, reviewEvidence } from "./client";

/* ----------------------------------------------------------------------
 * Schema — EvidenceItem
 * -------------------------------------------------------------------- */

const baseItem = {
  id: "ev_12345678",
  jobId: "birdwood-iv3232",
  areaId: null,
  stage: null,
  taskId: null,
  kind: "note" as const,
  photoId: null,
  photoUrl: null,
  thumbnailUrl: null,
  note: "Cabling looks good",
  capturedById: "user-tradie-1",
  capturedByName: "Sam",
  capturedByRole: "tradie",
  capturedAt: "2026-05-25T14:30:00.000Z",
  clientCapturedAt: null,
  exifLocation: null,
  status: "submitted" as const,
  source: "phil" as const,
  reviewedById: null,
  reviewedByName: null,
  reviewedAt: null,
  rejectionReason: null,
  auditLogIds: ["al_abc12345"],
  createdAt: "2026-05-25T14:30:00.000Z",
  updatedAt: "2026-05-25T14:30:00.000Z",
};

describe("EvidenceItemSchema", () => {
  it("accepts a minimal note item", () => {
    expect(EvidenceItemSchema.safeParse(baseItem).success).toBe(true);
  });

  it("accepts a photo item with photoId + photoUrl", () => {
    const photo = {
      ...baseItem,
      areaId: "ar_abc",
      stage: "roughIn" as const,
      taskId: "rt_xyz",
      kind: "photo" as const,
      photoId: "ph_123",
      photoUrl: "https://blob.example/photo.jpg",
      thumbnailUrl: "https://blob.example/photo.jpg",
      note: "Cabling visible",
      exifLocation: { lat: -33.86, lng: 151.21 },
    };
    expect(EvidenceItemSchema.safeParse(photo).success).toBe(true);
  });

  it("rejects a photo item missing photoId", () => {
    const broken = {
      ...baseItem,
      kind: "photo" as const,
      photoId: null,
      photoUrl: "https://blob.example/photo.jpg",
    };
    expect(EvidenceItemSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a photo item missing photoUrl", () => {
    const broken = {
      ...baseItem,
      kind: "photo" as const,
      photoId: "ph_123",
      photoUrl: null,
    };
    expect(EvidenceItemSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts reviewed item (D4 will write this shape)", () => {
    const reviewed = {
      ...baseItem,
      status: "reviewed" as const,
      reviewedById: "user-admin-1",
      reviewedByName: "Anna",
      reviewedAt: "2026-05-26T09:15:00.000Z",
    };
    expect(EvidenceItemSchema.safeParse(reviewed).success).toBe(true);
  });

  it("accepts rejected item with rejectionReason", () => {
    const rejected = {
      ...baseItem,
      status: "rejected" as const,
      reviewedById: "user-admin-1",
      reviewedByName: "Anna",
      reviewedAt: "2026-05-26T09:15:00.000Z",
      rejectionReason: "Wrong area — please re-capture in Kitchen",
    };
    expect(EvidenceItemSchema.safeParse(rejected).success).toBe(true);
  });

  it("rejects rejected item without rejectionReason", () => {
    const broken = {
      ...baseItem,
      status: "rejected" as const,
      rejectionReason: null,
    };
    expect(EvidenceItemSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects rejected item with whitespace-only rejectionReason", () => {
    const broken = {
      ...baseItem,
      status: "rejected" as const,
      rejectionReason: "   ",
    };
    expect(EvidenceItemSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects when required fields are missing", () => {
    const cases = [
      "id",
      "jobId",
      "kind",
      "capturedById",
      "capturedByName",
      "capturedAt",
      "status",
      "source",
      "auditLogIds",
      "createdAt",
      "updatedAt",
    ];
    for (const f of cases) {
      const broken = { ...baseItem } as Record<string, unknown>;
      delete broken[f];
      expect(EvidenceItemSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects unknown status / kind / stage / source values", () => {
    expect(EvidenceItemSchema.safeParse({ ...baseItem, status: "pending" }).success).toBe(false);
    expect(EvidenceItemSchema.safeParse({ ...baseItem, kind: "file" }).success).toBe(false);
    expect(EvidenceItemSchema.safeParse({ ...baseItem, source: "import" }).success).toBe(false);
    expect(EvidenceItemSchema.safeParse({ ...baseItem, stage: "commission" }).success).toBe(false);
  });

  it("status enum includes the doc-28 client-only states", () => {
    // Client emits uploading + pending_sync; the schema must accept
    // them so a client-side preview render doesn't fail parsing.
    expect(EvidenceItemSchema.safeParse({ ...baseItem, status: "uploading" }).success).toBe(true);
    expect(EvidenceItemSchema.safeParse({ ...baseItem, status: "pending_sync" }).success).toBe(true);
  });

  it("auditLogIds must be an array of strings", () => {
    expect(EvidenceItemSchema.safeParse({ ...baseItem, auditLogIds: [] }).success).toBe(true);
    expect(EvidenceItemSchema.safeParse({ ...baseItem, auditLogIds: ["a", "b"] }).success).toBe(
      true
    );
    expect(EvidenceItemSchema.safeParse({ ...baseItem, auditLogIds: [1, 2] }).success).toBe(false);
    expect(EvidenceItemSchema.safeParse({ ...baseItem, auditLogIds: null }).success).toBe(false);
  });

  it("passes through unknown forward-compat fields (.passthrough)", () => {
    const future = {
      ...baseItem,
      voiceNoteUrl: "https://example/audio.mp3",
      reviewerNotes: "Looks fine",
    };
    const parsed = EvidenceItemSchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { voiceNoteUrl?: string }).voiceNoteUrl).toBe(
        "https://example/audio.mp3"
      );
    }
  });

  it("enum exports stay in sync with the documented values", () => {
    expect([...EVIDENCE_KINDS].sort()).toEqual(["note", "photo"]);
    expect([...EVIDENCE_STAGES].sort()).toEqual(["fitOff", "roughIn"]);
    expect([...EVIDENCE_STATUSES].sort()).toEqual([
      "pending_sync",
      "rejected",
      "reviewed",
      "submitted",
      "uploading",
    ]);
    expect([...SERVER_EVIDENCE_STATUSES].sort()).toEqual(["rejected", "reviewed", "submitted"]);
    expect([...EVIDENCE_SOURCES].sort()).toEqual(["admin", "phil", "system"]);
    expect(EVIDENCE_NOTE_MAX).toBe(280);
    expect(REJECTION_REASON_MAX).toBe(500);
  });
});

/* ----------------------------------------------------------------------
 * Schema — CreateEvidencePayload
 * -------------------------------------------------------------------- */

describe("CreateEvidencePayloadSchema", () => {
  it("accepts a minimal note payload", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "note",
      note: "Cabling looks good",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a photo payload with photoId + photoUrl", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "photo",
      photoId: "ph_abc",
      photoUrl: "https://blob.example/p.jpg",
    });
    expect(r.success).toBe(true);
  });

  it("rejects photo payload missing photoId", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "photo",
      photoUrl: "https://blob.example/p.jpg",
    });
    expect(r.success).toBe(false);
  });

  it("rejects photo payload missing photoUrl", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "photo",
      photoId: "ph_abc",
    });
    expect(r.success).toBe(false);
  });

  it("rejects note payload with empty note (whitespace-only)", () => {
    const r1 = CreateEvidencePayloadSchema.safeParse({ kind: "note" });
    expect(r1.success).toBe(false);
    const r2 = CreateEvidencePayloadSchema.safeParse({ kind: "note", note: "   " });
    expect(r2.success).toBe(false);
    const r3 = CreateEvidencePayloadSchema.safeParse({ kind: "note", note: "" });
    expect(r3.success).toBe(false);
  });

  it("rejects note longer than EVIDENCE_NOTE_MAX", () => {
    const longNote = "x".repeat(EVIDENCE_NOTE_MAX + 1);
    const r = CreateEvidencePayloadSchema.safeParse({ kind: "note", note: longNote });
    expect(r.success).toBe(false);
  });

  it("accepts note exactly at EVIDENCE_NOTE_MAX", () => {
    const maxNote = "x".repeat(EVIDENCE_NOTE_MAX);
    const r = CreateEvidencePayloadSchema.safeParse({ kind: "note", note: maxNote });
    expect(r.success).toBe(true);
  });

  it("rejects unknown kind", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "video" as unknown as "note",
      note: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects taskId without stage", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "note",
      note: "x",
      taskId: "rt_abc",
    });
    expect(r.success).toBe(false);
  });

  it("accepts taskId when stage is also provided", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "note",
      note: "x",
      taskId: "rt_abc",
      stage: "roughIn",
      areaId: "ar_1",
    });
    expect(r.success).toBe(true);
  });

  it("accepts exifLocation when both lat and lng are numeric", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "photo",
      photoId: "ph_1",
      photoUrl: "https://x/y.jpg",
      exifLocation: { lat: -33.86, lng: 151.21 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects exifLocation when either coord is non-numeric", () => {
    const r = CreateEvidencePayloadSchema.safeParse({
      kind: "photo",
      photoId: "ph_1",
      photoUrl: "https://x/y.jpg",
      exifLocation: { lat: "bad", lng: 151.21 },
    });
    expect(r.success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Schema — ReviewEvidencePayload
 * -------------------------------------------------------------------- */

describe("ReviewEvidencePayloadSchema", () => {
  it("accepts a 'reviewed' transition without a reason", () => {
    const r = ReviewEvidencePayloadSchema.safeParse({
      evidenceId: "ev_abc12345",
      status: "reviewed",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a 'rejected' transition with a reason", () => {
    const r = ReviewEvidencePayloadSchema.safeParse({
      evidenceId: "ev_abc12345",
      status: "rejected",
      rejectionReason: "Wrong area",
    });
    expect(r.success).toBe(true);
  });

  it("rejects 'rejected' transition without rejectionReason", () => {
    const r = ReviewEvidencePayloadSchema.safeParse({
      evidenceId: "ev_abc12345",
      status: "rejected",
    });
    expect(r.success).toBe(false);
  });

  it("rejects 'rejected' transition with whitespace-only reason", () => {
    const r = ReviewEvidencePayloadSchema.safeParse({
      evidenceId: "ev_abc12345",
      status: "rejected",
      rejectionReason: "   ",
    });
    expect(r.success).toBe(false);
  });

  it("rejects rejectionReason longer than REJECTION_REASON_MAX", () => {
    const longReason = "x".repeat(REJECTION_REASON_MAX + 1);
    const r = ReviewEvidencePayloadSchema.safeParse({
      evidenceId: "ev_abc12345",
      status: "rejected",
      rejectionReason: longReason,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown status", () => {
    const r = ReviewEvidencePayloadSchema.safeParse({
      evidenceId: "ev_abc12345",
      status: "deleted",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty evidenceId", () => {
    const r = ReviewEvidencePayloadSchema.safeParse({
      evidenceId: "",
      status: "reviewed",
    });
    expect(r.success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Schema — response wrappers
 * -------------------------------------------------------------------- */

describe("response schemas", () => {
  it("parses an empty list response", () => {
    expect(EvidenceListResponseSchema.safeParse({ evidence: [] }).success).toBe(true);
  });

  it("parses a list response with one item", () => {
    expect(EvidenceListResponseSchema.safeParse({ evidence: [baseItem] }).success).toBe(true);
  });

  it("parses a create response with the canonical item", () => {
    const r = EvidenceCreateResponseSchema.safeParse({ evidenceItem: baseItem });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.evidenceItem.status).toBe("submitted");
    }
  });

  it("parses a review response (same shape as create)", () => {
    const r = EvidenceReviewResponseSchema.safeParse({
      evidenceItem: {
        ...baseItem,
        status: "reviewed",
        reviewedById: "user-admin-1",
        reviewedByName: "Anna",
        reviewedAt: "2026-05-26T09:00:00.000Z",
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a create response shaped like the list response", () => {
    const r = EvidenceCreateResponseSchema.safeParse({ evidence: [baseItem] });
    expect(r.success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Format helpers
 * -------------------------------------------------------------------- */

describe("format helpers", () => {
  it("statusLabel covers every status (server + client-only)", () => {
    expect(statusLabel("uploading")).toBe("Uploading…");
    expect(statusLabel("pending_sync")).toBe("Pending sync");
    expect(statusLabel("submitted")).toBe("Submitted");
    expect(statusLabel("reviewed")).toBe("Reviewed");
    expect(statusLabel("rejected")).toBe("Rejected");
  });

  it("statusTone maps to the doc 27 §6.2 palette", () => {
    expect(statusTone("uploading")).toBe("info");
    expect(statusTone("pending_sync")).toBe("info");
    expect(statusTone("submitted")).toBe("info");
    expect(statusTone("reviewed")).toBe("success");
    expect(statusTone("rejected")).toBe("danger");
  });

  it("kindLabel and stageLabel render human strings", () => {
    expect(kindLabel("photo")).toBe("Photo");
    expect(kindLabel("note")).toBe("Note");
    expect(stageLabel("roughIn")).toBe("Rough-in");
    expect(stageLabel("fitOff")).toBe("Fit-off");
  });
});

/* ----------------------------------------------------------------------
 * Service — canTransition state machine + humanFileSize
 * -------------------------------------------------------------------- */

describe("service.canTransition (doc 28 §A.2 state machine)", () => {
  it("allows null → submitted (create)", () => {
    expect(canTransition(null, "submitted")).toBe(true);
  });

  it("allows submitted → reviewed (admin mark reviewed)", () => {
    expect(canTransition("submitted", "reviewed")).toBe(true);
  });

  it("allows submitted → rejected (admin reject)", () => {
    expect(canTransition("submitted", "rejected")).toBe(true);
  });

  it("allows reviewed → submitted (admin un-review)", () => {
    expect(canTransition("reviewed", "submitted")).toBe(true);
  });

  it("rejects every other (from, to) pair", () => {
    const FROMS = [null, "submitted", "reviewed", "rejected"] as const;
    const TOS = ["submitted", "reviewed", "rejected"] as const;
    const ALLOWED = new Set([
      "null→submitted",
      "submitted→reviewed",
      "submitted→rejected",
      "reviewed→submitted",
    ]);
    for (const from of FROMS) {
      for (const to of TOS) {
        const key = `${from ?? "null"}→${to}`;
        const expected = ALLOWED.has(key);
        expect(canTransition(from, to)).toBe(expected);
      }
    }
  });
});

describe("service.humanFileSize", () => {
  it("formats bytes < 1 KB", () => {
    expect(humanFileSize(0)).toBe("0 B");
    expect(humanFileSize(512)).toBe("512 B");
    expect(humanFileSize(1023)).toBe("1023 B");
  });

  it("formats KB / MB / GB with 1 dp under 100", () => {
    expect(humanFileSize(1024)).toBe("1.0 KB");
    expect(humanFileSize(2560)).toBe("2.5 KB");
    expect(humanFileSize(1024 * 1024)).toBe("1.0 MB");
    expect(humanFileSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("drops decimal at ≥ 100 units", () => {
    expect(humanFileSize(150 * 1024)).toBe("150 KB");
  });

  it("returns 0 B for invalid inputs", () => {
    expect(humanFileSize(NaN)).toBe("0 B");
    expect(humanFileSize(-1)).toBe("0 B");
    expect(humanFileSize(Infinity)).toBe("0 B");
  });
});

/* ----------------------------------------------------------------------
 * Client — list + create + review wrappers (mocked fetch)
 * -------------------------------------------------------------------- */

describe("evidence client wrappers", () => {
  const origFetch = globalThis.fetch;
  let fetchCalls: Array<[string, RequestInit | undefined]>;

  function installFetch(make: () => Response): void {
    fetchCalls = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([String(input), init]);
      return Promise.resolve(make());
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("listEvidence hits /api/evidence?jobId=<id> with no-store", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ evidence: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );

    const r = await listEvidence("birdwood-iv3232");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.evidence).toEqual([]);

    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toBe("/api/evidence?jobId=birdwood-iv3232");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("same-origin");
  });

  it("listEvidence URL-encodes the jobId", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ evidence: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    await listEvidence("job with/slash");
    expect(fetchCalls[0]![0]).toBe("/api/evidence?jobId=job%20with%2Fslash");
  });

  it("listEvidence surfaces a 401 as ok:false", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error: "not authenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await listEvidence("birdwood-iv3232");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(401);
  });

  it("createEvidence refuses to call the server with an invalid payload", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await createEvidence("birdwood-iv3232", {
      kind: "note",
      // intentionally empty — fails superRefine
    });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("createEvidence POSTs a valid note payload and parses the canonical response", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ evidenceItem: baseItem }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await createEvidence("birdwood-iv3232", {
      kind: "note",
      note: "Cabling looks good",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.evidenceItem.kind).toBe("note");
      expect(r.data.evidenceItem.status).toBe("submitted");
    }
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]![1]?.method).toBe("POST");
  });

  it("createEvidence surfaces a 403 from the server", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error: "no write access to job" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await createEvidence("birdwood-iv3232", {
      kind: "note",
      note: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(403);
  });

  it("createEvidence surfaces a schema mismatch as ok:false", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ wrong: "shape" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await createEvidence("birdwood-iv3232", {
      kind: "note",
      note: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("response schema mismatch");
  });

  it("reviewEvidence refuses to call the server with empty evidenceId", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await reviewEvidence("birdwood-iv3232", {
      evidenceId: "",
      status: "reviewed",
    });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("reviewEvidence refuses to call the server when rejecting without reason", async () => {
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    const r = await reviewEvidence("birdwood-iv3232", {
      evidenceId: "ev_abc12345",
      status: "rejected",
    });
    expect(r.ok).toBe(false);
    expect(sentinel).not.toHaveBeenCalled();
  });

  it("reviewEvidence POSTs ?action=review and parses the canonical response", async () => {
    const reviewedItem = {
      ...baseItem,
      status: "reviewed",
      reviewedById: "user-admin-1",
      reviewedByName: "Anna",
      reviewedAt: "2026-05-26T09:00:00.000Z",
    };
    installFetch(
      () =>
        new Response(JSON.stringify({ evidenceItem: reviewedItem }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const r = await reviewEvidence("birdwood-iv3232", {
      evidenceId: "ev_12345678",
      status: "reviewed",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.evidenceItem.status).toBe("reviewed");
      expect(r.data.evidenceItem.reviewedByName).toBe("Anna");
    }
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toContain("jobId=birdwood-iv3232");
    expect(url).toContain("action=review");
    expect(init?.method).toBe("POST");
  });
});
