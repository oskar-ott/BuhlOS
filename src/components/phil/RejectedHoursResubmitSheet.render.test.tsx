import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RejectedHoursResubmitSheet } from "./RejectedHoursResubmitSheet";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * SSR render tests (vitest `environment: node`, no jsdom). They assert the
 * initial rendered markup; the dynamic submit success/error and the
 * attribution-blocking logic are unit-tested as pure functions in
 * src/domains/timesheets/resubmit.test.ts (the component delegates to them).
 */

function te(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "te-1",
    userId: "u1",
    date: "2026-06-03",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "rejected",
    rejectedReason: "Logged to the wrong job",
    allocations: [{ jobId: "job-a", hours: 7.6, notes: null }],
    createdAt: "2026-06-03T08:00:00Z",
    updatedAt: "2026-06-03T08:00:00Z",
    ...over,
  } as unknown as TimeEntry;
}

const ONE_JOB = [{ id: "job-a", name: "Smith St" }];
const TWO_JOBS = [
  { id: "job-a", name: "Smith St" },
  { id: "job-b", name: "Jones Rd" },
];

function render(props: Parameters<typeof RejectedHoursResubmitSheet>[0]): string {
  return renderToString(createElement(RejectedHoursResubmitSheet, props));
}

describe("RejectedHoursResubmitSheet", () => {
  it("collapses to a single 'Fix rejected hours' trigger", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB });
    expect(html).toContain("Fix rejected hours");
    expect(html).not.toContain("Submit correction");
  });

  it("opens to a resubmit form showing the reason and the assigned job", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB, defaultOpen: true });
    expect(html).toContain("Reason:");
    expect(html).toContain("Logged to the wrong job");
    expect(html).toContain("Hours for this job");
    expect(html).toContain("Submit correction");
    expect(html).toContain("Smith St");
  });

  it("requires an explicit pick when multiple jobs and the original job is null", () => {
    const nullJob = te({ allocations: [{ jobId: null, hours: 7.6, notes: null }] });
    const html = render({ entry: nullJob, assignedJobs: TWO_JOBS, defaultOpen: true });
    expect(html).toContain("Pick one");
    expect(html).toContain("Jones Rd");
  });

  it("blocks honestly when jobs failed to load (no null fallback)", () => {
    const html = render({ entry: te(), assignedJobs: [], jobsError: true, defaultOpen: true });
    expect(html).toContain("load your jobs");
  });

  it("blocks honestly when the worker has no active assigned job", () => {
    const html = render({ entry: te(), assignedJobs: [], defaultOpen: true });
    expect(html).toContain("No active assigned job");
  });

  // 2026-07-26 owner-directed: a single-allocation day can be SPLIT across
  // jobs from inside the fix flow — but only for multi-job workers (mirrors
  // LogHoursSheet's condition; never a dead end for a one-job worker).
  it("offers 'Split across jobs' on a single-allocation day when 2+ jobs are assigned", () => {
    const html = render({ entry: te(), assignedJobs: TWO_JOBS, defaultOpen: true });
    expect(html).toContain("phil-change-split");
    expect(html).toContain("Split across jobs");
  });

  it("hides the split affordance for a one-job worker", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB, defaultOpen: true });
    expect(html).not.toContain("phil-change-split");
    expect(html).not.toContain("Split across jobs");
  });

  it("shows no admin / payroll controls", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB, defaultOpen: true });
    for (const banned of ["Payroll", "Xero", "Pay run", "Approve", "Reject"]) {
      expect(html).not.toContain(banned);
    }
  });

  // #128 — a rejected SPLIT day opens the split editor (allocations preserved),
  // never the single-job form.
  const splitEntry = () =>
    te({
      totalHours: 7.6,
      allocations: [
        { jobId: "job-a", hours: 4, notes: null },
        { jobId: "job-b", hours: 3.6, notes: null },
      ],
    });

  it("a split day still collapses to the single 'Fix rejected hours' trigger", () => {
    const html = render({ entry: splitEntry(), assignedJobs: TWO_JOBS });
    expect(html).toContain("Fix rejected hours");
    expect(html).not.toContain("split-day-sheet");
  });

  it("opens a split entry into the split editor, not the single-job form", () => {
    const html = render({ entry: splitEntry(), assignedJobs: TWO_JOBS, defaultOpen: true });
    expect(html).toContain("split-day-sheet"); // SplitDaySheet rendered
    expect(html).toContain("Fix &amp; resubmit the split day");
    expect(html).not.toContain("Hours for this job"); // NOT the single-job legend
    expect(html).not.toContain("Submit correction"); // NOT the single-job action
    expect(html).not.toContain("phil-change-split"); // already split — no toggle
  });

  it("blocks a split resubmit honestly when jobs failed to load", () => {
    const html = render({ entry: splitEntry(), assignedJobs: [], jobsError: true, defaultOpen: true });
    expect(html).toContain("load your jobs");
    expect(html).not.toContain("split-day-sheet"); // editor not shown until jobs load
  });
});

// 2026-07-26 owner-directed: the SUBMITTED (undecided) variant — the worker
// can fix a sent day until the office decides. Same editors, "change &
// resend" words; every rejected-variant label above stays byte-identical.
describe("RejectedHoursResubmitSheet — submitted (undecided) variant", () => {
  const submitted = (over: Partial<TimeEntry> = {}) =>
    te({ status: "submitted", rejectedReason: null, ...over });

  it("collapses to a quiet secondary 'Change these hours' trigger (never the yellow primary)", () => {
    const html = render({ entry: submitted(), assignedJobs: ONE_JOB });
    expect(html).toContain("Change these hours");
    expect(html).toContain("phil-edit-submitted");
    expect(html).not.toContain("Fix rejected hours");
    expect(html).not.toContain("Send the fix");
  });

  it("opens to 'Change & resend' with 'Send the fix' and the P12 consequence line", () => {
    const html = render({ entry: submitted(), assignedJobs: ONE_JOB, defaultOpen: true });
    expect(html).toContain("Change &amp; resend");
    expect(html).toContain("Send the fix");
    expect(html).toContain("phil-edit-submitted-send");
    // P12 — the consequence is named before the action.
    expect(html).toContain("The office gets the new version — the old one is replaced.");
    // No rejection framing on an undecided day.
    expect(html).not.toContain("Reason:");
    expect(html).not.toContain("Fix &amp; resubmit");
    expect(html).not.toContain("Submit correction");
  });

  it("routes a submitted SPLIT day through the split editor, with change-and-resend words", () => {
    const html = render({
      entry: submitted({
        totalHours: 7.6,
        allocations: [
          { jobId: "job-a", hours: 4, notes: null },
          { jobId: "job-b", hours: 3.6, notes: null },
        ],
      }),
      assignedJobs: TWO_JOBS,
      defaultOpen: true,
    });
    expect(html).toContain("split-day-sheet");
    expect(html).toContain("Change &amp; resend the split day");
    expect(html).not.toContain("Fix &amp; resubmit the split day");
    expect(html).not.toContain("Hours for this job"); // NOT the single-job form
  });

  it("offers 'Split across jobs' on a single-allocation day too, keeping the P12 consequence line", () => {
    const html = render({ entry: submitted(), assignedJobs: TWO_JOBS, defaultOpen: true });
    expect(html).toContain("phil-change-split");
    expect(html).toContain("Split across jobs");
    // The consequence line survives the new affordance (P12).
    expect(html).toContain("The office gets the new version — the old one is replaced.");
    // One-job worker: no split affordance in this variant either.
    const one = render({ entry: submitted(), assignedJobs: ONE_JOB, defaultOpen: true });
    expect(one).not.toContain("phil-change-split");
  });

  it("still blocks honestly when jobs failed to load / none assigned", () => {
    const err = render({ entry: submitted(), assignedJobs: [], jobsError: true, defaultOpen: true });
    expect(err).toContain("load your jobs");
    const none = render({ entry: submitted(), assignedJobs: [], defaultOpen: true });
    expect(none).toContain("No active assigned job");
  });
});

/**
 * Owner-directed 2026-08-09: the fix flow's quick picks are the standard day
 * + the OT presets — the same anti-wrong-total treatment as the log sheet's
 * custom sheet. The old whole-hour grid (up to 9h/10h) and the decimal
 * "Exact hours" box were both live paths to the "extra hour = 9 hours" /
 * "8.36" pay errors; neither may come back.
 */
describe("RejectedHoursResubmitSheet — standard-day + OT presets, h+m entry", () => {
  it("renders the standard-day chip and the four OT presets with their derived totals", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB, defaultOpen: true });
    expect(html).toContain("Standard day · 7h 36m");
    for (const label of ["+30m OT", "+1h OT", "+1½h OT", "+2h OT"]) {
      expect(html).toContain(label);
    }
    // Every preset SHOWS its derived total — the worker checks by eye,
    // never computes.
    for (const total of ["8h 6m", "8h 36m", "9h 6m", "9h 36m"]) {
      expect(html).toContain(`= ${total} total`);
    }
    // The entry's 7.6 preselects the standard-day chip.
    expect(html).toContain('aria-pressed="true"');
  });

  it("hours are entered as h + m — the decimal box and the raw whole-hour chips are gone", () => {
    const html = render({ entry: te(), assignedJobs: ONE_JOB, defaultOpen: true });
    expect(html).toContain('aria-label="Hours"');
    expect(html).toContain('aria-label="Minutes"');
    expect(html).not.toContain('step="0.25"');
    expect(html).not.toContain("Exact hours");
    // No bare-total quick picks that read like a day length ("9h", "10h").
    expect(html).not.toContain(">9h<");
    expect(html).not.toContain(">10h<");
  });

  it("an OT-total entry (8.6) preselects its preset and fills 8h 36m into the inputs", () => {
    const html = render({
      entry: te({ totalHours: 8.6, allocations: [{ jobId: "job-a", hours: 8.6, notes: null }] }),
      assignedJobs: ONE_JOB,
      defaultOpen: true,
    });
    // The +1h OT preset is the active one…
    expect(html).toContain('aria-pressed="true"');
    // …and the h/m inputs carry the split, not a decimal.
    expect(html).toContain('value="8"');
    expect(html).toContain('value="36"');
  });
});
