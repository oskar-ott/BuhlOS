import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// Same SSR stubs as PhilTabBar.render.test.tsx — pathname on the Today tab so
// the active-indicator assertions are deterministic.
vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/my-day",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilTabBar } from "./PhilTabBar";
import { PhilShell } from "./PhilShell";
import { CaptureLauncherProvider } from "./captureLauncherContext";

/**
 * The phil_sharpened chrome (Wave 1, dark) — and, just as load-bearing, the
 * OFF contract: with the prop false/absent the bar and shell must render
 * exactly today's ratified layout. The flag flips only via governance (P15);
 * these tests pin both sides so neither can drift silently.
 */
function renderBar(sharpened?: boolean) {
  return renderToString(
    createElement(
      CaptureLauncherProvider,
      null,
      createElement(PhilTabBar, sharpened === undefined ? {} : { sharpened }),
    ),
  );
}

describe("PhilTabBar — sharpened mode (phil_sharpened, dark)", () => {
  it("renders the 5-slot nav: Today · Jobs · [Capture] · Hours · Gear, More gone", () => {
    const html = renderBar(true);
    expect(html).toContain('href="/phil/my-day"');
    expect(html).toContain("Today");
    expect(html).toContain('href="/phil/jobs"');
    expect(html).toContain("Jobs");
    expect(html).toContain('href="/phil/hours"');
    expect(html).toContain("Hours");
    expect(html).toContain('href="/phil/gear"');
    expect(html).toContain("Gear");
    // Account leaves the bar — it lives on the header avatar (PhilHeader).
    expect(html).not.toContain('href="/v2/phil"');
    expect(html).not.toContain(">More<");
  });

  it("keeps the Capture FAB + global camera input identical under the flag", () => {
    const html = renderBar(true);
    expect(html).toContain('aria-label="Capture"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('capture="environment"');
  });

  it("active tab shows the 3px yellow TOP underline (navy icon/label carried by tokens)", () => {
    const html = renderBar(true);
    expect(html).toContain("h-[3px]");
    expect(html).toContain("bg-accent-yellow");
    expect(html).toContain('aria-current="page"');
  });

  it("flag off/absent = today's bar exactly (More + /v2/phil, no Hours tab, no underline)", () => {
    for (const html of [renderBar(false), renderBar(undefined)]) {
      expect(html).toContain('href="/v2/phil"');
      expect(html).toContain("More");
      expect(html).not.toContain('href="/phil/hours"');
      expect(html).not.toContain("h-[3px]");
      // The ratified active indicator (dot under the label) is still there.
      expect(html).toContain("h-1 w-1 rounded-pill");
    }
  });
});

// Same indirection as PhilShell.render.test.tsx — the props object (children
// included) is typed against the component, not spelled at the createElement
// callsite.
function renderShell(props: Parameters<typeof PhilShell>[0]) {
  return renderToString(createElement(PhilShell, props));
}

describe("PhilShell — sharpened header account avatar", () => {
  it("shows the ≥44px avatar link to /v2/phil with initials when sharpened", () => {
    const html = renderShell({
      title: "My day",
      sharpened: true,
      accountInitials: "SP",
      children: "BODY",
    });
    expect(html).toContain('data-testid="phil-header-account"');
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain(">SP<");
    // 44px tap target (field-glove floor).
    expect(html).toContain("h-11 w-11");
  });

  it("falls back to a person glyph — never fabricated initials", () => {
    const html = renderShell({ title: "Jobs", sharpened: true, children: "BODY" });
    expect(html).toContain('data-testid="phil-header-account"');
    expect(html).not.toContain(">SP<");
  });

  it("renders no avatar at all when the flag is off (byte-identical header)", () => {
    const html = renderShell({ title: "Jobs", children: "BODY" });
    expect(html).not.toContain("phil-header-account");
    expect(html).not.toContain('aria-label="Account"');
  });
});
