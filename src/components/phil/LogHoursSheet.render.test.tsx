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

  it("collapses the multi-job picker to the chosen job (less clutter), with a Change affordance", () => {
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
    expect(html).toContain("Change");
    // …the full radiogroup and the other job are tucked away until "Change".
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("Smith St Rewire");
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

  it("blocks when assigned jobs failed to load", () => {
    const html = render({ ...base, assignedJobs: [], jobsError: true });
    expect(html).toContain("load your jobs");
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
    });

    // Split days are now fixable in Phil (route to the split editor), so the
    // same "Fix rejected hours" trigger appears and the old dead-end copy is gone.
    expect(html).toContain("Fix rejected hours");
    expect(html).not.toContain("splits hours across jobs");
    expect(html).not.toContain("legacy My day");
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
