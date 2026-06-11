import { describe, expect, it } from "vitest";
import {
  submitCaptureBatch,
  type CaptureBatchDeps,
  type CaptureBatchProgress,
} from "./capture-batch";
import type { CreateEvidencePayload, EvidenceItem } from "./types";

const CONTEXT = {
  jobId: "job-1",
  note: "  switchboard rough-in  ",
  stage: "roughIn" as const,
  areaId: "area-1",
  taskId: null,
  clientCapturedAt: "2026-06-11T10:00:00.000Z",
};

function evidence(id: string): EvidenceItem {
  return { id } as unknown as EvidenceItem;
}

function okDeps(log: string[]): CaptureBatchDeps {
  let n = 0;
  return {
    async uploadPhoto(jobId, dataUrl) {
      log.push(`upload:${dataUrl}`);
      n += 1;
      return { ok: true, data: { id: `p${n}`, url: `https://blob/p${n}.jpg`, capturedAt: "t" } };
    },
    async createEvidence(jobId, payload) {
      log.push(`create:${payload.photoId}`);
      return { ok: true, data: { evidenceItem: evidence(`ev-${payload.photoId}`) } };
    },
  } as CaptureBatchDeps;
}

describe("submitCaptureBatch", () => {
  it("saves every photo sequentially (upload then create, in order)", async () => {
    const log: string[] = [];
    const result = await submitCaptureBatch(
      [
        { id: "a", dataUrl: "data-a" },
        { id: "b", dataUrl: "data-b" },
      ],
      CONTEXT,
      okDeps(log),
    );
    // Strict interleaving proves sequential submission — photo b never starts
    // before photo a's metadata row landed (data.json append is read-modify-write).
    expect(log).toEqual(["upload:data-a", "create:p1", "upload:data-b", "create:p2"]);
    expect(result.allSaved).toBe(true);
    expect(result.savedCount).toBe(2);
    expect(result.failedIds).toEqual([]);
  });

  it("trims the note and applies the shared context to every photo", async () => {
    const payloads: CreateEvidencePayload[] = [];
    const deps: CaptureBatchDeps = {
      async uploadPhoto() {
        return { ok: true, data: { id: "p", url: "https://blob/p.jpg", capturedAt: "t" } };
      },
      async createEvidence(_jobId, payload) {
        payloads.push(payload);
        return { ok: true, data: { evidenceItem: evidence("ev") } };
      },
    } as CaptureBatchDeps;

    await submitCaptureBatch(
      [
        { id: "a", dataUrl: "d1" },
        { id: "b", dataUrl: "d2" },
      ],
      CONTEXT,
      deps,
    );
    for (const p of payloads) {
      expect(p.kind).toBe("photo");
      expect(p.note).toBe("switchboard rough-in");
      expect(p.stage).toBe("roughIn");
      expect(p.areaId).toBe("area-1");
      expect(p.taskId).toBeNull();
      expect(p.clientCapturedAt).toBe(CONTEXT.clientCapturedAt);
    }
  });

  it("sends a blank note as null, never an empty string", async () => {
    const payloads: CreateEvidencePayload[] = [];
    const deps: CaptureBatchDeps = {
      async uploadPhoto() {
        return { ok: true, data: { id: "p", url: "u", capturedAt: "t" } };
      },
      async createEvidence(_jobId, payload) {
        payloads.push(payload);
        return { ok: true, data: { evidenceItem: evidence("ev") } };
      },
    } as CaptureBatchDeps;
    await submitCaptureBatch(
      [{ id: "a", dataUrl: "d" }],
      { ...CONTEXT, note: "   " },
      deps,
    );
    expect(payloads[0]!.note).toBeNull();
  });

  it("reports a failed upload and keeps going (partial failure, no throw)", async () => {
    let uploads = 0;
    const deps: CaptureBatchDeps = {
      async uploadPhoto() {
        uploads += 1;
        if (uploads === 1) return { ok: false, error: { status: 413, message: "too large", body: null } };
        return { ok: true, data: { id: "p2", url: "u2", capturedAt: "t" } };
      },
      async createEvidence() {
        return { ok: true, data: { evidenceItem: evidence("ev-2") } };
      },
    } as CaptureBatchDeps;

    const result = await submitCaptureBatch(
      [
        { id: "a", dataUrl: "d1" },
        { id: "b", dataUrl: "d2" },
      ],
      CONTEXT,
      deps,
    );
    expect(result.allSaved).toBe(false);
    expect(result.savedCount).toBe(1);
    expect(result.failedIds).toEqual(["a"]);
    const failed = result.results[0]!;
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.failedAt).toBe("upload");
      expect(failed.message).toContain("413");
    }
  });

  it("never claims a photo saved when the metadata row failed after upload", async () => {
    const deps: CaptureBatchDeps = {
      async uploadPhoto() {
        return { ok: true, data: { id: "p", url: "u", capturedAt: "t" } };
      },
      async createEvidence() {
        return { ok: false, error: { status: 500, message: "boom", body: null } };
      },
    } as CaptureBatchDeps;
    const result = await submitCaptureBatch([{ id: "a", dataUrl: "d" }], CONTEXT, deps);
    expect(result.savedCount).toBe(0);
    expect(result.failedIds).toEqual(["a"]);
    const r = result.results[0]!;
    if (!r.ok) {
      expect(r.failedAt).toBe("create");
      expect(r.message).toContain("didn't save");
    }
  });

  it("catches a thrown dependency and records it against that photo only", async () => {
    let calls = 0;
    const deps: CaptureBatchDeps = {
      async uploadPhoto() {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return { ok: true, data: { id: "p", url: "u", capturedAt: "t" } };
      },
      async createEvidence() {
        return { ok: true, data: { evidenceItem: evidence("ev") } };
      },
    } as CaptureBatchDeps;
    const result = await submitCaptureBatch(
      [
        { id: "a", dataUrl: "d1" },
        { id: "b", dataUrl: "d2" },
      ],
      CONTEXT,
      deps,
    );
    expect(result.failedIds).toEqual(["a"]);
    expect(result.savedCount).toBe(1);
  });

  it("emits worker-facing progress for each photo", async () => {
    const seen: CaptureBatchProgress[] = [];
    await submitCaptureBatch(
      [
        { id: "a", dataUrl: "d1" },
        { id: "b", dataUrl: "d2" },
        { id: "c", dataUrl: "d3" },
      ],
      CONTEXT,
      okDeps([]),
      (p) => seen.push(p),
    );
    expect(seen).toEqual([
      { current: 1, total: 3 },
      { current: 2, total: 3 },
      { current: 3, total: 3 },
    ]);
  });
});
