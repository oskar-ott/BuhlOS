import { describe, expect, it } from "vitest";
import {
  JobSummaryResponseSchema,
  citations,
  factNumbers,
  type JobSummaryResponse,
} from "./summary-client";
import { formatHoursLabel } from "@/domains/timesheets/format";

/**
 * #173 — the pure client layer for the AI job summary. The endpoint contract is
 * pinned by src/domains/platform/ai-assistant-api.test.ts; this harness pins the
 * UI-facing helpers: the response schema, the VERBATIM number extraction (P7 —
 * the model's prose is never the sole source of a figure) and the citation →
 * live-hub-anchor mapping.
 */

// A realistic tool pack mirroring api/_lib/ai-tools.js read() returns.
function pack(over: Partial<JobSummaryResponse["toolData"]> = {}): JobSummaryResponse {
  return {
    summary: "Riverside Units is active with one open snag and 6h approved.",
    generatedAt: "2026-07-04T02:00:00.000Z",
    model: "claude-sonnet-4-6",
    toolData: {
      overview: {
        job: {
          id: "job-1",
          name: "Riverside Units",
          type: "residential",
          status: "active",
          address: null,
          createdAt: null,
        },
        areas: { count: 3 },
        tasks: {
          roughIn: { total: 8, complete: 3 },
          fitOff: { total: 8, complete: 0 },
        },
        openSnagCount: 1,
        evidenceCount: 12,
        sources: [
          { store: "jobs.json", id: "job-1" },
          { store: "jobs/job-1/data.json", id: null },
        ],
      },
      hours: {
        jobId: "job-1",
        approved: { entryCount: 1, hours: 6 },
        submitted: { entryCount: 2, hours: 14.5 },
        sources: [{ store: "users/u_field/time-entries/2026-06-30.json", id: "te1" }],
      },
      openItems: {
        jobId: "job-1",
        openSnags: [{ id: "s1", description: "Missing GPO", priority: "High", area: null, raisedBy: null, createdAt: null }],
        openObservations: [],
        sources: [
          { store: "jobs/job-1/data.json", id: null },
          { store: "observations.json", id: null },
        ],
      },
      ...over,
    },
  };
}

describe("JobSummaryResponseSchema", () => {
  it("accepts the exact endpoint response shape", () => {
    const parsed = JobSummaryResponseSchema.safeParse(pack());
    expect(parsed.success).toBe(true);
  });

  it("rejects a response missing toolData (guards against a widened contract)", () => {
    const { toolData: _drop, ...rest } = pack();
    const parsed = JobSummaryResponseSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it("accepts an honest empty job (null overview projections)", () => {
    const empty = pack({
      overview: {
        job: null,
        areas: null,
        tasks: null,
        openSnagCount: null,
        evidenceCount: null,
        sources: [{ store: "jobs.json", id: "job-x" }],
      },
    });
    expect(JobSummaryResponseSchema.safeParse(empty).success).toBe(true);
  });
});

describe("factNumbers — verbatim, honest (P7)", () => {
  it("renders the REAL task/labour/snag counts straight from toolData", () => {
    const facts = factNumbers(pack().toolData, formatHoursLabel);
    const byLabel = Object.fromEntries(facts.map((f) => [f.label, f.value]));

    expect(byLabel["Rough-in"]).toBe("3 of 8 tasks complete");
    expect(byLabel["Fit-off"]).toBe("0 of 8 tasks complete");
    expect(byLabel["Areas"]).toBe("3");
    // Labour is scoped, never an unlabelled "total" — approved + awaiting shown separately.
    expect(byLabel["Hours approved"]).toBe("6h · 1 entry");
    expect(byLabel["Hours awaiting approval"]).toBe("14h 30m · 2 entries");
    expect(byLabel["Open snags"]).toBe("1");
    expect(byLabel["Open observations"]).toBe("none open");
    expect(byLabel["Evidence captured"]).toBe("12");
  });

  it("never exposes a labour figure without its approval scope", () => {
    const facts = factNumbers(pack().toolData, formatHoursLabel);
    const labels = facts.map((f) => f.label);
    // No bare "Hours"/"Total hours" — the scope is always in the label.
    expect(labels).not.toContain("Hours");
    expect(labels).not.toContain("Total hours");
    expect(labels).toContain("Hours approved");
    expect(labels).toContain("Hours awaiting approval");
  });

  it("states empty domains as honest absences, flagged empty (not faked zeros)", () => {
    const emptyJob = pack({
      overview: {
        job: { id: "job-1", name: "New job", type: null, status: "active", address: null, createdAt: null },
        areas: { count: 0 },
        tasks: { roughIn: { total: 0, complete: 0 }, fitOff: { total: 0, complete: 0 } },
        openSnagCount: 0,
        evidenceCount: 0,
        sources: [{ store: "jobs.json", id: "job-1" }],
      },
      hours: { jobId: "job-1", approved: { entryCount: 0, hours: 0 }, submitted: { entryCount: 0, hours: 0 }, sources: [] },
      openItems: { jobId: "job-1", openSnags: [], openObservations: [], sources: [] },
    });
    const facts = factNumbers(emptyJob.toolData, formatHoursLabel);
    const map = Object.fromEntries(facts.map((f) => [f.label, f]));

    expect(map["Rough-in"]!.value).toBe("no tasks");
    expect(map["Rough-in"]!.empty).toBe(true);
    expect(map["Hours approved"]!.value).toBe("none approved");
    expect(map["Hours approved"]!.empty).toBe(true);
    expect(map["Open snags"]!.value).toBe("none open");
    expect(map["Open snags"]!.empty).toBe(true);
    expect(map["Evidence captured"]!.empty).toBe(true);
  });

  it("uses singular/plural entry counts correctly", () => {
    const facts = factNumbers(pack().toolData, formatHoursLabel);
    const map = Object.fromEntries(facts.map((f) => [f.label, f.value]));
    expect(map["Hours approved"]).toContain("1 entry");
    expect(map["Hours awaiting approval"]).toContain("2 entries");
  });
});

describe("citations — map source refs to live hub anchors", () => {
  it("maps the distinct stores to real routes and dedupes", () => {
    const cites = citations(pack().toolData, "job-1");
    const byLabel = Object.fromEntries(cites.map((c) => [c.label, c.href]));

    // jobs.json + data.json collapse to the one Job overview anchor.
    expect(byLabel["Job overview"]).toBe("/v2/jobs/job-1");
    expect(byLabel["Observations"]).toBe("/v2/jobs/job-1/observations");
    expect(byLabel["Hours approvals"]).toBe("/hours/approvals");
    // No duplicate "Job overview" chip despite jobs.json AND data.json.
    expect(cites.filter((c) => c.label === "Job overview")).toHaveLength(1);
  });

  it("encodes the jobId in the routes", () => {
    const cites = citations(pack().toolData, "job/weird id");
    const overview = cites.find((c) => c.label === "Job overview");
    expect(overview!.href).toBe("/v2/jobs/job%2Fweird%20id");
  });

  it("drops unknown stores rather than fabricating a link", () => {
    // Only an unmapped store across every projection's sources → no chip at all.
    const base = pack();
    const withUnknown = pack({
      overview: { ...base.toolData.overview, sources: [{ store: "some/unmapped/store.json", id: null }] },
      hours: { ...base.toolData.hours, sources: [{ store: "another/unmapped.json", id: null }] },
      openItems: { ...base.toolData.openItems, sources: [{ store: "third/unmapped.json", id: null }] },
    });
    const cites = citations(withUnknown.toolData, "job-1");
    expect(cites).toEqual([]);
  });
});
