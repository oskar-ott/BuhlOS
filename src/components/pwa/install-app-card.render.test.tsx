import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { InstallAppCard } from "./InstallAppCard";

/**
 * SSR smoke for the install-instructions card (More tab). Effects don't run
 * under renderToString, so this covers the pre-hydration render: the card is
 * visible with the browser-menu steps (the non-iOS default). Platform
 * specialisation and the standalone self-hide are client-only behaviour.
 */
describe("InstallAppCard", () => {
  it("renders the home-screen pitch and the manual steps", () => {
    const html = renderToString(createElement(InstallAppCard));
    expect(html).toContain("Put BuhlOS on your home screen");
    expect(html).toContain("tap from the ute");
    expect(html).toContain("buhlos.com");
    expect(html).toContain("Add to Home screen");
    // Single brand — never the internal name.
    expect(html).not.toMatch(/\bPhil\b/);
  });

  it("numbers the steps so a worker can follow them one-handed", () => {
    const html = renderToString(createElement(InstallAppCard));
    expect(html).toContain(">1<");
    expect(html).toContain(">2<");
    expect(html).toContain(">3<");
  });
});
