import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { OfflineBannerView, PhilOfflineBanner } from "./PhilOfflineBanner";

/**
 * SSR render checks (react-dom/server, no jsdom — matching the repo's other
 * .render.test.tsx). The offline-only visibility is driven by useOnline on the
 * client; here we verify the presentational copy and the SSR-safe default.
 */
describe("PhilOfflineBanner", () => {
  it("the view shows honest offline copy with a status role", () => {
    const html = renderToString(createElement(OfflineBannerView));
    expect(html).toContain("offline");
    expect(html).toContain("Changes");
    expect(html).toContain('role="status"');
  });

  it("renders nothing on the server / first paint (online default, no hydration flash)", () => {
    const html = renderToString(createElement(PhilOfflineBanner));
    expect(html).toBe("");
  });
});
