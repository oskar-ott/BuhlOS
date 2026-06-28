import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EvidenceDrawer } from "./EvidenceDrawer";
import type { EvidenceItem } from "@/domains/evidence/types";
import type { Job } from "@/domains/jobs/types";

/**
 * #263 — before/after pair view in the admin evidence drawer.
 *
 * Pins: the side-by-side render (both photo srcs + both status pills), the
 * MIXED-STATUS honesty (a rejected before next to a reviewed after shows
 * BOTH), the dangling-partner fallback to a single render (no crash), and
 * the unlink affordance. Mirrors ExpenseDetailDrawer.render.test.tsx.
 */

const JOB = { id: "job-1", name: "Glebe", areaGroups: [] } as unknown as Job;

function photo(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev_after",
    jobId: "job-1",
    areaId: null,
    stage: null,
    taskId: null,
    kind: "photo",
    photoId: "ph_a",
    photoUrl: "https://blob.example/after.jpg",
    thumbnailUrl: null,
    note: null,
    capturedById: "u_field",
    capturedByName: "Sam",
    capturedByRole: "electrician",
    capturedAt: "2026-05-25T12:00:00.000Z",
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
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z",
    ...over,
  } as EvidenceItem;
}

function render(
  item: EvidenceItem | null,
  {
    allEvidence,
    open = true,
    isAdmin = true,
    onUnlink,
  }: {
    allEvidence?: ReadonlyArray<EvidenceItem>;
    open?: boolean;
    isAdmin?: boolean;
    onUnlink?: () => void;
  } = {},
): string {
  return renderToString(
    createElement(EvidenceDrawer, {
      item,
      job: JOB,
      allEvidence,
      open,
      isAdmin,
      busy: false,
      onClose: () => {},
      onMarkReviewed: () => {},
      onOpenReject: () => {},
      onUnlink,
    }),
  );
}

describe("EvidenceDrawer pair view (#263)", () => {
  it("renders the before and after photos side by side", () => {
    const before = photo({ id: "ev_before", photoUrl: "https://blob.example/before.jpg" });
    const after = photo({ id: "ev_after", pairedWithId: "ev_before" });
    const html = render(after, { allEvidence: [before, after] });
    expect(html).toContain("Before / after");
    expect(html).toContain('src="https://blob.example/before.jpg"');
    expect(html).toContain('src="https://blob.example/after.jpg"');
    expect(html).toContain("Before");
    expect(html).toContain("After");
  });

  it("MIXED STATUS: shows BOTH a rejected before and a reviewed after (never hides the rejected half)", () => {
    const before = photo({
      id: "ev_before",
      photoUrl: "https://blob.example/before.jpg",
      status: "rejected",
      rejectionReason: "blurry",
    });
    const after = photo({ id: "ev_after", pairedWithId: "ev_before", status: "reviewed" });
    const html = render(after, { allEvidence: [before, after] });
    // Both pills are present in the pair view.
    expect(html).toContain("Rejected");
    expect(html).toContain("Reviewed");
  });

  it("resolves the pair from EITHER half (open on the before shows the after too)", () => {
    const before = photo({ id: "ev_before", photoUrl: "https://blob.example/before.jpg" });
    const after = photo({ id: "ev_after", pairedWithId: "ev_before" });
    const html = render(before, { allEvidence: [before, after] });
    expect(html).toContain("Before / after");
    expect(html).toContain('src="https://blob.example/after.jpg"');
  });

  it("DANGLING partner → renders single, never crashes, no pair heading", () => {
    const after = photo({ id: "ev_after", pairedWithId: "missing" });
    const html = render(after, { allEvidence: [after] });
    expect(html).not.toContain("Before / after");
    expect(html).toContain('src="https://blob.example/after.jpg"');
  });

  it("renders the Unlink affordance when paired and a handler is passed", () => {
    const before = photo({ id: "ev_before", photoUrl: "https://blob.example/before.jpg" });
    const after = photo({ id: "ev_after", pairedWithId: "ev_before" });
    const html = render(after, { allEvidence: [before, after], onUnlink: () => {} });
    expect(html).toContain("Unlink");
    expect(html).toContain("Paired before/after");
  });

  it("renders nothing when closed or itemless", () => {
    expect(render(null)).toBe("");
    expect(render(photo(), { open: false })).toBe("");
  });

  it("unpaired single photo renders without the pair heading", () => {
    const solo = photo({ id: "ev_solo" });
    const html = render(solo, { allEvidence: [solo] });
    expect(html).not.toContain("Before / after");
    expect(html).toContain('src="https://blob.example/after.jpg"');
  });
});
