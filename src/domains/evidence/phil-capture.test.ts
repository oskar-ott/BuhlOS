import { describe, expect, it } from "vitest";
import {
  buildPhilCaptureEvidence,
  NO_JOB_MESSAGE,
  PHIL_CAPTURE_SOURCE,
  type PhilCaptureContext,
} from "./phil-capture";

const AT = "2026-06-06T03:00:00.000Z";

function ctx(over: Partial<PhilCaptureContext> = {}): PhilCaptureContext {
  return {
    job: { id: "job-1", name: "Birdwood IV3232" },
    createdAt: AT,
    ...over,
  };
}

const FILE = { name: "rough-in.jpg", type: "image/jpeg", size: 482_000 };

describe("buildPhilCaptureEvidence — job-first contract", () => {
  it("builds a job-first record with source=phil_capture and the supplied clock", () => {
    const r = buildPhilCaptureEvidence(
      ctx({ stage: "roughIn", task: { id: "t1", name: "Install GPOs" }, worker: { id: "u9", name: "Sparky" } }),
      { status: "selected", file: FILE },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.evidence).toMatchObject({
      jobId: "job-1",
      jobName: "Birdwood IV3232",
      taskId: "t1",
      taskName: "Install GPOs",
      stage: "roughIn",
      workerId: "u9",
      workerName: "Sparky",
      source: PHIL_CAPTURE_SOURCE,
      createdAt: AT,
      status: "selected",
      fileName: "rough-in.jpg",
      contentType: "image/jpeg",
      sizeBytes: 482_000,
    });
  });
});

describe("missing job context never fabricates a record", () => {
  it.each([
    ["null job", null],
    ["undefined job", undefined],
    ["null id", { id: null, name: "x" }],
    ["empty id", { id: "", name: "x" }],
    ["whitespace id", { id: "   ", name: "x" }],
  ])("returns ok:false (no_job) for %s", (_label, job) => {
    const r = buildPhilCaptureEvidence(ctx({ job: job as PhilCaptureContext["job"] }), {
      status: "selected",
      file: FILE,
    });
    expect(r).toEqual({ ok: false, reason: "no_job", message: NO_JOB_MESSAGE });
  });
});

describe("honest status transitions", () => {
  it("selected → not saved: no blobUrl / evidenceId / thumbnailUrl", () => {
    const r = buildPhilCaptureEvidence(ctx(), { status: "selected", file: FILE });
    expect(r.ok && r.evidence.status).toBe("selected");
    if (!r.ok) return;
    expect(r.evidence.blobUrl).toBeUndefined();
    expect(r.evidence.evidenceId).toBeUndefined();
    expect(r.evidence.thumbnailUrl).toBeUndefined();
    expect(r.evidence.errorMessage).toBeUndefined();
  });

  it("uploading → still no blobUrl", () => {
    const r = buildPhilCaptureEvidence(ctx(), { status: "uploading", file: FILE });
    if (!r.ok) throw new Error("expected ok");
    expect(r.evidence.status).toBe("uploading");
    expect(r.evidence.blobUrl).toBeUndefined();
  });

  it("uploaded → carries the real blobUrl (and evidenceId/thumbnail when present)", () => {
    const r = buildPhilCaptureEvidence(ctx(), {
      status: "uploaded",
      file: FILE,
      blobUrl: "https://blob.example/evidence/abc.jpg",
      evidenceId: "ev_123",
      thumbnailUrl: "https://blob.example/evidence/abc-thumb.jpg",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.evidence.status).toBe("uploaded");
    expect(r.evidence.blobUrl).toBe("https://blob.example/evidence/abc.jpg");
    expect(r.evidence.evidenceId).toBe("ev_123");
    expect(r.evidence.thumbnailUrl).toBe("https://blob.example/evidence/abc-thumb.jpg");
    expect(r.evidence.errorMessage).toBeUndefined();
  });

  it("uploaded without optional ids still sets blobUrl but leaves evidenceId unset", () => {
    const r = buildPhilCaptureEvidence(ctx(), {
      status: "uploaded",
      file: FILE,
      blobUrl: "https://blob.example/x.jpg",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.evidence.blobUrl).toBe("https://blob.example/x.jpg");
    expect(r.evidence.evidenceId).toBeUndefined();
    expect(r.evidence.thumbnailUrl).toBeUndefined();
  });

  it("failed → carries errorMessage, never a blobUrl", () => {
    const r = buildPhilCaptureEvidence(ctx(), {
      status: "failed",
      file: FILE,
      errorMessage: "Couldn't upload photo (network).",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.evidence.status).toBe("failed");
    expect(r.evidence.errorMessage).toBe("Couldn't upload photo (network).");
    expect(r.evidence.blobUrl).toBeUndefined();
    expect(r.evidence.evidenceId).toBeUndefined();
  });

  it("not_configured → honest unconnected state: no blobUrl, no evidenceId, no fake success", () => {
    const r = buildPhilCaptureEvidence(ctx(), { status: "not_configured", file: FILE });
    if (!r.ok) throw new Error("expected ok");
    expect(r.evidence.status).toBe("not_configured");
    expect(r.evidence.blobUrl).toBeUndefined();
    expect(r.evidence.evidenceId).toBeUndefined();
    expect(r.evidence.errorMessage).toBeUndefined();
    // file may still be previewed locally — its metadata is allowed.
    expect(r.evidence.fileName).toBe("rough-in.jpg");
  });
});

describe("only truthful fields are populated", () => {
  it("omits blank/whitespace optional context rather than writing empty strings", () => {
    const r = buildPhilCaptureEvidence(
      ctx({
        job: { id: "job-1", name: "   " },
        task: { id: " ", name: "" },
        worker: { id: "", name: null },
        note: "   ",
      }),
      { status: "uploading", file: { name: "", type: "", size: null } },
    );
    if (!r.ok) throw new Error("expected ok");
    const e = r.evidence;
    expect(e.jobId).toBe("job-1");
    for (const k of ["jobName", "taskId", "taskName", "workerId", "workerName", "note", "fileName", "contentType", "sizeBytes"] as const) {
      expect(e[k]).toBeUndefined();
    }
  });

  it("keeps a non-empty trimmed note", () => {
    const r = buildPhilCaptureEvidence(ctx({ note: "  cable path blocked at riser  " }), {
      status: "selected",
      file: FILE,
    });
    expect(r.ok && r.evidence.note).toBe("cable path blocked at riser");
  });

  it("accepts sizeBytes of 0 but drops negative / non-finite sizes", () => {
    const zero = buildPhilCaptureEvidence(ctx(), { status: "selected", file: { name: "a", type: "image/png", size: 0 } });
    expect(zero.ok && zero.evidence.sizeBytes).toBe(0);
    const bad = buildPhilCaptureEvidence(ctx(), { status: "selected", file: { name: "a", type: "image/png", size: -5 } });
    expect(bad.ok && bad.evidence.sizeBytes).toBeUndefined();
    const nan = buildPhilCaptureEvidence(ctx(), { status: "selected", file: { name: "a", type: "image/png", size: Number.NaN } });
    expect(nan.ok && nan.evidence.sizeBytes).toBeUndefined();
  });
});
