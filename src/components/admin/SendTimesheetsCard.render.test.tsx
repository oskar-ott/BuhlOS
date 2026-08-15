import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SendTimesheetsCard } from "./SendTimesheetsCard";

/**
 * Static-render guards for the send-to-accounts card (owner pull 2026-08-15) —
 * the pay-run handoff while the Xero push is out of action. The page only
 * renders it when TIMESHEETS_EMAIL_TO is set; these pin the idle face: the
 * owner-asked label ("Send to Tia"), the sender the owner asked for, and the
 * two-step confirm (the first click must never be the send itself).
 */

const base = {
  fromDate: "2026-08-10",
  toDate: "2026-08-16",
  periodLabel: "10 Aug – 16 Aug",
  notClosed: false,
  workersNeedingAction: 0,
};

const render = (props: Partial<typeof base> = {}) =>
  renderToString(createElement(SendTimesheetsCard, { ...base, ...props }));

describe("SendTimesheetsCard", () => {
  it("carries the owner-asked label and the timesheets@buhlos.com sender", () => {
    const html = render();
    expect(html).toContain("Send to Tia");
    expect(html).toContain("timesheets@buhlos.com");
    expect(html).toContain('data-testid="period-send-accounts"');
  });

  it("first render is the two-step entry — no confirm button, no receipt yet", () => {
    const html = render();
    expect(html).not.toContain('data-testid="period-send-confirm"');
    expect(html).not.toContain('data-testid="period-send-receipt"');
  });

  it("says approved-hours-only so a half-closed period can't surprise anyone", () => {
    expect(render({ notClosed: true })).toContain("Approved hours");
  });
});
