import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// Mutable pathname so the job-route case can exercise the rooms fallback.
// The factory only CLOSES OVER the variable (evaluated at render time), so
// the hoisted mock never reads it early.
let pathname = "/phil/my-day";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilShell } from "./PhilShell";
import { PhilTabBar } from "./PhilTabBar";
import { PhilChromeHintProvider } from "./philChromeHint";
import { resetPhilChromeMemoryForTests } from "./philChromeMemory";
import type { PhilChromeHint } from "@/domains/phil/chrome-hint";

/**
 * The COLD-START chrome contract (philChromeHint.tsx): the /phil layout
 * parses the `phil_chrome` cookie and provides it render-time, so a
 * flag-less skeleton render inside the provider must SSR the remembered
 * chrome FROM THE FIRST BYTE — that is the whole fix for "the app loads up
 * still showing the old layout" (field report 2026-08-23). renderToString is
 * the server pass (effects never run, the chrome memory stays cold), so
 * everything asserted here holds before hydration, on the slowest field
 * connection.
 */
function renderShell(
  hint: PhilChromeHint | null,
  props: Partial<Parameters<typeof PhilShell>[0]> = {}
) {
  const shellProps: Parameters<typeof PhilShell>[0] = {
    title: "My day",
    children: "BODY",
    ...props,
  };
  // Same props-object indirection as PhilShell.render.test.tsx — children
  // ride inside the typed props.
  const providerProps: Parameters<typeof PhilChromeHintProvider>[0] = {
    hint,
    children: createElement(PhilShell, shellProps),
  };
  return renderToString(createElement(PhilChromeHintProvider, providerProps));
}

describe("philChromeHint — flag-less SSR renders the remembered chrome", () => {
  beforeEach(() => resetPhilChromeMemoryForTests());
  afterEach(() => {
    pathname = "/phil/my-day";
    resetPhilChromeMemoryForTests();
  });

  it("sharpened hint → the sharpened chrome from the first byte (white header, Hours tab, top underline)", () => {
    const html = renderShell({ sharpened: true, jobRooms: false });
    // Sharpened bar: Hours joins, More leaves the bar…
    expect(html).toContain('href="/phil/hours"');
    expect(html).not.toContain(">More<");
    expect(html).toContain("h-[3px]");
    // …and the account avatar keeps /v2/phil reachable on the white header.
    expect(html).toContain('data-testid="phil-header-account"');
    expect(html).not.toContain("bg-brand-navy text-text-inverse shadow-card");
    // No name resolved on a skeleton → person glyph, never fabricated
    // initials (P7).
    expect(html).not.toContain(">SP<");
  });

  it("no hint (cookie absent/invalid) → today's ratified chrome, byte-identical to a hint-less render", () => {
    const withNullHint = renderShell(null);
    const bareProps: Parameters<typeof PhilShell>[0] = { title: "My day", children: "BODY" };
    const bare = renderToString(createElement(PhilShell, bareProps));
    expect(withNullHint).toBe(bare);
    expect(withNullHint).toContain("bg-brand-navy text-text-inverse shadow-card");
    expect(withNullHint).toContain(">More<");
    expect(withNullHint).not.toContain('href="/phil/hours"');
  });

  it("explicit server-resolved props beat a contradicting hint both ways", () => {
    const off = renderShell({ sharpened: true, jobRooms: true }, { sharpened: false });
    expect(off).toContain("bg-brand-navy text-text-inverse shadow-card");
    expect(off).not.toContain('href="/phil/hours"');

    const on = renderShell(null, { sharpened: true });
    expect(on).toContain('href="/phil/hours"');
    expect(on).toContain('data-testid="phil-header-account"');
  });

  it("a jobRooms hint keeps the ROOM slots on a job-detail skeleton (no global-tab mis-tap window)", () => {
    pathname = "/phil/jobs/j1";
    const html = renderShell({ sharpened: true, jobRooms: true });
    expect(html).toContain('aria-label="Job rooms"');
    expect(html).toContain('data-testid="phil-room-tab-now"');
    // Pending stand-in carries no badges — counts are never invented (P7).
    expect(html).not.toContain("bg-state-danger");
  });

  it("the jobRooms hint only bites on a job-detail route — global tabs elsewhere", () => {
    const providerProps: Parameters<typeof PhilChromeHintProvider>[0] = {
      hint: { sharpened: true, jobRooms: true },
      children: createElement(PhilTabBar, {}),
    };
    const html = renderToString(createElement(PhilChromeHintProvider, providerProps));
    expect(html).toContain('aria-label="App tabs"');
    expect(html).not.toContain("phil-room-tab-now");
    expect(html).toContain('href="/phil/hours"');
  });
});
