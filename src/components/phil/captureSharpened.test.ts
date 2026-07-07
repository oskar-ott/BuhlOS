import { describe, expect, it } from "vitest";
import { EVIDENCE_NOTE_MAX } from "@/domains/evidence/schema";
import type { JobContact } from "@/domains/contacts/schema";
import {
  availableCapturePurposes,
  buildBlockingObservationPayload,
  canMarkBlocked,
  CAPTURE_PURPOSES,
  COVERED_WORK_TAG,
  deriveRfiSubject,
  noteForPurpose,
  RFI_OFFICE_RECIPIENT,
  RFI_SUBJECT_MAX,
  rfiPhotoNote,
  rfiRecipients,
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
