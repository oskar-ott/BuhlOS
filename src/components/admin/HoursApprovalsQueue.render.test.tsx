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
function entry(
  id: string,
  userName: string,
  allocations: TimeEntry["allocations"],
  extra: Partial<TimeEntry> = {},
): TimeEntry {
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
    ...extra,
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

describe("Overtime split display (#130)", () => {
  it("shows the base/OT split on an entry that stored overtime", () => {
    const html = render({
      initialEntries: [
        entry("ot", "Sparky", [{ jobId: "j1", jobName: "100 Arthur", hours: 10 }], {
          totalHours: 10,
          ordinaryHours: 8,
          overtimeHours: 2,
        }),
      ],
      fetchError: null,
    });
    expect(html).toContain("8h + 2h OT");
  });

  it("adds no split for a standard ≤8h day (byte-identical to before)", () => {
    const html = render({
      initialEntries: [
        entry("std", "Sparky", [{ jobId: "j1", jobName: "100 Arthur", hours: 8 }]),
      ],
      fetchError: null,
    });
    expect(html).not.toContain(" OT");
  });

  it("HONESTY GUARD: an inconsistent stored split shows total only, no invented split", () => {
    const html = render({
      initialEntries: [
        entry("bad", "Sparky", [{ jobId: "j1", jobName: "100 Arthur", hours: 12 }], {
          totalHours: 12,
          ordinaryHours: 8,
          overtimeHours: 2, // 8 + 2 != 12 → garbage
        }),
      ],
      fetchError: null,
    });
    expect(html).not.toContain(" OT");
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

describe("approve/reject button accessibility (H7/H27)", () => {
  it("gives each entry's approve/reject buttons a descriptive aria-label and the 44px touch size", () => {
    const html = render({
      initialEntries: [
        entry("a", "Sparky", [{ jobId: "job-1", jobName: "Smith St Rewire", hours: 8, notes: null }]),
      ],
      fetchError: null,
    });
    // H27: screen reader hears WHO + WHEN, not a bare "Approve"/"Reject".
    expect(html).toContain('aria-label="Approve 8h for Sparky on');
    expect(html).toContain('aria-label="Reject 8h for Sparky on');
    // H7: size="sm" gives the 44px phone touch floor (h-11).
    expect(html).toContain("h-11");
  });
});
