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
    // Default split mirrors the server's autoSplitOT (OT after the standard
    // day, 7.6h — owner-directed 2026-08-09); pass explicit values to model
    // legacy entries stored under the old 8h boundary.
    ordinaryHours: over.ordinaryHours ?? Math.min(totalHours, 7.6),
    overtimeHours: over.overtimeHours ?? Math.max(0, Math.round((totalHours - 7.6) * 100) / 100),
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
    // The one status vocabulary (status-words.ts): rejected = "Fix needed".
    expect(html).toContain("Fix needed");
    expect(html).toContain("Why it bounced back");
    expect(html).toContain("Lunch break wasn’t deducted");
    // The EXISTING RejectedHoursResubmitSheet, collapsed entry point.
    expect(html).toContain("Fix rejected hours");
  });

  it("a submitted (undecided) day carries the compact 'Change' pill (2026-07-26 owner-directed, one small button per row)", () => {
    // Deliberately NOT today: the logging card at the top of this week's block
    // mounts LogHoursSheet for TODAY, which carries its own submitted-day
    // affordance. Asserting the day ROW's shape means picking a day the log
    // card can't be showing, or the test passes/fails by weekday.
    const notToday = MONDAY === TODAY ? addDays(MONDAY, 1) : MONDAY;
    const html = render([entry({ date: notToday, status: "submitted" })]);
    expect(html).toContain("Waiting on the office");
    expect(html).toContain("phil-edit-submitted");
    expect(html).toContain(">Change<");
    // The full-width collapsed bar is gone from the day rows — the sheet body
    // mounts only once the pill is tapped (client state, not SSR-reachable).
    // Scope to the rows region: when today IS Monday, the "Log your day"
    // section below legitimately shows its own "Change these hours" affordance
    // for the picked (submitted) day.
    const dayRows = html.split("Log your day")[0];
    expect(dayRows).not.toContain("Change these hours");
  });

  it("mounts the EXISTING LogHoursSheet in this week's card (logging home)", () => {
    const html = render([]);
    expect(html).toContain("Log your day");
    expect(html).toContain("Standard day");
    // Two options, no chip row on the standard day (owner-directed
    // 2026-08-09) — the SAME shared sheet, so both renders drop it together;
    // OT lives in the custom sheet (client-state Modal, not SSR-visible).
    expect(html).toContain("Custom / overtime hours");
    expect(html).not.toContain('aria-label="Add overtime to the standard day"');
    expect(html).not.toContain("+1½h");
    // Multi-job worker → the sheet's real job picker (attribution guard).
    expect(html).toContain("Pick one");
  });
});

/**
 * The office fixed a day's hours at approval time (owner-directed "fix it and
 * approve"). A pay change the worker can't see would be the dishonest option —
 * the day carries ONE line with the real before → after and the reason.
 */
describe("PhilHoursSharpened — an adjusted day says so", () => {
  const AMENDED = {
    ...entry({ date: MONDAY, status: "approved", totalHours: 8.6 }),
    amendedBy: "u_admin",
    amendedAt: "2026-06-01T09:00:00Z",
    amendedReason: "Typo — you meant 8h 36m",
    amendedFrom: { totalHours: 8.37, allocations: [{ jobId: "j1", hours: 8.37 }] },
  } as unknown as TimeEntry;

  it("shows the real before → after and the office's reason, in duration words", () => {
    const html = render([AMENDED]);
    expect(html).toContain("phil-hours-adjusted");
    expect(html).toContain("Adjusted by the office");
    expect(html).toContain("8h 22m → 8h 36m");
    expect(html).toContain("Typo — you meant 8h 36m");
    // Never the decimal that caused the incident in the first place.
    expect(html).not.toContain("8.37");
  });

  it("costs an untouched day nothing — no line, no new section (P10)", () => {
    const html = render([entry({ date: MONDAY, status: "approved" })]);
    expect(html).not.toContain("phil-hours-adjusted");
    expect(html).not.toContain("Adjusted by the office");
  });

  it("still names the real status alongside it — the day is approved, and adjusted", () => {
    const html = render([AMENDED]);
    expect(html).toContain("Approved");
    expect(html).toContain("Adjusted by the office");
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
    // A logged day reads its true status — logging already submits. The one
    // vocabulary word for submitted is "Waiting on the office".
    expect(withoutDraft).toContain("Waiting on the office");
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

describe("today's unlogged row (owner-directed, 2026-08-07)", () => {
  it("today carries the same Log pill as any other unlogged day — never a dead end", () => {
    // An unworked weekend is never owed, so a real Sat/Sun "today" renders no
    // unlogged row at all. Pin "today" to the Friday of the same real week —
    // still inside isWithinBackdateWindow's real-clock 14-day window.
    const dow = new Date(TODAY + "T00:00:00").getDay();
    const weekdayToday = dow === 6 ? addDays(TODAY, -1) : dow === 0 ? addDays(TODAY, -2) : TODAY;
    // Log every past weekday this week so "today" is the only missed row.
    const past: TimeEntry[] = [];
    for (let d = MONDAY; d < weekdayToday; d = addDays(d, 1)) {
      past.push(entry({ date: d, status: "approved" }));
    }
    const html = render(past, { todayISO: weekdayToday });
    const pills = html.match(/>Log</g) ?? [];
    expect(pills.length).toBeGreaterThanOrEqual(1);
    // The row keeps its label and loses the old button-less special copy.
    expect(html).toContain("Not logged");
    expect(html).not.toContain("assign it to a job below");
  });
});

/**
 * Owner-directed 2026-08-09: an overtime day shows its STORED split next to
 * the total — "7h 36m + 1h OT" — so the worker can see the OT they tapped
 * landed exactly and will be paid; the week total keeps its number and gains
 * an "incl. Xh OT" line. Both read the stored pay fields (otSplitLabel /
 * summed overtimeHours), never a client-side re-derivation.
 */
describe("PhilHoursSharpened — OT breakdown (total kept, split shown)", () => {
  it("an OT day keeps its total AND shows the stored split under it", () => {
    const html = render([entry({ date: MONDAY, status: "submitted", totalHours: 8.6 })]);
    // The headline total is untouched…
    expect(html).toContain("8h 36m");
    // …and the split line names the standard day + the OT, exactly as tapped.
    expect(html).toContain('data-testid="phil-hours-ot-split"');
    expect(html).toContain("7h 36m + 1h OT");
  });

  it("a standard day renders NO split line — zero noise when there is no OT", () => {
    const html = render([entry({ date: MONDAY, status: "submitted" })]);
    expect(html).not.toContain("phil-hours-ot-split");
    expect(html).not.toContain("+ 0h OT");
  });

  it("a legacy stored split that doesn't reconcile is never invented into a line (P7 guard)", () => {
    const html = render([
      entry({
        date: MONDAY,
        status: "approved",
        totalHours: 8.6,
        // Garbage/legacy: ordinary + overtime ≠ total → otSplitLabel refuses.
        ordinaryHours: 8.6,
        overtimeHours: 0.6,
      }),
    ]);
    expect(html).not.toContain("phil-hours-ot-split");
  });

  it("the week header keeps the total and adds 'incl. Xh OT' from the stored week sum", () => {
    const html = render([
      entry({ date: MONDAY, status: "submitted", totalHours: 8.6 }),
      entry({ date: addDays(MONDAY, 1), status: "submitted" }),
    ]);
    // Total stays the headline number (8.6 + 7.6 = 16.2 → 16h 12m)…
    expect(html).toContain("16h 12m");
    // …with the week's real OT named under it.
    expect(html).toContain(`data-testid="phil-hours-week-ot-${MONDAY}"`);
    expect(html).toContain("incl. 1h OT");
  });

  it("an all-standard week renders NO week OT line", () => {
    const html = render([entry({ date: MONDAY, status: "approved" })]);
    expect(html).not.toContain("phil-hours-week-ot-");
    expect(html).not.toContain("incl.");
  });
});
