import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DayworkRollup } from "./DayworkRollup";
import type { DayworkRegisterSummary } from "@/domains/dayworks/service";
import type { Daywork } from "@/domains/dayworks/types";
import type { DayworkRollupJobRow } from "@/server/dayworks/register";

const NOW = Date.parse("2026-06-29T00:00:00.000Z");

function docket(over: Partial<Daywork> & { id: string; ref: string }): Daywork {
  return {
    jobId: "job-2",
    jobName: "Other site",
    seq: 1,
    date: "2026-06-20T00:00:00.000Z",
    description: "Extra cabling to level 2",
    labourLines: [{ id: "l1", workerName: "Sparky", hours: 6 }],
    materialLines: [],
    photoIds: [],
    status: "unsigned",
    signature: null,
    linkedTimeEntryIds: [],
    createdById: "u1",
    createdByName: "Sparky",
    createdAt: "2026-06-20T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  } as Daywork;
}

function render(
  byJob: DayworkRollupJobRow[],
  dockets: Daywork[],
  summary: DayworkRegisterSummary,
): string {
  return renderToString(
    createElement(DayworkRollup, { byJob, dockets, summary, nowMs: NOW }),
  ).replace(/<!-- -->/g, "");
}

const SUMMARY: DayworkRegisterSummary = {
  total: 4,
  unsigned: 2,
  signed: 1,
  invoiced: 1,
  unsignedAging: 1,
};

describe("DayworkRollup", () => {
  it("renders a per-job summary band that links into each job's register", () => {
    const byJob: DayworkRollupJobRow[] = [
      { jobId: "job-2", jobName: "Other site", total: 3, unsigned: 2, signed: 1, invoiced: 0, unsignedAging: 1 },
      { jobId: "job-1", jobName: "Birdwood", total: 1, unsigned: 0, signed: 0, invoiced: 1, unsignedAging: 0 },
    ];
    const html = render(byJob, [docket({ id: "dw1", ref: "DW-001" })], SUMMARY);
    expect(html).toContain("Other site");
    expect(html).toContain("Birdwood");
    expect(html).toContain("/v2/jobs/job-2/dayworks");
    expect(html).toContain("/v2/jobs/job-1/dayworks");
    expect(html).toContain("payment risk"); // job-2 has an aging docket
  });

  it("renders the EVERY-DOCKET list with ref, hours, status and a job link (§6A)", () => {
    const byJob: DayworkRollupJobRow[] = [
      { jobId: "job-2", jobName: "Other site", total: 2, unsigned: 1, signed: 1, invoiced: 0, unsignedAging: 0 },
    ];
    const dockets: Daywork[] = [
      docket({ id: "dw1", ref: "DW-001", description: "Extra cabling to level 2", labourLines: [{ id: "l1", workerName: "Sparky", hours: 6 }] }),
      docket({ id: "dw2", ref: "DW-002", status: "signed", description: "Make-good after trades", labourLines: [{ id: "l2", workerName: "Mate", hours: 2.5 }] }),
    ];
    const html = render(byJob, dockets, SUMMARY);
    // The docket list container renders…
    expect(html).toContain('data-testid="daywork-rollup-dockets"');
    // …with every docket ref…
    expect(html).toContain("DW-001");
    expect(html).toContain("DW-002");
    // …its description…
    expect(html).toContain("Extra cabling to level 2");
    expect(html).toContain("Make-good after trades");
    // …and HOURS (never a fabricated $ — the schema has no money field).
    expect(html).toContain("6h labour");
    expect(html).toContain("2.5h labour");
    expect(html).not.toContain("$");
    // The status pills.
    expect(html).toContain("Unsigned");
    expect(html).toContain("Signed");
  });

  it("shows an honest empty state when no job has dockets", () => {
    const html = render([], [], { total: 0, unsigned: 0, signed: 0, invoiced: 0, unsignedAging: 0 });
    expect(html).toContain("No daywork dockets across any job yet");
    expect(html).not.toContain('data-testid="daywork-rollup-dockets"');
  });

  it("falls back to the job id when a docket has no job name", () => {
    const byJob: DayworkRollupJobRow[] = [
      { jobId: "job-x", jobName: null, total: 1, unsigned: 1, signed: 0, invoiced: 0, unsignedAging: 0 },
    ];
    const html = render(byJob, [docket({ id: "dw1", ref: "DW-009", jobId: "job-x", jobName: null })], SUMMARY);
    expect(html).toContain("job-x");
  });

  it("renders the shared inbox stat strip over the rollup's OWN real data (§6)", () => {
    // SUMMARY: unsigned 2 · signed 1 · unsignedAging 1. byJob below has one job
    // with an aging docket → Jobs at risk = 1.
    const byJob: DayworkRollupJobRow[] = [
      { jobId: "job-2", jobName: "Other site", total: 3, unsigned: 2, signed: 1, invoiced: 0, unsignedAging: 1 },
      { jobId: "job-1", jobName: "Birdwood", total: 1, unsigned: 0, signed: 0, invoiced: 1, unsignedAging: 0 },
    ];
    const html = render(byJob, [docket({ id: "dw1", ref: "DW-001" })], SUMMARY);
    expect(html).toContain("Unsigned");
    expect(html).toContain("Aging &gt; 24h");
    expect(html).toContain("Jobs at risk");
    expect(html).toContain("Signed");
  });

  it("a calm empty rollup shows muted zeros, never a fabricated number (§6)", () => {
    const html = render([], [], { total: 0, unsigned: 0, signed: 0, invoiced: 0, unsignedAging: 0 });
    // Every stat is a real 0 → the shell renders the value muted, not coloured.
    expect(html).toContain("tabular-nums text-text-muted");
  });
});
