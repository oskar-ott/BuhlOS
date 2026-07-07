import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilSyncBanner } from "./PhilSyncBanner";

/**
 * SSR smoke for the sharpened sync/save banner set (§3 — Phil never fails
 * silently). Pins the fixed wording per state, the on-token tint panels, the
 * offline "{n} waiting" chip, the failed-state Try again button + alert role,
 * and that nothing is fabricated (no chip without a real count).
 */
function render(props: Parameters<typeof PhilSyncBanner>[0]) {
  return renderToString(createElement(PhilSyncBanner, props));
}

describe("PhilSyncBanner", () => {
  it("saved — green panel with the backed-up wording", () => {
    const html = render({ state: "saved" });
    expect(html).toContain("Saved &amp; backed up");
    expect(html).toContain("On your phone and up to the office.");
    expect(html).toContain("bg-state-success-subtle-bg");
    expect(html).toContain("bg-state-success-dot");
    expect(html).toContain('role="status"');
  });

  it("sending — blue panel; contextual detail renders when supplied", () => {
    const bare = render({ state: "sending" });
    expect(bare).toContain("Sending…");
    expect(bare).toContain("bg-state-info-subtle-bg");
    const withDetail = render({ state: "sending", detail: "Two photos on the way up." });
    expect(withDetail).toContain("Two photos on the way up.");
  });

  it("offline — amber panel, honest wording, and a waiting chip only with a real count", () => {
    const html = render({ state: "offline", waitingCount: 3 });
    expect(html).toContain("Offline — saved on your phone");
    expect(html).toContain("Sends itself when signal&#x27;s back.");
    expect(html).toContain("bg-state-warning-subtle-bg");
    expect(html).toContain("3 waiting");
    // No count (or zero) → no chip, never a fabricated number.
    expect(render({ state: "offline" })).not.toContain("waiting");
    expect(render({ state: "offline", waitingCount: 0 })).not.toContain("waiting");
  });

  it("failed — red ALERT panel, nothing-lost wording, Try again only when wired", () => {
    const html = render({ state: "failed", onRetry: () => {} });
    expect(html).toContain("Couldn&#x27;t send");
    expect(html).toContain("Nothing&#x27;s lost — it&#x27;s still on your phone.");
    expect(html).toContain("bg-state-danger-subtle-bg");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    // ≥44px tap target on the retry button (field-glove floor).
    expect(html).toContain("min-h-[44px]");
    // No handler → no dead button (truth over theatre).
    expect(render({ state: "failed" })).not.toContain("Try again");
  });

  it("exposes a per-state testid and stays on-token (no raw hex)", () => {
    for (const state of ["saved", "sending", "offline", "failed"] as const) {
      const html = render({ state });
      expect(html).toContain(`data-testid="phil-sync-banner-${state}"`);
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});
