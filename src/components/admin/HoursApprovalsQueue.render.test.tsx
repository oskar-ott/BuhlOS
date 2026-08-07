import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The queue uses useRouter for post-mutation refresh; stub it for SSR.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { HoursApprovalsQueue } from "./HoursApprovalsQueue";
import { AmendHoursEditor } from "./AmendHoursEditor";
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

/**
 * "Fix the hours and approve" — the owner-directed correction at approval time.
 * SSR pins WHO gets the affordance and what the editor asks for; the mutation
 * itself is covered end-to-end in
 * src/domains/time-entries/time-entries-amend-approve-api.test.ts.
 */
describe("amend at approval time — 'Fix the hours'", () => {
  const SUBMITTED = entry("fix", "Sparky", [
    { jobId: "job-1", jobName: "Smith St Rewire", hours: 8.37, notes: null },
  ], { totalHours: 8.37, ordinaryHours: 8, overtimeHours: 0.37 });

  it("offers the office a 'Fix the hours' affordance on each entry", () => {
    const html = render({ initialEntries: [SUBMITTED], fetchError: null, canAmend: true });
    expect(html).toContain("Fix the hours");
    expect(html).toContain('aria-label="Fix the hours for Sparky on');
  });

  it("never shows it to a leading hand — changing pay is the office's call", () => {
    const html = render({ initialEntries: [SUBMITTED], fetchError: null });
    expect(html).not.toContain("Fix the hours");
    // Approve / Reject are untouched for them.
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("keeps Approve and Reject alongside it — the fix is an addition, not a swap", () => {
    const html = render({ initialEntries: [SUBMITTED], fetchError: null, canAmend: true });
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
  });
});

describe("the amend editor (hours + minutes, never decimals)", () => {
  const ENTRY = entry("ed", "Sparky", [
    { jobId: "job-1", jobName: "Smith St Rewire", hours: 5, notes: null },
    { jobId: "job-2", jobName: "Depot", hours: 3, notes: null },
  ]);

  function editorHtml(props: Partial<Parameters<typeof AmendHoursEditor>[0]> = {}) {
    return renderToString(
      createElement(AmendHoursEditor, {
        dateLabel: "Tue 5 Jun",
        workerName: "Sparky",
        currentTotalHours: 8,
        allocations: [{ jobId: "job-1", label: "Smith St Rewire", hours: 8.37 }],
        saving: false,
        onCancel: () => {},
        onSave: () => {},
        ...props,
      }),
    );
  }

  it("edits time as HOURS + MINUTES — the decimal box that caused the incident is gone", () => {
    const html = editorHtml();
    expect(html).toContain('aria-label="Hours"');
    expect(html).toContain('aria-label="Minutes"');
    // 8.37h is 8h 22m — the pair the office actually types.
    expect(html).toContain('value="8"');
    expect(html).toContain('value="22"');
    expect(html).not.toContain('value="8.37"');
  });

  it("gives a SPLIT day one h+m pair per job, named", () => {
    const html = editorHtml({
      currentTotalHours: 8,
      allocations: [
        { jobId: "job-1", label: "Smith St Rewire", hours: 5 },
        { jobId: "job-2", label: "Depot", hours: 3 },
      ],
    });
    expect(html).toContain('aria-label="Hours on Smith St Rewire"');
    expect(html).toContain('aria-label="Minutes on Depot"');
    // Total is derived from the parts, shown as the honest before → after.
    expect(html).toContain("Was 8h · now 8h");
  });

  it("requires a reason and says the worker will see it", () => {
    const html = editorHtml();
    expect(html).toContain("Why (required)");
    expect(html).toContain('aria-required="true"');
    expect(html).toContain("Sparky sees this change and the reason on their phone.");
  });

  it("saves with one button that does both — 'Save &amp; approve', disabled until a reason exists", () => {
    const html = editorHtml();
    expect(html).toContain("Save &amp; approve");
    expect(html).toContain('data-testid="amend-save"');
    // No reason typed yet on first render → the save is blocked.
    expect(html).toMatch(/data-testid="amend-save"[^>]*disabled|disabled[^>]*data-testid="amend-save"/);
  });

  it("renders inside the row it corrects (the numbers stay on screen)", () => {
    // The queue only mounts the editor once the affordance is tapped (client
    // state), so SSR shows the closed row — the editor's own markup is proven
    // above. This pins that the closed row is unchanged.
    const html = render({ initialEntries: [ENTRY], fetchError: null, canAmend: true });
    expect(html).not.toContain('data-testid="amend-editor"');
    expect(html).toContain('data-testid="amend-open-');
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
