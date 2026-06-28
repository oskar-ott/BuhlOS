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
    viewerId,
    viewerCanManageJob,
    onToggleAsBuilt,
  }: {
    allEvidence?: ReadonlyArray<EvidenceItem>;
    open?: boolean;
    isAdmin?: boolean;
    onUnlink?: () => void;
    viewerId?: string;
    viewerCanManageJob?: boolean;
    onToggleAsBuilt?: () => void;
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
      viewerId,
      viewerCanManageJob,
      onClose: () => {},
      onMarkReviewed: () => {},
      onOpenReject: () => {},
      onUnlink,
      onToggleAsBuilt,
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

/**
 * #233 — as-built flag control. The shipped endpoint + client + gallery
 * chip + summary count had no UI setter, so the as-built path was
 * unreachable. These pin the permission-aware toggle (mirroring the
 * server flag/unflag asymmetry), the As-built pill, and photo-only.
 */
describe("EvidenceDrawer as-built control (#233)", () => {
  const TOGGLE = 'data-testid="evidence-asbuilt-toggle"';
  const PILL = 'data-testid="evidence-asbuilt-pill"';

  it("renders the As-built toggle for an admin/LH viewer (canManageJob)", () => {
    // Not the capturer (different id), but can manage the job.
    const html = render(photo(), {
      allEvidence: [photo()],
      isAdmin: true,
      viewerId: "u_admin",
      viewerCanManageJob: true,
      onToggleAsBuilt: () => {},
    });
    expect(html).toContain(TOGGLE);
    expect(html).toContain("Mark as-built");
  });

  it("renders the As-built toggle for the CAPTURER of the row (even without manage rights)", () => {
    const html = render(photo({ capturedById: "u_field" }), {
      allEvidence: [photo()],
      isAdmin: false,
      viewerId: "u_field",
      viewerCanManageJob: false,
      onToggleAsBuilt: () => {},
    });
    expect(html).toContain(TOGGLE);
  });

  it("is ABSENT for a non-capturer tradie who can't manage the job", () => {
    const html = render(photo({ capturedById: "u_other" }), {
      allEvidence: [photo({ capturedById: "u_other" })],
      isAdmin: false,
      viewerId: "u_field",
      viewerCanManageJob: false,
      onToggleAsBuilt: () => {},
    });
    expect(html).not.toContain(TOGGLE);
  });

  it("shows the As-built pill + 'As-built ✓' label when item.asBuilt is set", () => {
    const html = render(photo({ asBuilt: true }), {
      allEvidence: [photo({ asBuilt: true })],
      isAdmin: true,
      viewerId: "u_admin",
      viewerCanManageJob: true,
      onToggleAsBuilt: () => {},
    });
    expect(html).toContain(PILL);
    expect(html).toContain("As-built ✓");
  });

  it("an admin can UNFLAG someone else's flagged photo (admin unflag path)", () => {
    const html = render(photo({ capturedById: "u_other", asBuilt: true }), {
      allEvidence: [photo({ capturedById: "u_other", asBuilt: true })],
      isAdmin: true,
      viewerId: "u_admin",
      viewerCanManageJob: true,
      onToggleAsBuilt: () => {},
    });
    expect(html).toContain(TOGGLE);
  });

  it("an LH CANNOT unflag someone else's flagged photo (unflag is admin-only for non-capturers)", () => {
    // LH on the job (can manage) but not the capturer and not admin: the
    // server would 403 the UNFLAG, so the control must hide.
    const html = render(photo({ capturedById: "u_other", asBuilt: true }), {
      allEvidence: [photo({ capturedById: "u_other", asBuilt: true })],
      isAdmin: false,
      viewerId: "u_lh",
      viewerCanManageJob: true,
      onToggleAsBuilt: () => {},
    });
    expect(html).not.toContain(TOGGLE);
    // …but the pill still shows the existing as-built state honestly.
    expect(html).toContain(PILL);
  });

  it("is photo-only: a note row never offers the toggle", () => {
    const note = photo({
      id: "ev_note",
      kind: "note",
      photoId: null,
      photoUrl: null,
      note: "tagged out at the board",
    });
    const html = render(note, {
      allEvidence: [note],
      isAdmin: true,
      viewerId: "u_admin",
      viewerCanManageJob: true,
      onToggleAsBuilt: () => {},
    });
    expect(html).not.toContain(TOGGLE);
  });

  it("renders no toggle when no handler is passed (default-safe)", () => {
    const html = render(photo(), {
      allEvidence: [photo()],
      isAdmin: true,
      viewerId: "u_admin",
      viewerCanManageJob: true,
    });
    expect(html).not.toContain(TOGGLE);
  });
});
