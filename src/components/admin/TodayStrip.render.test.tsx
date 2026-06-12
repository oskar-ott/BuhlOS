import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TodayStrip } from "./TodayStrip";
import { summariseTodayStrip } from "@/domains/timesheets/today-strip";
import type { TodayPulseResponse } from "@/domains/timesheets/types";

/**
 * #185 — SSR smoke for the command-centre Today strip (node env, same
 * renderToString approach as ExceptionsInbox.render.test.tsx).
 *
 * States under test: populated / zero-day (calm, not warning) / pulse-error
 * (chip renders, pending stat survives). The honesty rule — crew is "logged
 * hours today", never "on site" — is asserted on every state.
 */

function pulse(
  hours: Partial<TodayPulseResponse["hours"]> = {}
): TodayPulseResponse {
  return {
    date: "2026-06-12",
    hours: {
      submittedCount: 0,
      submittedTotal: 0,
      approvedCount: 0,
      approvedTotal: 0,
      pendingCount: 0,
      draftCount: 0,
      crewOnSite: 0,
      ...hours,
    },
    snags: { openedToday: 0, resolvedToday: 0 },
    jobs: { activeJobs: 0, jobsWithActivityToday: 0 },
  };
}

function render(props: {
  model: ReturnType<typeof summariseTodayStrip>;
  pulseError: string | null;
  pendingApprovals: number;
}): string {
  return renderToString(createElement(TodayStrip, props));
}

describe("TodayStrip (#185)", () => {
  it("renders a populated day with honest labels and both deep links", () => {
    const html = render({
      model: summariseTodayStrip(
        pulse({
          submittedCount: 2,
          submittedTotal: 15.2,
          approvedCount: 1,
          approvedTotal: 7.6,
          crewOnSite: 3,
        })
      ),
      pulseError: null,
      pendingApprovals: 4,
    });
    expect(html).toContain("Today");
    // The API's Sydney day, rendered — not a recomputed boundary.
    expect(html).toContain("12 June 2026");
    expect(html).toContain("on the clock");
    expect(html).toContain("logged hours today");
    expect(html).toContain("22h 48m");
    // Deep links: /hours for the day view, /hours/approvals for the queue.
    expect(html).toContain('href="/hours"');
    expect(html).toContain('href="/hours/approvals"');
    // The pending figure is the loadSnapshot value, labelled for all dates.
    expect(html).toContain("Pending approval: 4");
    expect(html).toContain("all dates");
    // Honesty: hours logged is not GPS presence.
    expect(html).not.toContain("on site");
  });

  it("renders the pre-work zero state calm, not as a warning", () => {
    const html = render({
      model: summariseTodayStrip(pulse()),
      pulseError: null,
      pendingApprovals: 0,
    });
    expect(html).toContain("No hours logged yet today");
    // Calm = neutral copy, no warning styling anywhere in the strip.
    expect(html).not.toContain("bg-amber");
    expect(html).not.toContain("text-amber");
    // The pending stat still renders (zero is honest, same source as the card).
    expect(html).toContain("Pending approval: 0");
    expect(html).not.toContain("on site");
  });

  it("keeps pending approvals visible on a zero day when older days are queued", () => {
    const html = render({
      model: summariseTodayStrip(pulse()),
      pulseError: null,
      pendingApprovals: 5,
    });
    expect(html).toContain("No hours logged yet today");
    expect(html).toContain("Pending approval: 5");
    expect(html).toContain('href="/hours/approvals"');
  });

  it("renders the per-source error chip and keeps the pending stat", () => {
    const html = render({
      model: null,
      pulseError: "Today pulse API returned 500",
      pendingApprovals: 2,
    });
    expect(html).toContain("Today’s pulse couldn’t load");
    expect(html).toContain("Today pulse API returned 500");
    expect(html).toContain("queues below are unaffected");
    // The pending figure comes from the hours-queue source, so it survives.
    expect(html).toContain("Pending approval: 2");
    // No day stats can honestly render without the pulse.
    expect(html).not.toContain("on the clock");
    expect(html).not.toContain("on site");
  });
});
