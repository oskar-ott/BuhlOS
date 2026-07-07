import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The component (and the LogHoursSheet it mounts) reads useRouter — stub
// next/navigation for SSR, same pattern as LogHoursSheet.render.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { PhilHoursSharpened } from "./PhilHoursSharpened";
import { addDays, weekStartOf, localDateString } from "@/domains/timesheets/service";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * SSR smoke for the sharpened /phil/hours (Wave 2c). renderToString gives the
 * initial render: this week's card open (its real rows visible), prior weeks
 * folded (their rows absent), real job attribution + status badges, the
 * rejected-day expansion with the real reason + the existing fix flow, the
 * draft-only send button, and the mounted LogHoursSheet. The fold toggle and
 * the send sequence are covered as pure logic in philHoursWeeks.test.ts.
 */

// Real "today" so isWithinBackdateWindow (real clock) agrees with the fixture.
const TODAY = localDateString();
const MONDAY = weekStartOf(TODAY);
const LAST_MONDAY = addDays(MONDAY, -7);

const JOBS = [
  { id: "j1", name: "Level 12 Office Fitout", ref: "IV0041" },
  { id: "j2", name: "Payneham Rd Bakery", ref: null },
];

let seq = 0;
function entry(over: Partial<TimeEntry> & Pick<TimeEntry, "date" | "status">): TimeEntry {
  seq += 1;
  const totalHours = over.totalHours ?? 7.6;
  return {
    id: `e${seq}`,
    userId: "u1",
    date: over.date,
    totalHours,
    ordinaryHours: over.ordinaryHours ?? Math.min(totalHours, 8),
    overtimeHours: over.overtimeHours ?? Math.max(0, totalHours - 8),
    status: over.status,
    allocations: over.allocations ?? [{ jobId: "j1", hours: totalHours }],
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    notes: over.notes ?? null,
    rejectedReason: over.rejectedReason ?? null,
  } as TimeEntry;
}

function render(entries: TimeEntry[], over: Partial<Parameters<typeof PhilHoursSharpened>[0]> = {}) {
  return renderToString(
    createElement(PhilHoursSharpened, {
      entries,
      todayISO: TODAY,
      assignedJobs: JOBS,
      jobsError: false,
      ...over,
    }),
  );
}

describe("PhilHoursSharpened — week cards", () => {
  it("this week open by default; a prior week folded (header only, rows hidden)", () => {
    const html = render([
      entry({ date: MONDAY, status: "approved" }),
      entry({
        date: LAST_MONDAY,
        status: "approved",
        notes: null,
        allocations: [{ jobId: "j2", hours: 7.6 }],
      }),
    ]);
    expect(html).toContain("phil-hours-sharpened");
    // This week: expanded — real attribution + badge visible.
    expect(html).toContain(`phil-hours-week-toggle-${MONDAY}`);
    expect(html).toMatch(new RegExp(`aria-expanded="true"[^>]*aria-controls="phil-hours-week-body-${MONDAY}"`));
    expect(html).toContain("Level 12 Office Fitout");
    expect(html).toContain("IV0041");
    expect(html).toContain("Approved");
    // Last week: folded — header shows the real total, body content absent.
    expect(html).toMatch(new RegExp(`aria-expanded="false"[^>]*aria-controls="phil-hours-week-body-${LAST_MONDAY}"`));
    expect(html).toContain("Last week");
    expect(html).not.toContain("Payneham Rd Bakery"); // lives only in the folded body
  });

  it("a split day lists each real allocation with its hours", () => {
    const html = render([
      entry({
        date: MONDAY,
        status: "approved",
        totalHours: 8,
        ordinaryHours: 8,
        overtimeHours: 0,
        allocations: [
          { jobId: "j1", hours: 5 },
          { jobId: "j2", hours: 3 },
        ],
      }),
    ]);
    expect(html).toContain("Level 12 Office Fitout");
    expect(html).toContain("Payneham Rd Bakery");
    expect(html).toContain("5h");
    expect(html).toContain("3h");
  });

  it("a rejected day expands with the REAL reason and the existing fix flow", () => {
    const html = render([
      entry({
        date: MONDAY,
        status: "rejected",
        rejectedReason: "Lunch break wasn’t deducted — log 7.6h, not 8.6h.",
      }),
    ]);
    expect(html).toContain("Rejected");
    expect(html).toContain("Why it bounced back");
    expect(html).toContain("Lunch break wasn’t deducted");
    // The EXISTING RejectedHoursResubmitSheet, collapsed entry point.
    expect(html).toContain("Fix rejected hours");
  });

  it("mounts the EXISTING LogHoursSheet in this week's card (logging home)", () => {
    const html = render([]);
    expect(html).toContain("Log your day");
    expect(html).toContain("Standard day");
    // Multi-job worker → the sheet's real job picker (attribution guard).
    expect(html).toContain("Pick one");
  });
});

describe("PhilHoursSharpened — send week (draft flush)", () => {
  it("shows the send button ONLY when a real draft exists", () => {
    const withDraft = render([entry({ date: MONDAY, status: "draft" })]);
    expect(withDraft).toContain("Not sent");
    expect(withDraft).toContain("Send this week to the office");
    expect(withDraft).toContain(`phil-hours-send-week-${MONDAY}`);

    const withoutDraft = render([entry({ date: MONDAY, status: "submitted" })]);
    expect(withoutDraft).not.toContain("Send this week to the office");
    // A logged day reads its true status — logging already submits.
    expect(withoutDraft).toContain("Submitted");
  });

  it("an unattributable draft is blocked with the honest reason, never sent silently", () => {
    const html = render([
      entry({ date: MONDAY, status: "draft", allocations: [{ jobId: null, hours: 7.6 }] }),
    ]);
    expect(html).not.toContain("Send this week to the office");
    expect(html).toContain("can’t be sent from here");
    expect(html).toContain("No job attached");
  });
});

describe("PhilHoursSharpened — honest footer", () => {
  it("names the real standard day and no invented reviewer", () => {
    const html = render([]);
    expect(html).toContain("Standard day is 7h 36m");
    expect(html).not.toContain("for review —"); // no "With {name} for review"
    expect(html).not.toContain("lunch out"); // not a domain fact — omitted
  });
});
