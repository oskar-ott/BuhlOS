import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TimesheetRecipientsSection } from "./TimesheetRecipientsSection";

/**
 * Static-render guard for the /settings timesheet-recipients island (owner
 * pull 2026-08-16). It self-fetches on mount, so a server render can only pin
 * the honest first face: a loading state — never a fabricated empty list that
 * would flash "switched off" before the truth arrives.
 */

describe("TimesheetRecipientsSection", () => {
  it("first face is loading, never a fabricated list state", () => {
    const html = renderToString(createElement(TimesheetRecipientsSection, { canEdit: true }));
    expect(html).toContain('data-testid="timesheet-recipients-loading"');
    expect(html).toContain("Loading the recipient list");
    expect(html).not.toContain("switched off");
  });
});
