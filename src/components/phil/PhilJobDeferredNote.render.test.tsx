import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobDeferredNote } from "./PhilJobDeferredNote";

/**
 * The consolidated "not connected yet" note that replaced the two full-card
 * UC panels (Materials + History). Guards that it stays a single concise,
 * honest note — not a placeholder section pretending to be real, and not
 * admin-speak.
 */
describe("PhilJobDeferredNote", () => {
  it("is one concise note that honestly names the deferred areas + the real next step", () => {
    const html = renderToString(createElement(PhilJobDeferredNote));
    expect(html).toContain("Not connected in Phil yet");
    expect(html).toContain("Materials");
    expect(html).toContain("Job history");
    expect(html).toContain("PM"); // the real next step for materials
  });

  it("drops the old 'Under construction' card language and any admin/office jargon", () => {
    const html = renderToString(createElement(PhilJobDeferredNote)).toLowerCase();
    for (const banned of [
      "under construction",
      "admin",
      "payroll",
      "xero",
      "dashboard",
      "registry",
      "document-control",
    ]) {
      expect(html).not.toContain(banned);
    }
  });
});
