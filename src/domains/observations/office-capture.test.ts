import { describe, expect, it } from "vitest";
import {
  submitOfficeCapture,
  type OfficeCaptureDeps,
  type OfficeCaptureProgress,
} from "./office-capture";
import type { ObservationItem } from "./types";

const PAYLOAD = {
  type: "note" as const,
  title: "Parking fine — Lane Cove",
  requiresAction: true,
};

function observation(id: string): ObservationItem {
  return { id } as unknown as ObservationItem;
}

describe("submitOfficeCapture", () => {
  it("uploads every photo then creates ONE observation with the urls in tray order", async () => {
    const log: string[] = [];
    let n = 0;
    const deps: OfficeCaptureDeps = {
      async uploadPhoto(dataUrl) {
        log.push(`upload:${dataUrl}`);
        n += 1;
        return { ok: true, data: { id: `p${n}`, url: `https://blob/p${n}.jpg`, capturedAt: "t" } };
      },
      async create(payload) {
        log.push(`create:${(payload.photoUrls ?? []).join(",")}`);
        return { ok: true, data: { observation: observation("ob_1") } };
      },
    };
    const result = await submitOfficeCapture(
      [
        { id: "a", dataUrl: "d1" },
        { id: "b", dataUrl: "d2" },
      ],
      PAYLOAD,
      deps,
    );
    expect(log).toEqual([
      "upload:d1",
      "upload:d2",
      "create:https://blob/p1.jpg,https://blob/p2.jpg",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation.id).toBe("ob_1");
      expect(result.uploadedById).toEqual({
        a: "https://blob/p1.jpg",
        b: "https://blob/p2.jpg",
      });
    }
  });

  it("NEVER creates the observation when any upload failed (no silent photo loss)", async () => {
    let created = false;
    let n = 0;
    const deps: OfficeCaptureDeps = {
      async uploadPhoto() {
        n += 1;
        if (n === 2) return { ok: false, error: { status: 500, message: "boom", body: null } };
        return { ok: true, data: { id: `p${n}`, url: `u${n}`, capturedAt: "t" } };
      },
      async create() {
        created = true;
        return { ok: true, data: { observation: observation("ob_1") } };
      },
    };
    const result = await submitOfficeCapture(
      [
        { id: "a", dataUrl: "d1" },
        { id: "b", dataUrl: "d2" },
        { id: "c", dataUrl: "d3" },
      ],
      PAYLOAD,
      deps,
    );
    expect(created).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok && result.phase === "upload") {
      expect(result.failedIds).toEqual(["b"]);
      // The two good uploads are preserved for the retry.
      expect(result.uploadedById).toEqual({ a: "u1", c: "u3" });
    } else {
      throw new Error("expected an upload-phase failure");
    }
  });

  it("reuses already-uploaded photos on retry instead of re-uploading", async () => {
    const uploads: string[] = [];
    const deps: OfficeCaptureDeps = {
      async uploadPhoto(dataUrl) {
        uploads.push(dataUrl);
        return { ok: true, data: { id: "p", url: "u-new", capturedAt: "t" } };
      },
      async create(payload) {
        return payload.photoUrls?.length === 2
          ? { ok: true, data: { observation: observation("ob_2") } }
          : { ok: false, error: { status: 400, message: "bad", body: null } };
      },
    };
    const result = await submitOfficeCapture(
      [
        { id: "a", dataUrl: "d1", uploadedUrl: "u-old" },
        { id: "b", dataUrl: "d2" },
      ],
      PAYLOAD,
      deps,
    );
    expect(uploads).toEqual(["d2"]); // only the photo that wasn't up yet
    expect(result.ok).toBe(true);
  });

  it("reports a create failure with the uploads preserved (retry skips re-upload)", async () => {
    const deps: OfficeCaptureDeps = {
      async uploadPhoto() {
        return { ok: true, data: { id: "p", url: "u1", capturedAt: "t" } };
      },
      async create() {
        return { ok: false, error: { status: 502, message: "down", body: null } };
      },
    };
    const result = await submitOfficeCapture([{ id: "a", dataUrl: "d1" }], PAYLOAD, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.phase).toBe("create");
      expect(result.uploadedById).toEqual({ a: "u1" });
      expect(result.message).toContain("502");
    }
  });

  it("emits uploading progress per photo then a sending step", async () => {
    const seen: OfficeCaptureProgress[] = [];
    const deps: OfficeCaptureDeps = {
      async uploadPhoto() {
        return { ok: true, data: { id: "p", url: "u", capturedAt: "t" } };
      },
      async create() {
        return { ok: true, data: { observation: observation("ob") } };
      },
    };
    await submitOfficeCapture(
      [
        { id: "a", dataUrl: "d1" },
        { id: "b", dataUrl: "d2" },
      ],
      PAYLOAD,
      deps,
      (p) => seen.push(p),
    );
    expect(seen).toEqual([
      { step: "uploading", current: 1, total: 2 },
      { step: "uploading", current: 2, total: 2 },
      { step: "sending" },
    ]);
  });

  it("works with zero photos (a note-only office item)", async () => {
    const deps: OfficeCaptureDeps = {
      async uploadPhoto() {
        throw new Error("should not be called");
      },
      async create(payload) {
        expect(payload.photoUrls).toEqual([]);
        return { ok: true, data: { observation: observation("ob_3") } };
      },
    };
    const result = await submitOfficeCapture([], PAYLOAD, deps);
    expect(result.ok).toBe(true);
  });
});
