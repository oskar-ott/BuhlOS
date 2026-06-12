import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilJobSiteCard } from "./PhilJobSiteCard";
import { PhilMyInductionsCard } from "./PhilMyInductionsCard";
import { JobInductionCard } from "@/components/admin/JobInductionCard";
import type { Job } from "@/domains/jobs/types";
import type { InductionRecord } from "@/domains/jobs/induction";

/**
 * Server-render guards for the induction register surfaces (#332). Write
 * paths + scoping are pinned by the API harness; these pin the three Phil
 * site-card states, the admin crew card and the worker history card.
 *
 * The Phil job screen is FROZEN for layout — these tests also pin that the
 * change stays a STATE SWAP inside the existing notice (`#phil-job-site`
 * anchor intact, "Site details" heading intact).
 */

const noop = () => {};

const job = (extra: Partial<Job>): Job =>
  ({
    id: "j1",
    name: "Riverside",
    status: "active",
    siteAddress: "1 River St",
    inductionRequired: true,
    areaGroups: [],
    ...extra,
  }) as unknown as Job;

const rec = (extra: Partial<InductionRecord> = {}): InductionRecord =>
  ({
    id: "ind_1",
    jobId: "j1",
    jobName: "Riverside",
    workerId: "u1",
    workerName: "sparky",
    completedAt: "2026-06-10T01:00:00.000Z",
    recordedBy: "u1",
    backfill: false,
    ...extra,
  }) as InductionRecord;

describe("PhilJobSiteCard — three induction states (frozen-screen state swap)", () => {
  it("required + no record: warning notice with the one-tap confirm", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, {
        job: job({}),
        defaultOpen: true,
        induction: { state: "required", completedAt: null, onConfirm: noop },
      })
    );
    expect(html).toContain("phil-job-site"); // load-bearing anchor
    expect(html).toContain("Site details");
    expect(html).toContain("Site induction required");
    expect(html).toContain("induction-confirm");
    expect(html).toContain("done my induction");
  });

  it("done: quiet dated confirmation, no button, anchor intact", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, {
        job: job({}),
        defaultOpen: true,
        induction: { state: "done", completedAt: "2026-06-10T01:00:00.000Z" },
      })
    );
    expect(html).toContain("phil-job-site");
    expect(html).toContain("Site induction confirmed");
    expect(html).toContain("10 Jun 2026");
    expect(html).not.toContain("induction-confirm");
    expect(html).not.toContain("Site induction required");
  });

  it("not required: no induction notice at all (zero behaviour change)", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, {
        job: job({ inductionRequired: false }),
        defaultOpen: true,
        induction: null,
      })
    );
    expect(html).not.toContain("Site induction");
  });

  it("failed save shows the error inside the notice — never an optimistic done", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, {
        job: job({}),
        defaultOpen: true,
        induction: {
          state: "required",
          completedAt: null,
          onConfirm: noop,
          error: "Couldn’t reach the server",
        },
      })
    );
    expect(html).toContain("Couldn’t reach the server");
    expect(html).toContain("Site induction required"); // still required
  });

  it("no induction prop (caller didn't load records): legacy static warning", () => {
    const html = renderToString(
      createElement(PhilJobSiteCard, { job: job({}), defaultOpen: true })
    );
    expect(html).toContain("Site induction required");
    expect(html).not.toContain("induction-confirm");
  });
});

describe("JobInductionCard (admin hub)", () => {
  const crew = [
    {
      workerId: "u1",
      workerName: "sparky",
      inducted: true,
      completedAt: "2026-06-10T01:00:00.000Z",
      backfill: false,
      recordedByName: null,
    },
    {
      workerId: "u2",
      workerName: "mick",
      inducted: false,
      completedAt: null,
      backfill: false,
      recordedByName: null,
    },
  ];

  it("shows the crew count pill, per-worker status and the backfill affordance", () => {
    const html = renderToString(
      createElement(JobInductionCard, {
        jobId: "j1",
        inductionRequired: true,
        initialCrew: crew,
        recordCount: 1,
        fetchError: null,
      })
    );
    expect(html).toContain("Site induction");
    // JSX comment nodes split the interpolation — assert the fragment.
    expect(html).toContain("inducted");
    expect(html).toMatch(/1<!-- -->\/<!-- -->2/);
    expect(html).toContain("sparky");
    expect(html).toContain("10 Jun 2026");
    expect(html).toContain("mick");
    expect(html).toContain("Not yet");
    expect(html).toContain("induction-backfill-open");
  });

  it("flag turned off after records exist: history framing, records kept", () => {
    const html = renderToString(
      createElement(JobInductionCard, {
        jobId: "j1",
        inductionRequired: false,
        initialCrew: [],
        recordCount: 2,
        fetchError: null,
      })
    );
    expect(html).toContain("No longer flagged as required");
    expect(html).toContain("2 past records kept on file");
  });
});

describe("PhilMyInductionsCard (worker history)", () => {
  it("lists inducted jobs with dates; backfills say who recorded", () => {
    const html = renderToString(
      createElement(PhilMyInductionsCard, {
        records: [rec(), rec({ id: "ind_2", jobName: "Depot", backfill: true })],
        fetchError: null,
      })
    );
    expect(html).toContain("My site inductions");
    expect(html).toContain("Riverside");
    expect(html).toContain("Depot");
    expect(html).toContain("recorded by the office");
    expect(html).toContain("Inducted");
  });

  it("honest empty state", () => {
    const html = renderToString(
      createElement(PhilMyInductionsCard, { records: [], fetchError: null })
    );
    expect(html).toContain("None recorded yet");
  });
});
