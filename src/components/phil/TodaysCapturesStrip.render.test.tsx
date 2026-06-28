import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TodaysCapturesStrip } from "./TodaysCapturesStrip";
import type { EvidenceItem } from "@/domains/evidence/types";

/**
 * #138 — the grid thumbnail is a LIST image: it must prefer the small
 * `thumbnailUrl` and only fall back to the full-res `photoUrl` when the
 * thumb is absent. Mirrors the PhilPhotosGallery tile so list views never
 * pay the full-res byte cost on a cold 4G start. The full-res image stays
 * on the EvidenceDrawer (tested implicitly: opening a capture is a click
 * the static render does not perform, so the drawer img is not in scope).
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
    photoUrl: "https://blob.example/full-res.jpg",
    thumbnailUrl: "https://blob.example/thumb.jpg",
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

describe("TodaysCapturesStrip", () => {
  it("grid thumbnail PREFERS thumbnailUrl over the full-res photoUrl", () => {
    const html = renderToString(
      createElement(TodaysCapturesStrip, {
        items: [photo({ id: "with-thumb" })],
      }),
    );
    // The list <img> renders the thumbnail src…
    expect(html).toContain('src="https://blob.example/thumb.jpg"');
    // …and does NOT load the full-res file into the list grid.
    expect(html).not.toContain('src="https://blob.example/full-res.jpg"');
    // Still a lazily-loaded list image (cold-start byte budget).
    expect(html).toContain('loading="lazy"');
  });

  it("grid thumbnail FALLS BACK to photoUrl when thumbnailUrl is null", () => {
    const html = renderToString(
      createElement(TodaysCapturesStrip, {
        items: [photo({ id: "no-thumb", thumbnailUrl: null })],
      }),
    );
    expect(html).toContain('src="https://blob.example/full-res.jpg"');
  });
});
