import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { JobHealthBand } from "./JobHealthBand";
import type { Job } from "@/domains/jobs/types";

/**
 * 2026-08-09 job-hub audit — the health band renders the SAME health read the
 * jobs list shows (deriveJobHealth), plus IV code identity and honest quick
 * facts. renderToString = the server-render contract; the status menu is
 * closed by default so only the pill shows.
 */

const baseJob = {
  id: "job-1",
  name: "Willoughby townhouses",
  status: "active",
  code: "IV1023",
  ref: "PO-8871",
  typeName: "Fit-off",
  siteAddress: "12 Penshurst St, Willoughby",
} as Job;

describe("JobHealthBand", () => {
  it("renders identity, status, and the at-risk health read with reasons", () => {
    const job = {
      ...baseJob,
      statsEvidenceV2Pending: 3,
      statsExpiredTags: 1,
      statsCrewCount: 4,
    } as Job;
    const html = renderToString(
      createElement(JobHealthBand, { job, canEdit: true, progressPct: 40 })
    );
    expect(html).toContain("IV1023");
    expect(html).toContain("Ref PO-8871");
    expect(html).toContain("12 Penshurst St");
    expect(html).toContain("Active");
    expect(html).toContain("At risk"); // expired tag = hard signal
    expect(html).toContain("expired");
    expect(html).toContain("to review");
    expect(html).toContain("40%");
    // Reason chips deep-link to where they're actioned.
    expect(html).toContain(`/v2/jobs/job-1/evidence`);
    expect(html).toContain(`/gear`);
    // Owner pull 2026-08-29 — the Edit entry beside the name lands on the
    // builder's Basics tab (the one editor for name + details).
    expect(html).toContain(`/v2/jobs/job-1/builder?tab=basics`);
    expect(html).toContain(">Edit<");
  });

  it("hides the Edit entry below the admin tier — the name PUT would 403", () => {
    const html = renderToString(
      createElement(JobHealthBand, { job: baseJob, canEdit: false, progressPct: null })
    );
    expect(html).not.toContain("builder?tab=basics");
    expect(html).not.toContain(">Edit<");
  });

  it("is honest when nothing is loaded — No data, muted dashes, no invented numbers", () => {
    const html = renderToString(
      createElement(JobHealthBand, { job: baseJob, canEdit: false, progressPct: null })
    );
    expect(html).toContain("No data");
    expect(html).toContain("—");
    expect(html).not.toContain("0%");
  });

  it("gives a complete job the check-marked pill, not a bare Active look-alike", () => {
    const job = { ...baseJob, status: "complete", statsEvidenceV2Pending: 0 } as Job;
    const html = renderToString(
      createElement(JobHealthBand, { job, canEdit: false, progressPct: null })
    );
    expect(html).toContain("Complete");
    expect(html).not.toContain(">Active<");
  });
});
