import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  JobCloseoutMatrixCard,
  shouldSurfaceCloseoutMatrix,
} from "./JobCloseoutMatrixCard";
import type {
  CloseoutMatrixView,
  CloseoutRequirementView,
} from "@/server/job-control/closeout-read";

function req(partial: Partial<CloseoutRequirementView> & { id: string; title: string }): CloseoutRequirementView {
  return {
    kind: "other",
    source: "manual",
    areaScope: "job_wide",
    scopeClauseIds: [],
    status: "outstanding",
    confirmedAt: null,
    confirmedBy: null,
    links: [],
    hasDanglingLink: false,
    ...partial,
  };
}

function readyView(overrides: Partial<Extract<CloseoutMatrixView, { status: "ready" }>> = {}): CloseoutMatrixView {
  return {
    ok: true,
    jobId: "job-1",
    status: "ready",
    revision: "rev-1",
    counts: {
      total: 3,
      outstanding: 1,
      inProgress: 1,
      satisfied: 1,
      waived: 0,
      discharged: 1,
      fractionDischarged: 1 / 3,
    },
    requirements: [],
    outstanding: [
      req({ id: "cr_out", title: "O&M manuals handed over", status: "outstanding" }),
      req({ id: "cr_prog", title: "As-builts issued", status: "in_progress" }),
    ],
    linkOptions: [],
    ...overrides,
  };
}

describe("JobCloseoutMatrixCard — render", () => {
  it("renders N-of-M and the outstanding list", () => {
    const html = renderToString(createElement(JobCloseoutMatrixCard, { jobId: "job-1", view: readyView() }));
    expect(html).toContain("1 of 3 closed out");
    expect(html).toContain("O&amp;M manuals handed over");
    expect(html).toContain("As-builts issued");
    expect(html).toContain("Still outstanding");
    // The link to the full matrix is present.
    expect(html).toContain("/v2/jobs/job-1/closeout");
  });

  it("shows the honest-empty message when there's nothing to close out", () => {
    const empty: CloseoutMatrixView = { ok: true, jobId: "job-1", status: "missing" };
    const html = renderToString(createElement(JobCloseoutMatrixCard, { jobId: "job-1", view: empty }));
    expect(html).toContain("Nothing to close out yet");
  });

  it("shows an all-clear when every obligation is discharged", () => {
    const view = readyView({
      counts: {
        total: 2,
        outstanding: 0,
        inProgress: 0,
        satisfied: 2,
        waived: 0,
        discharged: 2,
        fractionDischarged: 1,
      },
      outstanding: [],
    });
    const html = renderToString(createElement(JobCloseoutMatrixCard, { jobId: "job-1", view }));
    expect(html).toContain("2 of 2 closed out");
    expect(html).toContain("Every closeout obligation is discharged");
  });
});

describe("shouldSurfaceCloseoutMatrix (positive() gate)", () => {
  it("is false for a draft job (day-one noise)", () => {
    expect(shouldSurfaceCloseoutMatrix("draft", readyView())).toBe(false);
    expect(shouldSurfaceCloseoutMatrix("on_hold", readyView())).toBe(false);
  });

  it("is false when there are no requirements", () => {
    const noReqs = readyView({
      counts: { total: 0, outstanding: 0, inProgress: 0, satisfied: 0, waived: 0, discharged: 0, fractionDischarged: null },
    });
    expect(shouldSurfaceCloseoutMatrix("active", noReqs)).toBe(false);
  });

  it("is false for a missing/unreadable view", () => {
    expect(shouldSurfaceCloseoutMatrix("active", { ok: true, jobId: "j", status: "missing" })).toBe(false);
    expect(shouldSurfaceCloseoutMatrix("active", { ok: false, error: "x" })).toBe(false);
  });

  it("is true for a near-completion job with requirements", () => {
    expect(shouldSurfaceCloseoutMatrix("active", readyView())).toBe(true);
    expect(shouldSurfaceCloseoutMatrix("complete", readyView())).toBe(true);
    expect(shouldSurfaceCloseoutMatrix("archived", readyView())).toBe(true);
  });
});
