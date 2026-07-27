import { describe, expect, it } from "vitest";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import type { CaptureBatchPhotoResult } from "@/domains/evidence/capture-batch";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { TrayPhoto } from "./CapturePhotoTray";
import {
  applyBatchResultToTray,
  CAPTURE_PURPOSES,
  COVERED_WORK_TAG,
  noteForPurpose,
  partialBatchFailureMessage,
  sendableTrayBatch,
  shouldResetCompositionOnOpen,
  unreadableTrayPhotos,
} from "./captureSharpened";

/**
 * Pure rules behind the sharpened Capture sheet (§2.5): the chip→real-concept
 * mapping (and its honest omissions), the office-visible covered-work tag and
 * the tray↔batch contract.
 */

describe("CAPTURE_PURPOSES — every chip maps to a real concept", () => {
  it("offers exactly progress / covered — ITP-test and Highlight are omitted (no backing concept)", () => {
    expect(CAPTURE_PURPOSES.map((p) => p.key)).toEqual(["progress", "covered"]);
    const labels = CAPTURE_PURPOSES.map((p) => p.label.toLowerCase()).join(" ");
    expect(labels).not.toContain("itp");
    expect(labels).not.toContain("highlight");
  });
});

describe("noteForPurpose", () => {
  it("progress passes the trimmed note through", () => {
    expect(noteForPurpose("progress", "  ring main in  ")).toBe("ring main in");
  });
  it("covered work prepends the office-visible tag", () => {
    expect(noteForPurpose("covered", "slab pour Monday")).toBe(
      `${COVERED_WORK_TAG} — slab pour Monday`,
    );
    expect(noteForPurpose("covered", "")).toBe(COVERED_WORK_TAG);
  });
  it("never exceeds the server's note cap even with the tag added", () => {
    const long = "x".repeat(EVIDENCE_NOTE_MAX);
    expect(noteForPurpose("covered", long).length).toBeLessThanOrEqual(EVIDENCE_NOTE_MAX);
    expect(noteForPurpose("progress", long).length).toBeLessThanOrEqual(EVIDENCE_NOTE_MAX);
  });
});

/* ── Partial-batch honesty (F1) ─────────────────────────────────────────── */

function tray(
  id: string,
  status: TrayPhoto["status"],
  dataUrl: string | null = `data:image/jpeg;base64,${id}`,
): TrayPhoto {
  return { id, file: { name: `${id}.jpg`, size: 1024 } as unknown as File, dataUrl, status };
}
const okResult = (id: string, evidenceId: string): CaptureBatchPhotoResult => ({
  id,
  ok: true,
  evidence: { id: evidenceId } as EvidenceItem,
});
const failResult = (id: string, message: string): CaptureBatchPhotoResult => ({
  id,
  ok: false,
  failedAt: "upload",
  message,
});

describe("sendableTrayBatch / unreadableTrayPhotos — a failed photo is never silently dropped", () => {
  it("sends ready AND retryable-failed photos; never a resizing or unreadable one", () => {
    const photos = [
      tray("a", "ready"),
      tray("b", "failed"), // upload failed — bytes still good, retryable
      tray("c", "resizing", null),
      tray("d", "failed", null), // resize failed — no bytes, can never send
    ];
    expect(sendableTrayBatch(photos).map((p) => p.id)).toEqual(["a", "b"]);
    expect(unreadableTrayPhotos(photos).map((p) => p.id)).toEqual(["d"]);
  });
});

describe("applyBatchResultToTray — partial failure keeps the failures, and the retry re-sends ONLY them", () => {
  it("3 photos, 2nd fails: saved leave the tray, the failure stays with its honest message", () => {
    const photos = [tray("a", "ready"), tray("b", "ready"), tray("c", "ready")];
    const after = applyBatchResultToTray(photos, [
      okResult("a", "ev_a"),
      failResult("b", "Couldn't upload the photo (500)."),
      okResult("c", "ev_c"),
    ]);
    expect(after.map((p) => p.id)).toEqual(["b"]);
    expect(after[0]!.status).toBe("failed");
    expect(after[0]!.error).toBe("Couldn't upload the photo (500).");
  });

  it("the RETRY batch contains ONLY the failed photo — the saved ids are never re-uploaded (no duplicate evidence)", () => {
    const photos = [tray("a", "ready"), tray("b", "ready"), tray("c", "ready")];
    const after = applyBatchResultToTray(photos, [
      okResult("a", "ev_a"),
      failResult("b", "Photo uploaded but didn't save (503)."),
      okResult("c", "ev_c"),
    ]);
    expect(sendableTrayBatch(after).map((p) => p.id)).toEqual(["b"]);
  });

  it("photos outside the attempt (still resizing) are untouched", () => {
    const photos = [tray("a", "ready"), tray("z", "resizing", null)];
    const after = applyBatchResultToTray(photos, [okResult("a", "ev_a")]);
    expect(after).toEqual([tray("z", "resizing", null)]);
  });
});

describe("partialBatchFailureMessage — the honest split (P7)", () => {
  it("claims exactly what saved and what didn't, and promises a failed-only retry", () => {
    expect(partialBatchFailureMessage(2, 1)).toBe(
      "2 saved · 1 didn't send — it's still here. Retry sends only the ones that failed.",
    );
    expect(partialBatchFailureMessage(1, 2)).toBe(
      "1 saved · 2 didn't send — they're still here. Retry sends only the ones that failed.",
    );
  });

  it("never claims a save when nothing landed", () => {
    expect(partialBatchFailureMessage(0, 1)).toBe(
      "That photo didn't send — it's still here. Nothing was sent.",
    );
    expect(partialBatchFailureMessage(0, 3)).toBe(
      "3 photos didn't send — they're still here. Nothing was sent.",
    );
  });
});

/* ── Composition ↔ job context (F2) ─────────────────────────────────────── */

describe("shouldResetCompositionOnOpen — a Job-A composition never reopens on Job B", () => {
  const jobs = [{ id: "job-a" }, { id: "job-b" }];

  it("resets when the incoming context is a REAL job different from the composition's", () => {
    expect(shouldResetCompositionOnOpen("job-b", "job-a", jobs)).toBe(true);
  });

  it("same-job reopen keeps everything (P8)", () => {
    expect(shouldResetCompositionOnOpen("job-a", "job-a", jobs)).toBe(false);
  });

  it("a no-context open (My Day FAB) keeps everything (P8)", () => {
    expect(shouldResetCompositionOnOpen(null, "job-a", jobs)).toBe(false);
    expect(shouldResetCompositionOnOpen(undefined, "job-a", jobs)).toBe(false);
  });

  it("an incoming id that isn't one of the worker's real jobs never resets", () => {
    expect(shouldResetCompositionOnOpen("job-x", "job-a", jobs)).toBe(false);
  });

  it("no remembered job → nothing lifted belongs anywhere yet, no reset", () => {
    expect(shouldResetCompositionOnOpen("job-b", null, jobs)).toBe(false);
  });
});
