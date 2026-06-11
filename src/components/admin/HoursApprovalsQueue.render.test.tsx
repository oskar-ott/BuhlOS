import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The queue uses useRouter for post-mutation refresh; stub it for SSR.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { HoursApprovalsQueue } from "./HoursApprovalsQueue";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * SSR smoke for the approver job-attribution display. Attributed allocations
 * show the (enriched) job name; legacy/unattributed allocations (jobId null)
 * are flagged "No job assigned" so an approver can spot them. Display-only —
 * approve/reject behaviour is unchanged and untested here.
 */
function entry(id: string, userName: string, allocations: TimeEntry["allocations"]): TimeEntry {
  return {
    id,
    userId: `u-${id}`,
    userName,
    userRole: "electrician",
    date: "2026-06-05",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    submittedAt: "2026-06-05T08:00:00.000Z",
    createdAt: "2026-06-05T07:00:00.000Z",
    updatedAt: "2026-06-05T08:00:00.000Z",
    allocations,
  } as unknown as TimeEntry;
}

function render(props: Parameters<typeof HoursApprovalsQueue>[0]) {
  return renderToString(createElement(HoursApprovalsQueue, props));
}

describe("HoursApprovalsQueue — job attribution display", () => {
  it("shows the job name for an attributed entry", () => {
    const html = render({
      initialEntries: [
        entry("a", "Sparky", [{ jobId: "job-1", jobName: "Smith St Rewire", hours: 8, notes: null }]),
      ],
      fetchError: null,
    });
    expect(html).toContain("Smith St Rewire");
    expect(html).not.toContain("No job assigned");
  });

  it("flags an unattributed (jobId null) entry as 'No job assigned'", () => {
    const html = render({
      initialEntries: [
        entry("b", "Mate", [{ jobId: null, jobName: null, hours: 8, notes: null }]),
      ],
      fetchError: null,
    });
    expect(html).toContain("No job assigned");
  });
});

describe("Approve all (#124)", () => {
  it("offers a per-worker Approve all naming the batch size", () => {
    const a = entry("e1", "Sam", [{ jobId: "j1", jobName: "100 Arthur", hours: 8 }]);
    const b = { ...entry("e2", "Sam", [{ jobId: "j1", jobName: "100 Arthur", hours: 8 }]), userId: a.userId, date: "2026-06-06" };
    const html = renderToString(
      createElement(HoursApprovalsQueue, {
        initialEntries: [a, b],
        fetchError: null,
      })
    );
    expect(html).toContain("Approve all (2)");
  });
});
