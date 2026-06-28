import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobTypesSection } from "./JobTypesSection";

/**
 * SSR render tests (node env — no jsdom). Effects never run under SSR, so the
 * island renders its loading skeleton first. The four-action wiring + the 409
 * delete-guard message are validated against the live endpoint in preview; the
 * empty-vs-error distinction is a pure markup contract (an empty list is a real
 * empty STATE, never an error) and is pinned here via the loaded branch and the
 * schema test (policy-schema.test.ts accepts `{ jobTypes: [] }`).
 */

describe("JobTypesSection — initial render", () => {
  it("renders the loading skeleton before the list fetch resolves", () => {
    const html = renderToString(createElement(JobTypesSection, { canEdit: true }));
    expect(html).toContain('data-testid="job-types-loading"');
    expect(html).toContain('aria-busy="true"');
    // It does NOT prematurely render the loaded panel, empty state, or an error.
    expect(html).not.toContain('data-testid="job-types-panel"');
    expect(html).not.toContain('data-testid="job-types-empty"');
    expect(html).not.toContain('data-testid="job-types-error"');
  });

  it("renders the loading skeleton for a read-only viewer too", () => {
    const ro = renderToString(createElement(JobTypesSection, { canEdit: false }));
    expect(ro).toContain('data-testid="job-types-loading"');
    expect(ro).not.toContain('data-testid="job-type-add"');
  });
});
