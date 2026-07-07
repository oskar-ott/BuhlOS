import { describe, expect, it } from "vitest";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import type { JobContact } from "@/domains/contacts/schema";
import type { CaptureBatchPhotoResult } from "@/domains/evidence/capture-batch";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { TrayPhoto } from "./CapturePhotoTray";
import {
  applyBatchResultToTray,
  availableCapturePurposes,
  buildBlockingObservationPayload,
  canMarkBlocked,
  CAPTURE_PURPOSES,
  COVERED_WORK_TAG,
  deriveRfiSubject,
  noteForPurpose,
  partialBatchFailureMessage,
  RFI_OFFICE_RECIPIENT,
  RFI_SUBJECT_MAX,
  rfiBlockedOutcome,
  rfiPhotoNote,
  rfiRecipients,
  sendableTrayBatch,
  shouldResetCompositionOnOpen,
  unreadableTrayPhotos,
} from "./captureSharpened";

/**
 * Pure rules behind the sharpened Capture sheet (§2.5): the chip→real-concept
 * mapping (and its honest omissions), the office-visible covered-work tag,
 * the RFI subject derivation, the REAL-recipients rule and the task-scoped
 * blocking rule (P7 — no fake blocking).
 */

describe("CAPTURE_PURPOSES — every chip maps to a real concept", () => {
  it("offers exactly progress / covered / snag / rfi — ITP-test and Highlight are omitted (no backing concept)", () => {
    expect(CAPTURE_PURPOSES.map((p) => p.key)).toEqual(["progress", "covered", "snag", "rfi"]);
    const labels = CAPTURE_PURPOSES.map((p) => p.label.toLowerCase()).join(" ");
    expect(labels).not.toContain("itp");
    expect(labels).not.toContain("highlight");
  });
});

describe("availableCapturePurposes — the RFI chip needs the register", () => {
  it("register on → all four chips", () => {
    expect(availableCapturePurposes(true).map((p) => p.key)).toEqual([
      "progress",
      "covered",
      "snag",
      "rfi",
    ]);
  });

  it("register off → no RFI chip (the raise 404s — a dead selection, P7); the rest unchanged", () => {
    expect(availableCapturePurposes(false).map((p) => p.key)).toEqual([
      "progress",
      "covered",
      "snag",
    ]);
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

describe("deriveRfiSubject", () => {
  it("takes the first line of the question", () => {
    expect(deriveRfiSubject("Where does the panel go?\nDrawing A-101 is silent.")).toBe(
      "Where does the panel go?",
    );
  });
  it("caps long lines with an ellipsis at the subject limit", () => {
    const s = deriveRfiSubject("w".repeat(400));
    expect(s.length).toBeLessThanOrEqual(RFI_SUBJECT_MAX);
    expect(s.endsWith("…")).toBe(true);
  });
  it("an empty question derives an empty subject (submit stays disabled — never invented)", () => {
    expect(deriveRfiSubject("   \n  ")).toBe("");
  });
  it("rfiPhotoNote links the batch caption to the question honestly", () => {
    expect(rfiPhotoNote("Where does the panel go?")).toBe("RFI: Where does the panel go?");
    expect(rfiPhotoNote("x".repeat(500)).length).toBeLessThanOrEqual(EVIDENCE_NOTE_MAX);
  });
});

describe("rfiRecipients — REAL options only", () => {
  const contacts: JobContact[] = [
    { id: "c1", name: "Dave Nguyen", role: "Site super", email: "dave@builder.example", category: "project" },
    { id: "c2", name: "Marco Ferraro", role: "Leading hand", phone: "0400 000 000", category: "project" },
    { id: "c3", name: "Sparky Supplies", category: "supplier", email: "sales@supplies.example" },
    { id: "c4", name: "Legacy Row", email: "legacy@x.example" }, // uncategorised email-list row
    { id: "c5", role: "PM", category: "project" }, // no name → not offerable
  ];

  it("always offers Office/PM first (blank askedOf — the office routes it)", () => {
    const list = rfiRecipients([]);
    expect(list).toEqual([RFI_OFFICE_RECIPIENT]);
    expect(list[0]!.askedOf).toBe("");
  });

  it("adds only named project contacts; suppliers and legacy rows never appear", () => {
    const list = rfiRecipients(contacts);
    expect(list.map((r) => r.label)).toEqual(["Office / PM", "Dave Nguyen", "Marco Ferraro"]);
  });

  it("askedOf prefers the contact's email, falls back to the name", () => {
    const list = rfiRecipients(contacts);
    expect(list[1]!.askedOf).toBe("dave@builder.example");
    expect(list[2]!.askedOf).toBe("Marco Ferraro");
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
    expect(partialBatchFailureMessage(2, 1, "progress")).toBe(
      "2 saved · 1 didn't send — it's still here. Retry sends only the ones that failed.",
    );
    expect(partialBatchFailureMessage(1, 2, "covered")).toBe(
      "1 saved · 2 didn't send — they're still here. Retry sends only the ones that failed.",
    );
  });

  it("never claims a save when nothing landed", () => {
    expect(partialBatchFailureMessage(0, 1, "progress")).toBe(
      "That photo didn't send — it's still here. Nothing was sent.",
    );
    expect(partialBatchFailureMessage(0, 3, "progress")).toBe(
      "3 photos didn't send — they're still here. Nothing was sent.",
    );
  });

  it("snag/RFI say the raise hasn't happened — photos up is not a raise", () => {
    expect(partialBatchFailureMessage(2, 1, "snag")).toContain("The snag hasn't been raised yet.");
    expect(partialBatchFailureMessage(2, 1, "rfi")).toContain("The RFI hasn't been sent yet.");
    expect(partialBatchFailureMessage(0, 1, "rfi")).toContain("The RFI hasn't been sent yet.");
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

/* ── Blocked truth (F3) ─────────────────────────────────────────────────── */

describe("rfiBlockedOutcome — the receipt can never contradict a created observation", () => {
  it("a created observation means blocked, even if the checkbox was unticked afterwards", () => {
    expect(rfiBlockedOutcome("obs_1", false, true)).toBe(true);
    expect(rfiBlockedOutcome("obs_1", false, false)).toBe(true);
    expect(rfiBlockedOutcome("obs_1", true, true)).toBe(true);
  });

  it("no observation yet → blocked is the ticked checkbox on a full task coordinate", () => {
    expect(rfiBlockedOutcome(null, true, true)).toBe(true);
    expect(rfiBlockedOutcome(null, true, false)).toBe(false);
    expect(rfiBlockedOutcome(null, false, true)).toBe(false);
  });
});

describe("canMarkBlocked — task-scoped only (the blocked state derives from full coordinates)", () => {
  it("requires stage AND area AND task", () => {
    expect(canMarkBlocked("roughIn", "a1", "t1")).toBe(true);
    expect(canMarkBlocked(null, "a1", "t1")).toBe(false);
    expect(canMarkBlocked("roughIn", null, "t1")).toBe(false);
    expect(canMarkBlocked("roughIn", "a1", null)).toBe(false);
    expect(canMarkBlocked(null, null, null)).toBe(false);
  });
});

describe("buildBlockingObservationPayload — the exact shape taskBlockersFromObservations reads", () => {
  it("is an rfi-typed, action-required, task-scoped observation", () => {
    const p = buildBlockingObservationPayload({
      subject: "Where does the panel go?",
      question: "Where does the panel go?\nDrawing A-101 is silent.",
      stage: "roughIn",
      areaId: "a1",
      taskId: "t1",
      linkedEvidenceId: "ev_1",
    });
    expect(p.type).toBe("rfi");
    expect(p.requiresAction).toBe(true);
    expect(p.stage).toBe("roughIn");
    expect(p.areaId).toBe("a1");
    expect(p.taskId).toBe("t1");
    expect(p.linkedEvidenceId).toBe("ev_1");
    expect(p.title).toBe("Where does the panel go?");
    // The note carries the question, RFI-prefixed — a blocker states its reason.
    expect(p.description).toBe("RFI: Where does the panel go?\nDrawing A-101 is silent.");
  });

  it("ALWAYS carries the question as its RFI-prefixed note — even a one-line question, so an orphan (raise failed after this landed) still says what it's waiting on", () => {
    const p = buildBlockingObservationPayload({
      subject: "Short question",
      question: "Short question",
      stage: "fitOff",
      areaId: "a2",
      taskId: "t9",
    });
    expect(p.description).toBe("RFI: Short question");
    expect(p).not.toHaveProperty("linkedEvidenceId");
  });

  it("respects the observation model's description cap", () => {
    const long = "Why? ".repeat(600); // 3000 chars — over the 2000 cap
    const p = buildBlockingObservationPayload({
      subject: deriveRfiSubject(long),
      question: long,
      stage: "roughIn",
      areaId: "a1",
      taskId: "t1",
    });
    expect(p.description!.length).toBeLessThanOrEqual(2000);
    expect(p.description!.startsWith("RFI: Why?")).toBe(true);
  });
});
