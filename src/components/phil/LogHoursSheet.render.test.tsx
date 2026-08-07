import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// LogHoursSheet calls useRouter() (router.refresh() after a successful submit).
// Stub next/navigation for SSR — same pattern as PhilTabBar.render.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { LogHoursSheet } from "./LogHoursSheet";

/**
 * SSR smoke for the LogHoursSheet job-attribution block. renderToString gives
 * the initial render (effects/interaction don't run), which is enough to prove
 * the four attribution states the product rule requires. The actual submitted
 * payload (jobId, not null) and server enforcement are covered by
 * timesheets.test.ts (buildStandardDayPayload) and
 * time-entry-attribution-api.test.ts (the create-path gate).
 */
function render(props: Parameters<typeof LogHoursSheet>[0]) {
  return renderToString(createElement(LogHoursSheet, props));
}

const base = { initialTodayEntry: null, recentEntries: [] as const };

describe("LogHoursSheet — job attribution", () => {
  it("preselects and shows the sole active assigned job (no friction)", () => {
    const html = render({ ...base, assignedJobs: [{ id: "j1", name: "Smith St Rewire" }] });
    expect(html).toContain("Smith St Rewire");
    expect(html).toContain("Assigned job");
    // single job → no "pick one" prompt
    expect(html).not.toContain("Pick one");
    expect(html).toContain("Standard day");
  });

  it("requires a choice when there are multiple active assigned jobs", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
    });
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Smith St Rewire");
    expect(html).toContain("Depot Switchboard");
    expect(html).toContain("Pick one");
  });

  it("the single-job picker note points to 'Split across jobs', not the old contradictory 'bigger block' copy (#424)", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
    });
    // The open multi-job picker carries the single-job note, now pointing at the
    // split action that genuinely exists rather than telling the worker to log
    // the bigger block (which contradicted the "Split across jobs" button).
    expect(html).toContain("This logs one job");
    expect(html).toContain("Split across jobs");
    expect(html).not.toContain("bigger block");
    expect(html).not.toContain("One job per submission");
  });

  it("preselects a valid initialJobId so a launched job context needs no choice", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
      initialJobId: "j2",
    });
    // one is already selected → no outstanding "Pick one" prompt
    expect(html).not.toContain("Pick one");
  });

  it("collapses the multi-job picker to the chosen job (less clutter), with a 'Select a different job' banner", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
      initialJobId: "j2",
    });
    // Collapsed: only the chosen job shows, plus a way to switch…
    expect(html).toContain("Depot Switchboard");
    expect(html).toContain("Select a different job");
    // …the full radiogroup, the search field and the other job are tucked away
    // until the picker is reopened.
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("Search your jobs");
    expect(html).not.toContain("Smith St Rewire");
  });

  it("defaults the multi-job picker to the last-logged job, collapsed, and explains it with the real date", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
      lastLoggedJobId: "j2",
      lastLoggedDate: "2026-06-19",
    });
    // The last-logged job is preselected → no outstanding "Pick one"…
    expect(html).not.toContain("Pick one");
    expect(html).toContain("Depot Switchboard");
    // …shown collapsed (list hidden) with a self-explaining, real-dated sub-line.
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("Your last job");
    expect(html).toContain("19 Jun"); // the real entry date, year-less short form…
    expect(html).not.toContain("19 Jun 2026"); // …not the full ISO/yearful label
    expect(html).toContain("Select a different job");
  });

  it("offers a search field over the jobs in the (re)opened multi-job picker", () => {
    // No default → the picker is open as a required choice, and now carries a
    // search field above the radio list so a worker can find a job by name.
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
    });
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Search your jobs");
    expect(html).toContain("Find a job by name or address");
  });

  it("renders the multi-job picker as the spinning dial, radios intact (owner-directed 2026-08-02)", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
        { id: "j3", name: "Harbour View Fitout" },
      ],
    });
    // The dial replaces the vertical list — fixed-height wheel, same
    // radiogroup/radio semantics the field-readiness smoke drives.
    expect(html).toContain('data-testid="job-dial"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain("Smith St Rewire");
    expect(html).toContain("Harbour View Fitout");
    // Orientation caption so a long list still reads as browsable.
    expect(html).toContain("spin to browse, tap to pick");
  });

  it("keeps the picker expanded while no job is chosen (a required choice is never hidden)", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
    });
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Pick one");
  });

  it("blocks and explains when the worker has no active assigned job", () => {
    const html = render({ ...base, assignedJobs: [] });
    expect(html).toContain("No active assigned job");
    expect(html).toContain("Ask the office");
  });

  it("blocks when assigned jobs failed to load, and offers an in-place retry (H17)", () => {
    const html = render({ ...base, assignedJobs: [], jobsError: true });
    expect(html).toContain("load your jobs");
    // A visible retry — not just the 'pull to refresh' gesture (RefreshButton).
    expect(html).toContain("Try again");
  });
});

function rejectedEntry(allocations: Array<{ jobId: string | null; hours: number; notes: null }>) {
  return {
    id: "te-1",
    userId: "u1",
    date: "2026-06-07",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "rejected" as const,
    rejectedReason: "Wrong job",
    allocations,
    createdAt: "2026-06-07T06:00:00Z",
    updatedAt: "2026-06-07T06:00:00Z",
  };
}

describe("LogHoursSheet — rejected entry fix flow", () => {
  const singleAllocation = [{ jobId: "j1", hours: 7.6, notes: null }];

  it("offers the inline fix-and-resubmit sheet for a rejected single-job entry", () => {
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: rejectedEntry(singleAllocation),
      // Status reflects the SELECTED date only (2026-07-26 fix) — select the
      // entry's own day, as the ?fixDate= deep link does.
      initialDate: "2026-06-07",
    });

    // The rejection reason and the fix action live together on My Day —
    // no dead-end "go open another screen" copy.
    expect(html).toContain("Wrong job");
    expect(html).toContain("Fix rejected hours");
    expect(html).not.toContain("Open Hours history");
    expect(html).not.toContain("legacy My day");
  });

  it("auto-expands the fix sheet when launched from a ?fixDate= deep link", () => {
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: rejectedEntry(singleAllocation),
      initialDate: "2026-06-07",
      autoOpenFix: true,
    });

    // Expanded form, not the collapsed button.
    expect(html).toContain("Fix &amp; resubmit");
  });

  it("offers the fix flow for a rejected SPLIT-day entry too (#128) — no dead-end copy", () => {
    const html = render({
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Warehouse" },
      ],
      recentEntries: [],
      initialTodayEntry: rejectedEntry([
        { jobId: "j1", hours: 4, notes: null },
        { jobId: "j2", hours: 3.6, notes: null },
      ]),
      initialDate: "2026-06-07",
    });

    // Split days are now fixable in Phil (route to the split editor), so the
    // same "Fix rejected hours" trigger appears and the old dead-end copy is gone.
    expect(html).toContain("Fix rejected hours");
    expect(html).not.toContain("splits hours across jobs");
    expect(html).not.toContain("legacy My day");
  });
});

function entryWithStatus(status: "approved" | "submitted") {
  return {
    id: "te-2",
    userId: "u1",
    date: "2026-06-11",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status,
    allocations: [{ jobId: "j1", hours: 7.6, notes: null }],
    createdAt: "2026-06-11T06:00:00Z",
    updatedAt: "2026-06-11T06:00:00Z",
  };
}

describe("LogHoursSheet — submitted/approved selected day (2026-07-26 owner-directed)", () => {
  it("a submitted day: calm status + 'Change these hours', never a bare disabled primary", () => {
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: entryWithStatus("submitted"),
      initialDate: "2026-06-11",
    });
    expect(html).toContain("Sent to the office — waiting for approval");
    expect(html).toContain("Change these hours");
    expect(html).toContain("phil-edit-submitted");
    // The log actions are replaced, not silently disabled.
    expect(html).not.toContain("Submit Standard day");
    expect(html).not.toContain("Custom / overtime hours");
  });

  it("an approved day: the named absence — locked for pay, no button (P7)", () => {
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: entryWithStatus("approved"),
      initialDate: "2026-06-11",
    });
    expect(html).toContain("Approved and locked for pay");
    expect(html).toContain("ask the office");
    // No log actions and no change affordance on a locked day.
    expect(html).not.toContain("Submit Standard day");
    expect(html).not.toContain("Change these hours");
  });

  it("still shows the reason + inline fix for a rejected entry", () => {
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: rejectedEntry([{ jobId: "j1", hours: 7.6, notes: null }]),
      initialDate: "2026-06-07",
    });
    expect(html).toContain("logged"); // the card title renders only for rejected
    expect(html).toContain("Wrong job");
    expect(html).toContain("Fix rejected hours");
  });
});

describe("LogHoursSheet — status is scoped to the SELECTED date (regression, 2026-07-26)", () => {
  it("a selected past day with NO entry never borrows today's status or fix card", () => {
    // Today's entry is rejected, but the sheet is opened on a different day
    // that has no entry — the old `?? todayEntry` fallback wrongly showed
    // today's rejection (and its fix card) under that date.
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: rejectedEntry([{ jobId: "j1", hours: 7.6, notes: null }]), // dated 2026-06-07
      initialDate: "2026-06-05", // a different day, no entry
    });
    expect(html).not.toContain("Wrong job");
    expect(html).not.toContain("Fix rejected hours");
    // And a submitted today never locks a different, unlogged day.
    const html2 = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: entryWithStatus("submitted"), // dated 2026-06-11
      initialDate: "2026-06-05",
    });
    expect(html2).not.toContain("Sent to the office");
    expect(html2).toContain("Submit Standard day");
  });
});

describe("LogHoursSheet — log control layout (owner reposition)", () => {
  it("puts the day picker up under the calendar, above the standard-day action", () => {
    const html = render({
      ...base,
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      initialDate: "2026-06-01",
    });
    const dateAt = html.indexOf('value="2026-06-01"');
    expect(dateAt).toBeGreaterThanOrEqual(0);
    // the day picker now renders before the yellow Standard-day action
    expect(dateAt).toBeLessThan(html.indexOf("Standard day"));
  });

  it("places custom/overtime + split DIRECTLY under the action, not behind 'More options'", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
      initialJobId: "j1",
    });
    expect(html).toContain("Custom / overtime hours");
    expect(html).toContain("Split across jobs");
    const moreAt = html.indexOf("More options");
    expect(html.indexOf("Custom / overtime hours")).toBeLessThan(moreAt);
    expect(html.indexOf("Split across jobs")).toBeLessThan(moreAt);
  });

  it("keeps only the optional note tucked under 'More options' (still calm)", () => {
    const html = render({ ...base, assignedJobs: [{ id: "j1", name: "Smith St Rewire" }] });
    expect(html).toContain("More options");
    expect(html).toContain("Notes (optional)");
    // the note follows the expander; the old standalone disclosures stay gone
    expect(html.indexOf("Notes (optional)")).toBeGreaterThan(html.indexOf("More options"));
    expect(html).not.toContain("Add a note");
  });
});

describe("LogHoursSheet — deep-linked date", () => {
  it("preselects the validated initialDate so the fix lands on the right day", () => {
    const html = render({
      ...base,
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      initialDate: "2026-06-01",
    });
    expect(html).toContain('value="2026-06-01"');
  });
});

describe("LogHoursSheet — OT add-on chips on the standard day (owner-directed 2026-08-07)", () => {
  // The tap → echo → payload chain is pure logic driven directly in
  // src/domains/timesheets/timesheets.test.ts ("standard day + OT add-on
  // chips") — the repo's node-env pattern (see PhilTabBar.interaction.test.tsx):
  // the SAME helpers the chips wire (toggleOtAddOn / standardDayPlusOt /
  // standardDayOtEcho / buildStandardDayWithOtPayload) are exercised through
  // their real reducer, and THIS suite pins the SSR wiring around them.
  const soleJob = { ...base, assignedJobs: [{ id: "j1", name: "Smith St Rewire" }] };

  it("renders the four chips riding INSIDE the standard-day block, none active", () => {
    const html = render(soleJob);
    for (const label of ["+30m", "+1h", "+1½h", "+2h"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-label="Add overtime to the standard day"');
    // Single-select toggles, none pressed until tapped…
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('aria-pressed="true"');
    // …with a 44px+ touch target per chip.
    expect(html).toContain("min-h-[44px]");
  });

  it("no chip = the untouched standard day: same sub-label, same smoke-clicked aria-label, no echo", () => {
    const html = render(soleJob);
    expect(html).toContain("Standard day · 7h 36m");
    expect(html).toContain('aria-label="Submit Standard day, 7 hours 36 minutes"');
    // The echo only exists once a chip is active (client state, not SSR) —
    // the plain path renders no derived-total wording at all.
    expect(html).not.toContain("— standard +");
  });

  it("chips sit WITH the standard-day action — under it, above the custom/split fallbacks (P10: no new section)", () => {
    const html = render({
      ...base,
      assignedJobs: [
        { id: "j1", name: "Smith St Rewire" },
        { id: "j2", name: "Depot Switchboard" },
      ],
      initialJobId: "j1",
    });
    const chipAt = html.indexOf("+1½h");
    expect(chipAt).toBeGreaterThan(html.indexOf("Standard day"));
    expect(chipAt).toBeLessThan(html.indexOf("Custom / overtime hours"));
    expect(html.indexOf("Split across jobs")).toBeGreaterThan(chipAt);
  });

  it("a locked (submitted/approved) selected day renders no chips — the log actions are replaced wholesale", () => {
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: entryWithStatus("submitted"),
      initialDate: "2026-06-11",
    });
    expect(html).not.toContain("+1½h");
    expect(html).not.toContain("Add overtime to the standard day");
  });
});
