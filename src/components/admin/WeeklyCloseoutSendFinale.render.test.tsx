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
    // The recipient line is the REAL Settings list, read after mount — the
    // first paint names accounts generically, never a hard-coded person.
    expect(html).toContain('data-testid="wha-send-recipients"');
    expect(html).not.toContain("Tia · accounts");
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
  // Rejected + unreviewed days are ACTIONABLE — fixes are mid-flight.
  const unfinished = {
    outstanding: {
      sentBackDays: 2,
      notReviewedDays: 1,
      notInYetDays: 0,
      actionableDays: 3,
      total: 3,
    },
  };

  it("actionable days outstanding → the wait choice LEADS; send is a REAL secondary button", () => {
    const html = render(unfinished);
    expect(html).toContain('data-testid="wha-send-wait"');
    expect(html).toContain("Wait for the full week");
    // Send stays findable — a ghost read as "can't send" on the first live
    // pay run (2026-08-17), so it must render as a bordered button.
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

  it("crew away all week (not-in-yet only) → Send to Tia LEADS with an FYI, never a wait wall (owner call 2026-08-17)", () => {
    // The live pay-run case: guys on holiday never submit — normal. Their
    // days will never arrive, so waiting on them would block every send.
    const html = render({
      outstanding: {
        sentBackDays: 0,
        notReviewedDays: 0,
        notInYetDays: 5,
        actionableDays: 0,
        total: 5,
      },
    });
    expect(html).toContain("Send to Tia");
    expect(html).not.toContain('data-testid="wha-send-wait"');
    expect(html).not.toContain('data-testid="wha-send-outstanding"');
    expect(html).toContain('data-testid="wha-send-fyi"');
    expect(html).toContain("Not everyone’s week is here");
    expect(html).toContain("5 days never came in");
    expect(html).toContain("it sends without them");
  });

  it("a finished week keeps today's layout — Send to Tia leads, no notices", () => {
    const html = render({
      outstanding: {
        sentBackDays: 0,
        notReviewedDays: 0,
        notInYetDays: 0,
        actionableDays: 0,
        total: 0,
      },
    });
    expect(html).toContain("Send to Tia");
    expect(html).not.toContain('data-testid="wha-send-wait"');
    expect(html).not.toContain('data-testid="wha-send-outstanding"');
    expect(html).not.toContain('data-testid="wha-send-fyi"');
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

describe("WeeklyCloseoutSendFinale — approvals still saving (2026-10-06 audit)", () => {
  // Approvals are fired in the background so the boss never waits between
  // people, so this screen can open while the last ones are still being
  // written. A send then reads those days as "submitted" and leaves them off
  // the sheet with NO error — so while anything is saving, there is no send.
  const inFlight = {
    // While approvals are in flight the overlay hasn't caught up, so the
    // week-wide count calls those days "still waiting for review".
    outstanding: {
      sentBackDays: 0,
      notReviewedDays: 9,
      notInYetDays: 2,
      actionableDays: 9,
      total: 11,
    },
    savingCount: 2,
  };

  it("no send button of any kind while saves are in flight — a disabled 'Saving approvals…' instead", () => {
    const html = render(inFlight);
    expect(html).toContain('data-testid="wha-send-saving"');
    expect(html).toContain("Saving approvals…");
    expect(html).not.toContain('data-testid="wha-send-accounts"');
    expect(html).not.toContain("Send anyway");
    expect(html).not.toContain("Send to Tia</button>");
  });

  it("says why, in site language — and doesn't call the in-flight days 'waiting for review'", () => {
    const html = render(inFlight);
    expect(html).toContain('data-testid="wha-send-saving-note"');
    expect(html).toContain("2 people’s hours are still saving");
    expect(html).not.toContain('data-testid="wha-send-outstanding"');
    expect(html).not.toContain('data-testid="wha-send-wait"');
    expect(html).not.toContain('data-testid="wha-send-fyi"');
  });

  it("never shows 'No approved hours' while the approvals that would fill it are still landing", () => {
    const html = render({ ...inFlight, candidates: [] });
    expect(html).not.toContain("No approved hours");
    expect(html).toContain('data-testid="wha-send-saving"');
  });

  it("one worker saving reads in the singular", () => {
    expect(render({ savingCount: 1 })).toContain("1 person’s hours are still saving");
  });

  it("nothing saving → today's send face, unchanged", () => {
    const html = render({ savingCount: 0 });
    expect(html).toContain('data-testid="wha-send-accounts"');
    expect(html).toContain("Send to Tia");
    expect(html).not.toContain('data-testid="wha-send-saving"');
  });
});

describe("WeeklyCloseoutSendFinale — names, not just counts (2026-10-09)", () => {
  // The 5 Oct finale said "2 days never came in" and nobody could tell it
  // meant Dylan's and Stephen's Fridays. The notices now name them in the
  // sheet's own words — and the sheet itself carries the same list for Tia.
  const fridays = {
    outstanding: { sentBackDays: 0, notReviewedDays: 0, notInYetDays: 2, actionableDays: 0, total: 2 },
    outstandingLines: [
      { workerName: "Dylan Sinclair", reason: "nothing logged", days: "Fri 2 Oct", kind: "notInYet" as const },
      { workerName: "Stephen Mayne", reason: "nothing logged", days: "Fri 2 Oct", kind: "notInYet" as const },
    ],
  };

  it("the FYI notice names who and which day — and says the sheet lists them for Tia", () => {
    const html = render(fridays);
    expect(html).toContain('data-testid="wha-send-fyi-lines"');
    expect(html).toContain("Dylan Sinclair");
    expect(html).toContain("Stephen Mayne");
    expect(html).toContain("nothing logged: Fri 2 Oct");
    expect(html).toContain("names them for Tia");
    // Still a send-first face: holiday crew never hold the pay run.
    expect(html).toContain("Send to Tia");
  });

  it("the 'week isn't finished' notice names the days still mid-flight (not the not-in-yet ones)", () => {
    const html = render({
      outstanding: { sentBackDays: 1, notReviewedDays: 2, notInYetDays: 1, actionableDays: 3, total: 4 },
      outstandingLines: [
        { workerName: "Louis Kane", reason: "waiting for approval", days: "Mon 28 Sep, Tue 29 Sep", kind: "notReviewed" },
        { workerName: "Louis Kane", reason: "sent back for a fix", days: "Wed 30 Sep", kind: "sentBack" },
        { workerName: "Dylan Sinclair", reason: "nothing logged", days: "Fri 2 Oct", kind: "notInYet" },
      ],
    });
    expect(html).toContain('data-testid="wha-send-outstanding-lines"');
    expect(html).toContain("waiting for approval: Mon 28 Sep, Tue 29 Sep");
    expect(html).toContain("sent back for a fix: Wed 30 Sep");
    // The not-in-yet line lives in the FYI notice, which the hold replaces.
    expect(html).not.toContain("nothing logged: Fri 2 Oct");
  });

  it("no lines → the notices render as before (older callers pass none)", () => {
    const html = render({ outstanding: fridays.outstanding });
    expect(html).toContain("2 days never came in");
    expect(html).not.toContain('data-testid="wha-send-fyi-lines"');
  });
});
