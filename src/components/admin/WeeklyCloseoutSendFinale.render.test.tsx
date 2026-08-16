import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { WeeklyCloseoutSendFinale } from "./WeeklyCloseoutSendFinale";
import type { ReviewCandidate } from "@/domains/timesheets/xero-closeout";

/**
 * Static-render guards for the phone closeout's send-to-accounts finale
 * (owner pull 2026-08-15) — the screen that takes the Xero finale's slot while
 * TIMESHEETS_EMAIL_TO is set. Pins the review face: the owner-asked label,
 * the same worker rows the boss just approved, and the honest empty state
 * (no approved hours → no send button, never a hopeful one).
 */

const candidates: ReviewCandidate[] = [
  {
    workerId: "u_mick",
    workerName: "Mick Doran",
    approvedHours: 40,
    overtimeHours: 2,
    hasOvertime: true,
  },
  {
    workerId: "u_sam",
    workerName: "Sam Perry",
    approvedHours: 38,
    overtimeHours: 0,
    hasOvertime: false,
  },
];

const base = {
  weekStart: "2026-08-10",
  weekEnd: "2026-08-16",
  periodLabel: "Mon 10 Aug – Sun 16 Aug",
  reviewedCount: 2,
  candidates,
  onClose: () => {},
};

// renderToString interleaves `<!-- -->` markers between JSX expressions —
// strip them so assertions can match the text a person actually sees.
const render = (props: Partial<ComponentProps<typeof WeeklyCloseoutSendFinale>> = {}) =>
  renderToString(createElement(WeeklyCloseoutSendFinale, { ...base, ...props })).replace(
    /<!-- -->/g,
    "",
  );

describe("WeeklyCloseoutSendFinale", () => {
  it("review face: Send to Tia action over the reviewed week", () => {
    const html = render();
    expect(html).toContain("Week reviewed");
    expect(html).toContain('data-testid="wha-send-accounts"');
    expect(html).toContain("Send to Tia");
    expect(html).toContain("Tia · accounts");
    expect(html).toContain("Mon 10 Aug – Sun 16 Aug");
  });

  it("lists exactly the approved rows the boss just stepped through", () => {
    const html = render();
    expect(html).toContain("Mick Doran");
    expect(html).toContain("Sam Perry");
    expect(html).toContain("2 timesheets");
    // OT named only where it exists — Mick's row, not Sam's.
    expect(html.match(/incl\./g)?.length).toBe(1);
  });

  it("no approved hours → honest empty state, no send button", () => {
    const html = render({ candidates: [] });
    expect(html).toContain("No approved hours");
    expect(html).not.toContain('data-testid="wha-send-accounts"');
  });

  it("names the interim process so nobody thinks Xero was pushed", () => {
    expect(render()).toContain("While Xero is out of action");
  });
});

describe("WeeklyCloseoutSendFinale — wait-or-send (owner pull 2026-08-16)", () => {
  const unfinished = {
    outstanding: { sentBackDays: 2, notReviewedDays: 1, notInYetDays: 0, total: 3 },
  };

  it("days still outstanding → the wait choice LEADS and send is demoted to 'Send anyway'", () => {
    const html = render(unfinished);
    expect(html).toContain('data-testid="wha-send-wait"');
    expect(html).toContain("Wait for the full week");
    // Send stays available — the interim email stamps nothing — but demoted.
    expect(html).toContain('data-testid="wha-send-accounts"');
    expect(html).toContain("Send anyway");
    expect(html).not.toContain("Send to Tia</button>");
    // The wait button comes FIRST in the footer.
    expect(html.indexOf("wha-send-wait")).toBeLessThan(html.indexOf("wha-send-accounts"));
  });

  it("says exactly what the sheet would miss, in site language", () => {
    const html = render(unfinished);
    expect(html).toContain('data-testid="wha-send-outstanding"');
    expect(html).toContain("The week isn’t finished");
    expect(html).toContain("2 days sent back for a fix · 1 day still waiting for review");
    expect(html).toContain("days that land later won’t be on it");
  });

  it("a finished week keeps today's layout — Send to Tia leads, no warning", () => {
    const html = render({
      outstanding: { sentBackDays: 0, notReviewedDays: 0, notInYetDays: 0, total: 0 },
    });
    expect(html).toContain("Send to Tia");
    expect(html).not.toContain('data-testid="wha-send-wait"');
    expect(html).not.toContain('data-testid="wha-send-outstanding"');
  });

  it("no outstanding prop (desktop caller / older mount) → unchanged send-first face", () => {
    const html = render();
    expect(html).toContain("Send to Tia");
    expect(html).not.toContain('data-testid="wha-send-wait"');
  });

  it("nothing approved AND days outstanding → still the honest empty state, never 'Send anyway'", () => {
    const html = render({ candidates: [], ...unfinished });
    expect(html).toContain("No approved hours");
    expect(html).not.toContain('data-testid="wha-send-accounts"');
    expect(html).not.toContain('data-testid="wha-send-wait"');
  });
});
