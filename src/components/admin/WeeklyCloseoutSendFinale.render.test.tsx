import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import { WeeklyCloseoutSendFinale } from "./WeeklyCloseoutSendFinale";
import type { ReviewCandidate } from "@/domains/timesheets/xero-closeout";
import type { HoldUpLine } from "@/domains/timesheets/week-holdups";

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
  renderToString(createElement(WeeklyCloseoutSendFinale, { ...base, ...props }))
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'");

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

// What the closeout hands the finale (week-holdups.ts) — the 5 Oct shapes.
const louisWaiting: HoldUpLine = {
  workerId: "u_louis",
  workerName: "Louis Kane",
  kind: "waiting",
  dates: ["2026-09-28", "2026-09-29"],
  days: "Mon 28 Sep, Tue 29 Sep",
  hours: 17.2,
};
const louisSentBack: HoldUpLine = {
  workerId: "u_louis",
  workerName: "Louis Kane",
  kind: "sentBack",
  dates: ["2026-09-30"],
  days: "Wed 30 Sep",
  hours: 7.6,
};
const stephenFailed: HoldUpLine = {
  workerId: "u_stephen",
  workerName: "Stephen Mayne",
  kind: "failed",
  dates: ["2026-10-01"],
  days: "Thu 1 Oct",
  hours: 7.6,
  why: "No answer — it may not have gone through.",
};
const anaDraft: HoldUpLine = {
  workerId: "u_ana",
  workerName: "Ana Ruiz",
  kind: "draft",
  dates: ["2026-10-02"],
  days: "Fri 2 Oct",
  hours: 7.6,
};
const dylanMissing: HoldUpLine = {
  workerId: "u_dylan",
  workerName: "Dylan Sinclair",
  kind: "missing",
  dates: ["2026-10-02"],
  days: "Fri 2 Oct",
  hours: 0,
};
const remedies = { approve: () => {}, takeBack: () => {}, sendIn: () => {}, check: () => {} };

describe("WeeklyCloseoutSendFinale — every hold-up comes with its fix (owner pull 2026-10-12)", () => {
  const unfinished = {
    holdUps: [louisWaiting, louisSentBack, stephenFailed, anaDraft, dylanMissing],
    remedies,
  };

  it("names each day still to settle — with a one-tap fix on the line itself", () => {
    const html = render(unfinished);
    expect(html).toContain('data-testid="wha-holdups"');
    expect(html).toContain("Still to settle · 4 days");
    expect(html).toContain("waiting for approval: Mon 28 Sep, Tue 29 Sep");
    expect(html).toContain("Approve 17h 12m");
    expect(html).toContain("sent back for a fix: Wed 30 Sep");
    expect(html).toContain('data-testid="wha-holdup-takeback"');
    expect(html).toContain("approve didn't go through: Thu 1 Oct");
    expect(html).toContain("No answer — it may not have gone through. Nothing's lost — approve again.");
    expect(html).toContain("Approve again");
    expect(html).toContain('data-testid="wha-holdup-check"');
  });

  it("days that never came in inform — a saved draft can be sent in from here; nothing logged just names it", () => {
    const html = render(unfinished);
    expect(html).toContain('data-testid="wha-notin"');
    expect(html).toContain("saved but not sent in: Fri 2 Oct");
    expect(html).toContain('data-testid="wha-holdup-sendin"');
    expect(html).toContain("nothing logged: Fri 2 Oct");
    expect(html).toContain("named on the sheet so Tia knows");
  });

  it("the fixes lead — sending without them stays a REAL button, and 'Wait for the full week' is gone", () => {
    const html = render(unfinished);
    expect(html).toContain('data-testid="wha-send-accounts"');
    expect(html).toContain("Send without those 4 days");
    expect(html).toContain('data-testid="wha-send-later"');
    expect(html).not.toContain("Wait for the full week");
    expect(html).not.toContain("Send to Tia</button>");
  });

  it("only mid-flight days hold the send — drafts and missing days alone keep Send to Tia leading (owner call 2026-08-17)", () => {
    const html = render({ holdUps: [anaDraft, dylanMissing], remedies });
    expect(html).toContain("Send to Tia");
    expect(html).not.toContain('data-testid="wha-holdups"');
    expect(html).toContain('data-testid="wha-notin"');
    expect(html).toContain("the sheet sends without them");
  });

  it("without office-tier fixes (no take back / send in) the line still names the day — never a dead button", () => {
    const html = render({ ...unfinished, remedies: { approve: () => {} } });
    expect(html).not.toContain('data-testid="wha-holdup-takeback"');
    expect(html).not.toContain('data-testid="wha-holdup-sendin"');
    expect(html).toContain("sent back for a fix: Wed 30 Sep");
  });

  it("a person whose write is saving shows 'Saving…' instead of buttons", () => {
    const html = render({ ...unfinished, busyIds: ["u_ana"] });
    expect(html).not.toContain('data-testid="wha-holdup-sendin"');
    expect(html).toContain("Saving…");
  });

  it("a finished week keeps today's layout — Send to Tia leads, no lists", () => {
    const html = render({ holdUps: [], remedies });
    expect(html).toContain("Send to Tia");
    expect(html).not.toContain('data-testid="wha-holdups"');
    expect(html).not.toContain('data-testid="wha-notin"');
  });

  it("nothing approved yet but days to settle → no send, and it says to approve them above", () => {
    const html = render({ candidates: [], ...unfinished });
    expect(html).toContain("No approved hours");
    expect(html).toContain("Approve the days above, then send.");
    expect(html).not.toContain('data-testid="wha-send-accounts"');
    expect(html).toContain("Approve 17h 12m");
  });
});

describe("WeeklyCloseoutSendFinale — approvals still saving (2026-10-06 audit)", () => {
  // Approvals are fired in the background so the boss never waits between
  // people, so this screen can open while the last ones are still being
  // written. A send then reads those days as "submitted" and leaves them off
  // the sheet with NO error — so while anything is saving, there is no send.
  const inFlight = { holdUps: [louisWaiting, dylanMissing], remedies, savingCount: 2 };

  it("no send button of any kind while saves are in flight — a disabled 'Saving approvals…' instead", () => {
    const html = render(inFlight);
    expect(html).toContain('data-testid="wha-send-saving"');
    expect(html).toContain("Saving approvals…");
    expect(html).not.toContain('data-testid="wha-send-accounts"');
    expect(html).not.toContain("Send to Tia</button>");
  });

  it("says why, in site language — and doesn't list the in-flight days as still to settle", () => {
    const html = render(inFlight);
    expect(html).toContain('data-testid="wha-send-saving-note"');
    expect(html).toContain("2 people’s hours are still saving");
    expect(html).not.toContain('data-testid="wha-holdups"');
    expect(html).not.toContain('data-testid="wha-notin"');
  });

  it("names who is saving when it knows", () => {
    expect(render({ savingCount: 2, savingNames: ["Mick Doran", "Sam Perry"] })).toContain(
      "Mick’s and Sam’s hours are still saving",
    );
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
