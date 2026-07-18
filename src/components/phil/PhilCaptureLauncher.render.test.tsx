import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilCaptureLauncher } from "./PhilCaptureLauncher";

/**
 * SSR smoke for the camera-first Capture launcher (v2). Effects don't run
 * under renderToString, so this is the launcher's first paint: an empty tray
 * (the big "Take a photo" affordance — the FAB fires the OS camera in the
 * same tap, this is the in-sheet fallback/repeat affordance). The no-photo
 * "log something" entry is flag-gated (`observations_inbox`, lean reset):
 * dark by default — the observation write 404s — and offered only when the
 * page threads observationsEnabled. Photo/batch interaction is covered by
 * capture-batch.test.ts (submit loop) and philCapture.test.ts (preselection
 * + payloads); the real-browser open/close proof lives in the Preview Smoke
 * (phil.spec.ts).
 */
describe("PhilCaptureLauncher", () => {
  it("renders nothing when closed", () => {
    const html = renderToString(
      createElement(PhilCaptureLauncher, { open: false, onClose: () => {} })
    );
    expect(html).toBe("");
  });

  it("opens camera-first: photo tray affordance, NO observation entry by default (dark)", () => {
    const html = renderToString(
      createElement(PhilCaptureLauncher, {
        open: true,
        onClose: () => {},
        initialJobId: "job-1",
      })
    );
    // The tray's camera affordance is the prominent first element.
    expect(html).toContain("Take a photo");
    expect(html).toContain("Camera opens by default");
    // Observations are dark by default (safe-by-dark) — the photo path only.
    expect(html).not.toContain("Or log something");
    // The destination step only appears once photos exist — never on first paint.
    expect(html).not.toContain("Where does this go?");
  });

  it("offers the no-photo logging entry only when observationsEnabled is threaded true", () => {
    const html = renderToString(
      createElement(PhilCaptureLauncher, {
        open: true,
        onClose: () => {},
        initialJobId: "job-1",
        observationsEnabled: true,
      })
    );
    // No-photo logging stays reachable (jobs are still loading at first paint).
    expect(html).toContain("Or log something");
    expect(html).toContain("Loading your jobs");
  });

  it("keeps the dialog aria-label 'Capture' byte-identical with dictation wired in (#147)", () => {
    const html = renderToString(
      createElement(PhilCaptureLauncher, {
        open: true,
        onClose: () => {},
        initialJobId: "job-1",
      })
    );
    // The launcher dialog accessible name MUST stay exactly "Capture" — the
    // Phil smoke matches { name: "Capture", exact: true }; the #147 mic in the
    // note fields must not perturb it.
    expect(html).toContain('aria-label="Capture"');
    // The mic is client-only (its device mode resolves after mount) and the note
    // fields appear only once photos exist, so first paint carries no dishonest
    // "no audio leaves the device" claim.
    expect(html.toLowerCase()).not.toContain("no audio");
  });
});
