import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// PhilTabBar reads usePathname for the active-tab indicator and the
// "are we on a job home" decision; the mounted PhilCaptureLauncher reads
// useRouter for the evidence deep-link. Stub both for SSR (same pattern as
// PhilShell.render.test.tsx / PhilCaptureLauncher.render.test.tsx).
vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/my-day",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilTabBar } from "./PhilTabBar";

/**
 * Locks the Phil bottom-nav contract — and specifically the global Capture
 * entry point, the universal field action present on every Phil screen.
 *
 * This is the one capture affordance with no other automated guard: the pure
 * launcher logic is covered by philCapture.test.ts, the launcher chooser by
 * PhilCaptureLauncher.render.test.tsx, and the evidence domain by
 * evidence.test.ts — but nothing else asserts that the FAB itself renders as a
 * real, named button or that the launcher stays closed until it's tapped. A
 * silent regression here (FAB dropped, mislabelled, or the modal rendered
 * open) would strand workers with no way to capture; this test runs in normal
 * CI (no browser) so it catches that on every PR.
 *
 * The credentialed end-to-end proof that tapping the FAB opens the launcher
 * lives in tests/playwright/smoke/phil.spec.ts (Preview Smoke).
 */
describe("PhilTabBar", () => {
  const html = renderToString(createElement(PhilTabBar));

  it("renders the four field tabs with their canonical hrefs", () => {
    expect(html).toContain('aria-label="App tabs"');
    // Left tabs.
    expect(html).toContain('href="/phil/my-day"');
    expect(html).toContain("Today");
    expect(html).toContain('href="/phil/jobs"');
    expect(html).toContain("Jobs");
    // Right tabs.
    expect(html).toContain('href="/phil/gear"');
    expect(html).toContain("Gear");
    expect(html).toContain('href="/v2/phil"');
    expect(html).toContain("More");
  });

  it("renders the centre Capture FAB as a named button (the universal field action)", () => {
    // Accessible name comes from aria-label so screen-reader + Playwright
    // getByRole('button', { name: 'Capture' }) both resolve it.
    expect(html).toContain('aria-label="Capture"');
    // The visible "Capture" label sits under the FAB.
    expect(html).toContain("Capture");
  });

  it("keeps the capture launcher closed until the FAB is tapped (no always-open modal)", () => {
    // The launcher is mounted but returns null while closed — there must be no
    // dialog, and none of the launcher's sheet copy, in the initial render.
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Take a photo");
    expect(html).not.toContain("Or log something");
    expect(html).not.toContain("Where does this go?");
  });

  it("mounts the global camera input for the camera-first FAB tap", () => {
    // The hidden file input must exist in the initial render — the FAB click
    // fires it synchronously (same user gesture), so it can't be conditional.
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('capture="environment"');
  });
});
