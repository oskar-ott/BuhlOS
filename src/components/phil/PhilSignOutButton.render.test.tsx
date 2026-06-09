import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The control reads useRouter to bounce back to /v2/login after the logout
// POST. Stub it for SSR (same pattern as PhilCaptureLauncher.render.test.tsx).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

import { PhilSignOutButton } from "./PhilSignOutButton";

/**
 * SSR smoke for the Phil sign-out control — the only way a worker can leave
 * their session from the new Phil shell (the "More" tab Account card). Locks
 * that it renders as a real, named <button> so a silent regression can't strip
 * the affordance, and that it stays a neutral secondary control rather than
 * stealing the accent-yellow reserved for the primary field action.
 *
 * The credentialed end-to-end proof (tap clears buhl_session and lands on
 * /v2/login) belongs to the Preview Smoke suite, not this no-browser test.
 */
function render() {
  return renderToString(createElement(PhilSignOutButton));
}

describe("PhilSignOutButton", () => {
  it("renders a real button labelled Sign out", () => {
    const html = render();
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain('data-testid="phil-logout"');
    expect(html).toContain("Sign out");
  });

  it("is a full-width, glove-sized neutral control (not the accent CTA)", () => {
    const html = render();
    expect(html).toContain("w-full");
    expect(html).toContain("h-12");
    // accent-yellow is reserved for the single primary field action per screen.
    expect(html).not.toContain("bg-accent-yellow");
  });

  it("carries a leading icon for the sign-out affordance", () => {
    expect(render()).toContain("<svg");
  });
});
