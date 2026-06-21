import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SplitDaySheet } from "./SplitDaySheet";

/**
 * #128 — split-day editor render guard. Interactive maths (remainder,
 * per-row validation, sum) is pinned by split-day.test.ts; this pins the
 * surface: rows with job pickers, a computed remainder cell, the add-job
 * affordance, and that it renders nothing closed.
 */

const jobs = [
  { id: "j1", name: "Smith St" },
  { id: "j2", name: "Warehouse" },
  { id: "j3", name: "Depot" },
];

describe("SplitDaySheet", () => {
  it("renders a total, two job rows and a computed remainder when open", () => {
    const html = renderToString(
      createElement(SplitDaySheet, {
        open: true,
        onClose: () => {},
        assignedJobs: jobs,
        submitting: false,
        onSubmit: () => {},
      })
    );
    expect(html).toContain("split-day-sheet");
    expect(html).toContain("split-total");
    expect(html).toContain("split-job-0");
    expect(html).toContain("split-job-1");
    expect(html).toContain("split-remainder"); // last row auto-computed
    expect(html).toContain("split-add-job"); // 3 jobs available → can add
    expect(html).toContain("Smith St");
    expect(html).toContain("Warehouse");
  });

  it("renders nothing when closed", () => {
    const html = renderToString(
      createElement(SplitDaySheet, {
        open: false,
        onClose: () => {},
        assignedJobs: jobs,
        submitting: false,
        onSubmit: () => {},
      })
    );
    expect(html).not.toContain("split-day-sheet");
  });

  it("hides 'Add another job' when rows already cover every assigned job", () => {
    const html = renderToString(
      createElement(SplitDaySheet, {
        open: true,
        onClose: () => {},
        assignedJobs: [jobs[0]!, jobs[1]!], // exactly 2 jobs, 2 rows
        submitting: false,
        onSubmit: () => {},
      })
    );
    expect(html).not.toContain("split-add-job");
  });

  it("pre-fills total + rows and shows a custom title and error (resubmit mode, #128)", () => {
    const html = renderToString(
      createElement(SplitDaySheet, {
        open: true,
        onClose: () => {},
        assignedJobs: jobs,
        submitting: false,
        onSubmit: () => {},
        title: "Fix & resubmit the split day",
        initialTotal: 7.6,
        initialRows: [
          { jobId: "j1", hours: 4 },
          { jobId: "j2", hours: 3.6 },
        ],
        errorMessage: "You can't edit this entry — ask the office to reopen it.",
      })
    );
    expect(html).toContain("Fix &amp; resubmit the split day");
    expect(html).toContain('value="7.6"'); // seeded total
    expect(html).toContain("split-error");
    expect(html).toContain("ask the office to reopen it");
    // seeded job selections render (selected option present)
    expect(html).toContain("Smith St");
    expect(html).toContain("Warehouse");
  });
});
