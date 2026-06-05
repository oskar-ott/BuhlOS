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
