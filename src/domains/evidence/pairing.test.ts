import { describe, expect, it } from "vitest";
import {
  candidateBeforePhotos,
  pairedIdSet,
  resolvePair,
  validateLink,
} from "./pairing";
import type { EvidenceItem } from "./types";

/**
 * #263 — pure pairing helpers. Covers the candidate filter/order/cap, the
 * validateLink rule matrix (mirrors the server), and resolvePair's
 * dangling-safe behaviour (a missing partner is treated as unpaired, never
 * a crash).
 */

function photo(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev_photo",
    jobId: "job-1",
    areaId: null,
    stage: null,
    taskId: null,
    kind: "photo",
    photoId: "ph_1",
    photoUrl: "https://blob.example/p.jpg",
    thumbnailUrl: null,
    note: null,
    capturedById: "u_field",
    capturedByName: "Sam",
    capturedByRole: "electrician",
    capturedAt: "2026-05-25T10:00:00.000Z",
    clientCapturedAt: null,
    exifLocation: null,
    status: "submitted",
    source: "phil",
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    rejectionReason: null,
    pairedWithId: null,
    auditLogIds: [],
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T10:00:00.000Z",
    ...over,
  } as EvidenceItem;
}

function note(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return photo({
    id: "ev_note",
    kind: "note",
    photoId: null,
    photoUrl: null,
    note: "a note",
    ...over,
  });
}

/* ---------------------------------------------------------------------- */
/* candidateBeforePhotos                                                    */
/* ---------------------------------------------------------------------- */

describe("candidateBeforePhotos", () => {
  it("returns [] when the after is not a photo", () => {
    const items = [photo({ id: "a" }), photo({ id: "b" })];
    expect(candidateBeforePhotos(items, note({ id: "n" }))).toEqual([]);
  });

  it("returns [] for a missing after", () => {
    expect(candidateBeforePhotos([photo({ id: "a" })], null)).toEqual([]);
  });

  it("excludes the after itself (no self-candidate)", () => {
    const after = photo({ id: "a" });
    const ids = candidateBeforePhotos([after, photo({ id: "b" })], after).map((x) => x.id);
    expect(ids).toEqual(["b"]);
    expect(ids).not.toContain("a");
  });

  it("excludes note-kind rows", () => {
    const after = photo({ id: "a" });
    const ids = candidateBeforePhotos(
      [after, photo({ id: "b" }), note({ id: "n" })],
      after,
    ).map((x) => x.id);
    expect(ids).toEqual(["b"]);
  });

  it("excludes rows from a different job", () => {
    const after = photo({ id: "a", jobId: "job-1" });
    const ids = candidateBeforePhotos(
      [after, photo({ id: "b", jobId: "job-1" }), photo({ id: "x", jobId: "job-2" })],
      after,
    ).map((x) => x.id);
    expect(ids).toEqual(["b"]);
  });

  it("prefers same-area candidates, then recent-first across the rest", () => {
    const after = photo({ id: "a", areaId: "ar_kitchen", capturedAt: "2026-05-25T12:00:00.000Z" });
    const sameAreaOld = photo({ id: "same-old", areaId: "ar_kitchen", capturedAt: "2026-05-25T08:00:00.000Z" });
    const crossNew = photo({ id: "cross-new", areaId: "ar_bath", capturedAt: "2026-05-25T11:00:00.000Z" });
    const crossOld = photo({ id: "cross-old", areaId: "ar_bath", capturedAt: "2026-05-25T07:00:00.000Z" });
    const ids = candidateBeforePhotos([after, crossNew, crossOld, sameAreaOld], after).map((x) => x.id);
    // Same area first (even though older), then cross-area recent-first.
    expect(ids).toEqual(["same-old", "cross-new", "cross-old"]);
  });

  it("sorts recent-first when no area context distinguishes them", () => {
    const after = photo({ id: "a", areaId: null, capturedAt: "2026-05-25T12:00:00.000Z" });
    const older = photo({ id: "older", areaId: null, capturedAt: "2026-05-25T08:00:00.000Z" });
    const newer = photo({ id: "newer", areaId: null, capturedAt: "2026-05-25T11:00:00.000Z" });
    const ids = candidateBeforePhotos([after, older, newer], after).map((x) => x.id);
    expect(ids).toEqual(["newer", "older"]);
  });

  it("caps the result list (default 12, configurable)", () => {
    const after = photo({ id: "a" });
    const many = Array.from({ length: 20 }, (_, i) =>
      photo({ id: `b${i}`, capturedAt: `2026-05-25T10:${String(i).padStart(2, "0")}:00.000Z` }),
    );
    expect(candidateBeforePhotos([after, ...many], after)).toHaveLength(12);
    expect(candidateBeforePhotos([after, ...many], after, { cap: 3 })).toHaveLength(3);
  });
});

/* ---------------------------------------------------------------------- */
/* validateLink — mirrors the server rule matrix                           */
/* ---------------------------------------------------------------------- */

describe("validateLink", () => {
  const after = photo({ id: "a", jobId: "job-1" });
  const before = photo({ id: "b", jobId: "job-1" });

  it("ok when both resolve as photos on the same job", () => {
    expect(validateLink([after, before], "a", "b")).toEqual({ ok: true });
  });

  it("rejects a self-link", () => {
    expect(validateLink([after, before], "a", "a")).toEqual({ ok: false, reason: "self-link" });
  });

  it("rejects missing ids", () => {
    expect(validateLink([after, before], "", "b").ok).toBe(false);
    expect(validateLink([after, before], "a", "").ok).toBe(false);
  });

  it("rejects when the after is not found", () => {
    expect(validateLink([before], "a", "b")).toEqual({ ok: false, reason: "after-not-found" });
  });

  it("rejects when the before is not found", () => {
    expect(validateLink([after], "a", "b")).toEqual({ ok: false, reason: "before-not-found" });
  });

  it("rejects when the after is a note", () => {
    const n = note({ id: "a", jobId: "job-1" });
    expect(validateLink([n, before], "a", "b")).toEqual({ ok: false, reason: "after-not-photo" });
  });

  it("rejects when the before is a note", () => {
    const n = note({ id: "b", jobId: "job-1" });
    expect(validateLink([after, n], "a", "b")).toEqual({ ok: false, reason: "before-not-photo" });
  });

  it("rejects a cross-job pair", () => {
    const other = photo({ id: "b", jobId: "job-2" });
    expect(validateLink([after, other], "a", "b")).toEqual({ ok: false, reason: "cross-job" });
  });
});

/* ---------------------------------------------------------------------- */
/* resolvePair — dangling-safe                                             */
/* ---------------------------------------------------------------------- */

describe("resolvePair", () => {
  it("returns unpaired for a null item", () => {
    expect(resolvePair([], null)).toEqual({ before: null, after: null, paired: false });
  });

  it("resolves the after side (item carries pairedWithId)", () => {
    const before = photo({ id: "b" });
    const after = photo({ id: "a", pairedWithId: "b" });
    const r = resolvePair([before, after], after);
    expect(r.paired).toBe(true);
    expect(r.before?.id).toBe("b");
    expect(r.after?.id).toBe("a");
  });

  it("resolves the before side (another row points at item)", () => {
    const before = photo({ id: "b" });
    const after = photo({ id: "a", pairedWithId: "b" });
    const r = resolvePair([before, after], before);
    expect(r.paired).toBe(true);
    expect(r.before?.id).toBe("b");
    expect(r.after?.id).toBe("a");
  });

  it("treats a DANGLING pairedWithId as unpaired — never crashes", () => {
    const after = photo({ id: "a", pairedWithId: "missing" });
    const r = resolvePair([after], after);
    expect(r.paired).toBe(false);
    expect(r.before).toBeNull();
    expect(r.after?.id).toBe("a");
  });

  it("returns unpaired for a genuinely solo item", () => {
    const solo = photo({ id: "solo" });
    expect(resolvePair([solo], solo)).toEqual({ before: null, after: solo, paired: false });
  });

  it("preserves mixed statuses on both halves (honesty)", () => {
    const before = photo({ id: "b", status: "rejected", rejectionReason: "blurry" });
    const after = photo({ id: "a", pairedWithId: "b", status: "reviewed" });
    const r = resolvePair([before, after], after);
    expect(r.before?.status).toBe("rejected");
    expect(r.after?.status).toBe("reviewed");
  });
});

/* ---------------------------------------------------------------------- */
/* pairedIdSet                                                              */
/* ---------------------------------------------------------------------- */

describe("pairedIdSet", () => {
  it("includes both halves of every resolved pair", () => {
    const before = photo({ id: "b" });
    const after = photo({ id: "a", pairedWithId: "b" });
    const solo = photo({ id: "s" });
    const set = pairedIdSet([before, after, solo]);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("s")).toBe(false);
  });

  it("excludes a dangling link (partner missing)", () => {
    const after = photo({ id: "a", pairedWithId: "gone" });
    const set = pairedIdSet([after]);
    expect(set.has("a")).toBe(false);
  });
});
