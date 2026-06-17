import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
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

  it("is honest about split-day entries the single-job form can't fix", () => {
    const html = render({
      assignedJobs: [{ id: "j1", name: "Smith St Rewire" }],
      recentEntries: [],
      initialTodayEntry: rejectedEntry([
        { jobId: "j1", hours: 4, notes: null },
        { jobId: "j2", hours: 3.6, notes: null },
      ]),
    });

    expect(html).toContain("splits hours across jobs");
    expect(html).not.toContain("Fix rejected hours");
  });
});

describe("LogHoursSheet — custom / overtime hours is surfaced", () => {
  it("shows custom/overtime as a visible action, not buried under the old disclosure", () => {
    const html = render({ ...base, assignedJobs: [{ id: "j1", name: "Smith St Rewire" }] });
    // The second action is now a visible button so logging overtime is easy to find.
    expect(html).toContain("Custom / overtime hours");
    // The old buried "Custom hours or a note" disclosure summary is gone…
    expect(html).not.toContain("Custom hours or a note");
    // …only the optional note stays under a quiet disclosure.
    expect(html).toContain("Add a note");
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
