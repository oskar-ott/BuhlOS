import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilCaptureSharpened, type PhilCaptureSharpenedProps } from "./PhilCaptureSharpened";
import { PhilCaptureLauncher } from "./PhilCaptureLauncher";
import { PhilSharpenedProvider } from "./philSharpenedContext";
import type { TrayPhoto } from "./CapturePhotoTray";

/**
 * SSR smoke for the SHARPENED Capture body (§2.5, phil_sharpened) — first
 * paint only (effects don't run under renderToString). The write flows are
 * covered by capture-batch.test.ts and captureSharpened.test.ts
 * (mapping/rules). Flag-off byte-safety is covered by
 * PhilCaptureLauncher.render.test.tsx (no provider → the current sheet) —
 * plus a provider-wrapped launcher assertion here.
 */

function makeProps(over: Partial<PhilCaptureSharpenedProps> = {}): PhilCaptureSharpenedProps {
  return {
    photos: [],
    setPhotos: () => {},
    photoHint: null,
    maxPhotos: 10,
    onRequestCamera: () => {},
    jobsLoading: false,
    jobsError: null,
    onRetryJobs: () => {},
    jobs: [{ id: "job-1", name: "Level 12 Office Fitout", siteAddress: "40 Kent St" }],
    selectedJobId: "job-1",
    onSelectJob: () => {},
    fromJobContext: false,
    detailJob: null,
    jobDetailState: "idle",
    flatAreas: [],
    stage: null,
    areaId: null,
    taskId: null,
    onStageChange: () => {},
    onAreaChange: () => {},
    onTaskChange: () => {},
    note: "",
    onNoteChange: () => {},
    purpose: "progress",
    onPurposeChange: () => {},
    online: true,
    onClose: () => {},
    ...over,
  };
}

function render(over: Partial<PhilCaptureSharpenedProps> = {}): string {
  return renderToString(createElement(PhilCaptureSharpened, makeProps(over)));
}

function trayPhoto(id: string): TrayPhoto {
  return {
    id,
    file: { name: `${id}.jpg`, size: 1024 } as unknown as File,
    dataUrl: "data:image/jpeg;base64,xxxx",
    status: "ready",
  };
}

/** A photo whose upload failed — bytes still good, so a retry can re-send it. */
function failedPhoto(id: string): TrayPhoto {
  return { ...trayPhoto(id), status: "failed", error: "Couldn't upload the photo (500)." };
}

/** A photo whose RESIZE failed — no bytes at all; it can never send. */
function unreadablePhoto(id: string): TrayPhoto {
  return { ...trayPhoto(id), dataUrl: null, status: "failed", error: "Couldn't read this photo." };
}

/** The `<button …>` open tag carrying the given testid, for disabled checks. */
function buttonTag(html: string, testid: string): string {
  const idx = html.indexOf(`data-testid="${testid}"`);
  expect(idx).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", idx), html.indexOf(">", idx) + 1);
}

describe("PhilCaptureSharpened — first paint", () => {
  it("renders the viewfinder, the real shutter and honest copy (no auto-file claims)", () => {
    const html = render();
    expect(html).toContain('data-testid="capture-shutter"');
    expect(html).toContain("Tap the shutter to shoot");
    expect(html).toContain("nothing sends until you save");
    // No batch counter with an empty tray — the count is never invented.
    expect(html).not.toContain("in batch");
  });

  it("counts the batch from the REAL tray and keeps the managing tray", () => {
    const html = render({ photos: [trayPhoto("a"), trayPhoto("b")] });
    expect(html).toContain("2 in batch");
    expect(html).toContain("2 photos"); // CapturePhotoTray header (remove/errors live there)
  });

  it("offers exactly the backed purpose chips — no ITP / Highlight dead selections", () => {
    const html = render();
    for (const key of ["progress", "covered"]) {
      expect(html).toContain(`data-testid="capture-purpose-${key}"`);
    }
    expect(html).not.toContain("ITP");
    expect(html).not.toContain("Highlight");
    expect(html).toContain("Save &amp; file to job");
  });

  it("locks the filed-to job chip and only claims context when it is real", () => {
    const withContext = render({ fromJobContext: true });
    expect(withContext).toContain('data-testid="capture-filed-job"');
    expect(withContext).toContain("Level 12 Office Fitout");
    expect(withContext).toContain("Phil knows where you are");
    // No context → no claim.
    expect(render({ fromJobContext: false })).not.toContain("Phil knows where you are");
  });

});

describe("PhilCaptureSharpened — partial-failure honesty (F1)", () => {
  it("a retryable failed photo keeps Save actionable for a photo purpose — the retry path is never dead", () => {
    // After a partial batch failure the tray holds ONLY failed photos (saved
    // ones left). canSave must count them as actionable or Retry is inert.
    const html = render({ photos: [failedPhoto("a")] });
    expect(buttonTag(html, "capture-sharpened-save")).not.toContain('disabled=""');
  });

  it("an unreadable photo alone (no bytes) cannot be saved as a photo batch", () => {
    const html = render({ photos: [unreadablePhoto("a")] });
    expect(buttonTag(html, "capture-sharpened-save")).toContain('disabled=""');
  });

  it("a photo save mirrors the launcher — a failed tile says why, no extra guard", () => {
    const html = render({ photos: [trayPhoto("a"), unreadablePhoto("b")] });
    expect(html).not.toContain('data-testid="capture-unreadable-guard"');
  });
});

describe("PhilCaptureLauncher + provider — the flag actually switches the body", () => {
  it("sharpened provider on → the sharpened body renders instead of the current sheet", () => {
    const html = renderToString(
      createElement(
        PhilSharpenedProvider,
        { sharpened: true, children: null } as never,
        createElement(PhilCaptureLauncher, {
          open: true,
          onClose: () => {},
          initialJobId: "job-1",
        }),
      ),
    );
    expect(html).toContain('data-testid="phil-capture-sharpened"');
    // The dialog accessible name stays exactly "Capture" (smoke contract).
    expect(html).toContain('aria-label="Capture"');
  });

  it("no provider (flag off) → the current sheet, unchanged", () => {
    const html = renderToString(
      createElement(PhilCaptureLauncher, {
        open: true,
        onClose: () => {},
        initialJobId: "job-1",
      }),
    );
    expect(html).not.toContain('data-testid="phil-capture-sharpened"');
    // The current sheet's own camera-first marker.
    expect(html).toContain("Take a photo");
  });
});
