import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HoursPolicySection } from "./HoursPolicySection";

/**
 * SSR render tests (node env — no jsdom). Effects never run under SSR, so the
 * island renders its loading skeleton first; the fetch-driven panel/error are
 * exercised via the pure schema in policy-schema.test.ts. Here we pin the
 * initial markup and the honest-provenance contract.
 */

describe("HoursPolicySection — initial render", () => {
  it("renders the loading skeleton before the policy fetch resolves", () => {
    const html = renderToString(createElement(HoursPolicySection, { canEdit: true }));
    expect(html).toContain('data-testid="hours-policy-loading"');
    expect(html).toContain('aria-busy="true"');
    // It does NOT prematurely render the loaded panel or an error.
    expect(html).not.toContain('data-testid="hours-policy-panel"');
    expect(html).not.toContain('data-testid="hours-policy-error"');
  });

  it("renders the same loading skeleton whether or not the viewer can edit", () => {
    const ro = renderToString(createElement(HoursPolicySection, { canEdit: false }));
    expect(ro).toContain('data-testid="hours-policy-loading"');
    // No save control or error in the loading state regardless of canEdit.
    expect(ro).not.toContain('data-testid="hours-policy-save"');
  });
});
