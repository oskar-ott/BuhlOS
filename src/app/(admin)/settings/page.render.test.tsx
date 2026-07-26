import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

/**
 * Lean-reset settings hub re-skin (replica lines 541-563) — page-level SSR
 * smoke. The page is an async server component; we await it for JSX and
 * renderToString the result (node env). Pins:
 *  - the page sub-line replaces the old intro card;
 *  - the Hours policy + Job types sections still mount (client islands render
 *    their loading skeletons under SSR);
 *  - "More settings": notification + task-rule links always, Owner Console
 *    ONLY for the owner role, Xero ONLY when its flag is on, and the honest
 *    "not rebuilt in v2 yet" line for personal settings.
 */

const h = vi.hoisted(() => ({
  role: "boss", // non-"admin" admin-tier role on purpose (no literal-role paths)
  xeroOn: false,
}));

function cookieFor(role: string): string {
  return (
    Buffer.from(JSON.stringify({ userId: "u-test", role })).toString("base64url") +
    ".test-signature"
  );
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "buhl_session" ? { name, value: cookieFor(h.role) } : undefined,
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  },
  usePathname: () => "/settings",
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

// AdminShell is an async server component (it resolves the viewer's nav
// flags); renderToString can't render async components, so mock it to a sync
// passthrough — this test asserts page CONTENT, not the shell chrome.
vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "buhlos-admin-shell" }, children as never),
}));

vi.mock("../../../../api/_lib/feature-flags.js", () => ({
  isFlagEnabled: async (key: string) => (key === "xero_connection" ? h.xeroOn : false),
}));

import SettingsHubPage from "./page";

async function render(): Promise<string> {
  return renderToString(await SettingsHubPage());
}

afterEach(() => {
  h.role = "boss";
  h.xeroOn = false;
});

describe("/settings — lean-reset hub", () => {
  it("renders the sub-line, both working sections and the honest personal-settings line", async () => {
    const html = await render();
    expect(html).toContain("Company-level configuration for BuhlOS.");
    expect(html).toContain("Hours policy");
    expect(html).toContain("Job types");
    expect(html).toContain("More settings");
    expect(html).toContain("Notification settings");
    expect(html).toContain("Task generation rules");
    expect(html).toContain("not rebuilt in v2 yet");
    // The old intro card is gone — the sub-line does its job.
    expect(html).not.toContain("see &ldquo;More settings&rdquo; below");
  });

  it("hides the Owner Console link for a non-owner admin", async () => {
    const html = await render();
    expect(html).not.toContain("Owner Console");
  });

  it("shows the Owner Console link for the owner role only", async () => {
    h.role = "owner";
    const html = await render();
    expect(html).toContain("Owner Console");
    expect(html).toContain("/owner");
    expect(html).toContain("owner only");
  });

  it("shows the Xero link only when the xero_connection flag is on", async () => {
    expect(await render()).not.toContain("Xero connection");
    h.xeroOn = true;
    expect(await render()).toContain("Xero connection");
  });
});
