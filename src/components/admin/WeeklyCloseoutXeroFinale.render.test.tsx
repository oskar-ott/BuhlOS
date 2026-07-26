import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { WeeklyCloseoutXeroFinale, type XeroFinaleGate } from "./WeeklyCloseoutXeroFinale";
import type { ReviewCandidate } from "@/domains/timesheets/xero-closeout";

/**
 * SSR render tests. The finale lives inside a bottom sheet that starts closed,
 * so it is unreachable through the parent surface in a node-only vitest env —
 * it is exported and rendered directly here.
 *
 * SSR runs the first paint only: effects never fire, so these tests pin the
 * pre-fetch states (gated / loading). The states that depend on a live Xero
 * read are pinned as pure functions in domains/timesheets/xero-closeout.test.ts.
 */

const strip = (html: string) => html.replace(/<!-- -->/g, "");

const CANDIDATES: ReviewCandidate[] = [
  { workerId: "w1", workerName: "Alex Buhltest", approvedHours: 38, overtimeHours: 0, hasOvertime: false },
  { workerId: "w2", workerName: "Jamie Moss", approvedHours: 34.2, overtimeHours: 2.2, hasOvertime: true },
];

const OPEN_GATE: XeroFinaleGate = { isAdmin: true, connectionFlag: true, exportFlag: true };

function render(gate: XeroFinaleGate, candidates: ReviewCandidate[] = CANDIDATES) {
  return strip(
    renderToString(
      createElement(WeeklyCloseoutXeroFinale, {
        weekStart: "2024-05-20",
        weekEnd: "2024-05-26",
        periodLabel: "Mon 20 May – Sun 26 May",
        reviewedCount: 2,
        gate,
        candidates,
        onClose: () => {},
      }),
    ),
  );
}

describe("WeeklyCloseoutXeroFinale — gated off", () => {
  it("shows the plain reviewed panel for a leading hand", () => {
    const html = render({ ...OPEN_GATE, isAdmin: false });
    expect(html).toContain("Week reviewed");
    expect(html).toContain("All 2 weeks reviewed");
    // No hint that a push exists — the Xero endpoints are admin-only.
    expect(html).not.toContain("Xero");
  });

  it("shows the plain reviewed panel when the write flag is dark", () => {
    const html = render({ ...OPEN_GATE, exportFlag: false });
    expect(html).not.toContain("Xero");
    expect(html).toContain("BuhlOS on desktop");
  });

  it("shows the plain reviewed panel when the connection flag is dark", () => {
    const html = render({ ...OPEN_GATE, connectionFlag: false });
    expect(html).not.toContain("Xero");
  });

  it("never offers a push button while gated off", () => {
    const html = render({ ...OPEN_GATE, isAdmin: false });
    expect(html).not.toContain("wha-xero-push");
  });
});

describe("WeeklyCloseoutXeroFinale — open gate, first paint", () => {
  it("confirms the review and says it is checking Xero", () => {
    const html = render(OPEN_GATE);
    expect(html).toContain("Week reviewed");
    expect(html).toContain("Checking Xero…");
  });

  it("does NOT offer the push before the connection has been read", () => {
    // canPush is false until a validation preview lands — a button here would
    // promise something unverified.
    const html = render(OPEN_GATE);
    expect(html).not.toContain("wha-xero-push");
  });

  it("does not claim any timesheet was created on first paint", () => {
    const html = render(OPEN_GATE);
    expect(html).not.toContain("Pushed to Xero");
    expect(html).not.toContain("draft timesheets created");
  });

  it("offers a way out while it is still checking", () => {
    expect(render(OPEN_GATE)).toContain("Done");
  });

  it("renders with no approved hours without inventing a total", () => {
    const html = render(OPEN_GATE, []);
    expect(html).toContain("Week reviewed");
    expect(html).not.toContain("wha-xero-push");
  });
});
