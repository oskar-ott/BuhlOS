import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// Same SSR stubs as PhilTabBar.render.test.tsx — on a job route, where the
// rooms binding would really be registered.
vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/jobs/j1",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilTabBar } from "./PhilTabBar";
import {
  PhilJobRoomsBarContext,
  type PhilJobRoomsBarBinding,
} from "./philJobRoomsBar";

/**
 * The in-job rooms REBIND of the tab bar (phil_job_rooms, dark — #133).
 *
 * Two contracts under test, both load-bearing:
 *   1. With a binding registered, the four flanking slots become Now · Work ·
 *      Proof · Site IN-PAGE tabs carrying LIVE badge counts — the criterion
 *      instrumentation ("critical state never hidden behind navigation") —
 *      while the Capture FAB + camera input are byte-identical.
 *   2. With NO binding (every screen today; the job screen while the flag is
 *      off) the bar renders exactly the ratified/sharpened link bar.
 */
function renderBar(
  binding: PhilJobRoomsBarBinding | null,
  sharpened = true,
  roomsActive = false,
) {
  return renderToString(
    createElement(
      PhilJobRoomsBarContext.Provider,
      { value: { binding, setBinding: () => {} } },
      createElement(PhilTabBar, { sharpened, roomsActive }),
    ),
  );
}

const binding = (over: Partial<PhilJobRoomsBarBinding> = {}): PhilJobRoomsBarBinding => ({
  active: "now",
  badges: { now: 3, work: 2, proof: 5 },
  onSelect: () => {},
  ...over,
});

describe("PhilTabBar — in-job rooms rebind (phil_job_rooms, dark)", () => {
  it("renders the four room tabs as in-page buttons, not links", () => {
    const html = renderBar(binding());
    for (const room of ["now", "work", "proof", "site"]) {
      expect(html).toContain(`data-testid="phil-room-tab-${room}"`);
    }
    expect(html).toContain(">Now<");
    expect(html).toContain(">Work<");
    expect(html).toContain(">Proof<");
    expect(html).toContain(">Site<");
    // The global route links leave the bar while inside the job.
    expect(html).not.toContain('href="/phil/my-day"');
    expect(html).not.toContain('href="/phil/jobs"');
    expect(html).not.toContain('href="/phil/hours"');
    expect(html).not.toContain('href="/phil/gear"');
    expect(html).toContain('aria-label="Job rooms"');
  });

  it("shows the REAL badge counts — Now red (critical), Work/Proof navy", () => {
    const html = renderBar(binding());
    expect(html).toContain(">3<");
    expect(html).toContain(">2<");
    expect(html).toContain(">5<");
    expect(html).toContain("bg-state-danger"); // Now badge
    expect(html).toContain("bg-brand-navy"); // Work/Proof badges
    // Screen-reader path carries the counts too.
    expect(html).toContain('aria-label="Now — 3 flagged"');
    expect(html).toContain('aria-label="Work — 2 flagged"');
    expect(html).toContain('aria-label="Proof — 5 flagged"');
  });

  it("renders NO badge pill for a zero count — never a fabricated 0", () => {
    const html = renderBar(binding({ badges: { now: 0, work: 0, proof: 0 } }));
    expect(html).not.toContain("bg-state-danger");
    expect(html).toContain('aria-label="Now"');
    expect(html).toContain('aria-label="Site"');
  });

  it("marks the active room with the yellow top underline + aria-current", () => {
    const html = renderBar(binding({ active: "proof" }));
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("h-[3px]");
    expect(html).toContain("bg-accent-yellow");
  });

  it("keeps the Capture FAB + global camera input identical in rooms mode", () => {
    const html = renderBar(binding());
    expect(html).toContain('aria-label="Capture"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('capture="environment"');
  });

  it("roomsActive (server-known, no client binding yet) → the ROOM bar renders from the FIRST paint, not the global links", () => {
    // The job page passes roomsActive from the server-resolved phil_job_rooms
    // flag, so the SSR paint never shows Hours/Gear links a mis-tap could
    // exit the job through. No binding yet ⇒ no badges (never invented) and
    // the job screen's initial room (Now) is marked active.
    const html = renderBar(null, true, true);
    for (const room of ["now", "work", "proof", "site"]) {
      expect(html).toContain(`data-testid="phil-room-tab-${room}"`);
    }
    expect(html).toContain('aria-label="Job rooms"');
    expect(html).not.toContain('href="/phil/my-day"');
    expect(html).not.toContain('href="/phil/hours"');
    expect(html).not.toContain('href="/phil/gear"');
    // No client-derived counts yet — no badge pills, plain aria-labels.
    expect(html).not.toContain("flagged");
    expect(html).toContain('aria-label="Now"');
    expect(html).toContain('aria-current="true"'); // Now is the initial room
  });

  it("a registered binding WINS over the pending stand-in (badges/handlers take over)", () => {
    const html = renderBar(binding({ active: "proof" }), true, true);
    expect(html).toContain('aria-label="Now — 3 flagged"');
    expect(html).toContain('aria-label="Proof — 5 flagged"');
  });

  it("with NO binding the bar is the normal sharpened link bar (flag-off absent)", () => {
    const html = renderBar(null);
    expect(html).not.toContain("phil-room-tab-");
    expect(html).toContain('aria-label="App tabs"');
    expect(html).toContain('href="/phil/my-day"');
    expect(html).toContain('href="/phil/hours"');
    expect(html).toContain('href="/phil/gear"');
  });

  it("with NO binding and no sharpened flag the ratified bar is untouched", () => {
    const html = renderBar(null, false);
    expect(html).not.toContain("phil-room-tab-");
    expect(html).toContain('href="/v2/phil"');
    expect(html).toContain(">More<");
  });
});
