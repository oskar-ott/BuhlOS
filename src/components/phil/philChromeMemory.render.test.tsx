import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// Job-detail pathname so the rooms-memory fallback would fire here if the
// mounted gate ever leaked into SSR. Same stubs as PhilShell.render.test.tsx.
vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/jobs/job-1",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilShell } from "./PhilShell";
import { PhilTabBar } from "./PhilTabBar";
import { CaptureLauncherProvider } from "./captureLauncherContext";
import {
  rememberPhilChrome,
  resetPhilChromeMemoryForTests,
} from "./philChromeMemory";

/**
 * The mounted-gate contract (philChromeMemory.ts): flag-less chrome renders
 * fall back to the remembered chrome only POST-MOUNT. renderToString is the
 * server pass — effects never run and `mounted` stays false — so even with
 * the memory artificially warmed to full-sharpened, a flag-less render must
 * be BYTE-IDENTICAL to today's default chrome. That is exactly what keeps
 * SSR/hydration consistent and flag-off viewers unchanged; the skeleton only
 * ever sharpens one frame after mount, client-side.
 */
// Same indirection as PhilShell.render.test.tsx — the props object (children
// included) is typed against the component, not spelled at the createElement
// callsite.
function renderShell(overrides: Partial<Parameters<typeof PhilShell>[0]> = {}) {
  const props: Parameters<typeof PhilShell>[0] = {
    title: "Jobs",
    children: "BODY",
    ...overrides,
  };
  return renderToString(createElement(PhilShell, props));
}

function renderBar(props: Parameters<typeof PhilTabBar>[0] = {}) {
  return renderToString(
    createElement(CaptureLauncherProvider, null, createElement(PhilTabBar, props)),
  );
}

describe("phil chrome memory — SSR mounted gate", () => {
  beforeEach(() => {
    resetPhilChromeMemoryForTests();
  });

  it("flag-less PhilShell SSR is byte-identical whether the memory is cold or warm", () => {
    const cold = renderShell();
    rememberPhilChrome({
      sharpened: true,
      rfiRegister: true,
      jobRooms: true,
      accountInitials: "SP",
    });
    const warm = renderShell();
    expect(warm).toBe(cold);
    // And it IS today's default chrome: navy header, More tab, no avatar.
    expect(warm).toContain("bg-brand-navy text-text-inverse shadow-card");
    expect(warm).toContain('href="/v2/phil"');
    expect(warm).not.toContain("phil-header-account");
    expect(warm).not.toContain('href="/phil/hours"');
  });

  it("flag-less PhilTabBar SSR on a job route keeps the GLOBAL tabs even with jobRooms remembered", () => {
    rememberPhilChrome({ sharpened: true, jobRooms: true });
    const html = renderBar();
    // Global tabs, not the rooms takeover — the pathname matches a job detail
    // route, but the memory fallback is gated behind mount.
    expect(html).toContain('aria-label="Phil tabs"');
    expect(html).not.toContain("phil-room-tab-now");
    expect(html).toContain('href="/v2/phil"');
  });

  it("explicit props still win over a contradicting memory (server-resolved beats remembered)", () => {
    rememberPhilChrome({ sharpened: true, jobRooms: true, accountInitials: "XX" });
    const off = renderShell({ sharpened: false, accountInitials: null });
    expect(off).toContain("bg-brand-navy text-text-inverse shadow-card");
    expect(off).not.toContain("phil-header-account");

    const on = renderShell({ sharpened: true, accountInitials: "SP" });
    expect(on).toContain('data-testid="phil-header-account"');
    expect(on).toContain(">SP<");
    expect(on).toContain('href="/phil/hours"');
  });

  it("explicit roomsActive still renders the room slots from the first paint (SSR included)", () => {
    const html = renderBar({ roomsActive: true });
    expect(html).toContain('aria-label="Job rooms"');
    expect(html).toContain('data-testid="phil-room-tab-now"');
    expect(html).not.toContain('href="/v2/phil"');
  });
});
