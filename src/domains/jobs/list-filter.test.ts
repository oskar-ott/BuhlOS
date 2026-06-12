import { describe, expect, it } from "vitest";
import {
  effectiveJobStatus,
  filterJobs,
  jobStatusCounts,
  jobsEmptyStateMessage,
  parseJobStatusParam,
} from "./list-filter";
import { JOB_STATUS_OPTIONS } from "./format";
import type { Job } from "./types";

/**
 * Pure filter matrix for the /v2/jobs list (#216). The render test covers
 * the wiring; this file pins the semantics — especially the format.ts
 * parity rule (a job with no status displays "Active", so it must filter
 * as active too) and the validate-against-the-real-set rule for params.
 */

function job(over: Partial<Job> & { id: string; name: string }): Job {
  return { ...over } as Job;
}

const JOBS: ReadonlyArray<Job> = [
  job({ id: "j1", name: "Smith St Rewire", status: "active", siteAddress: "12 Smith St" }),
  job({ id: "j2", name: "Harbour Tower", status: "on_hold", ref: "HT-09" }),
  job({ id: "j3", name: "Depot Fit-off", status: "complete" }),
  job({ id: "j4", name: "Legacy Cottage" }), // pre-status-field row → active
  job({ id: "j5", name: "Draft Duplex", status: "draft" }),
];

describe("parseJobStatusParam", () => {
  it("accepts every status format.ts enumerates", () => {
    for (const s of JOB_STATUS_OPTIONS) {
      expect(parseJobStatusParam(s)).toBe(s);
    }
  });

  it("degrades unknown, empty and missing values to null (all)", () => {
    expect(parseJobStatusParam("bogus")).toBeNull();
    expect(parseJobStatusParam("ACTIVE")).toBeNull();
    expect(parseJobStatusParam("")).toBeNull();
    expect(parseJobStatusParam(null)).toBeNull();
    expect(parseJobStatusParam(undefined)).toBeNull();
  });
});

describe("effectiveJobStatus", () => {
  it("mirrors format.ts: a missing status counts as active", () => {
    expect(effectiveJobStatus({ status: undefined })).toBe("active");
    expect(effectiveJobStatus({ status: "draft" })).toBe("draft");
  });
});

describe("filterJobs", () => {
  it("returns everything when no filter is set", () => {
    expect(filterJobs(JOBS, { status: null, query: "" })).toHaveLength(5);
  });

  it("filters by status, including the missing-status→active fallback", () => {
    const active = filterJobs(JOBS, { status: "active", query: "" });
    expect(active.map((j) => j.id)).toEqual(["j1", "j4"]);
    expect(filterJobs(JOBS, { status: "on_hold", query: "" }).map((j) => j.id)).toEqual([
      "j2",
    ]);
    expect(filterJobs(JOBS, { status: "archived", query: "" })).toHaveLength(0);
  });

  it("matches the query against name, address and ref, case-insensitively", () => {
    expect(filterJobs(JOBS, { status: null, query: "smith" }).map((j) => j.id)).toEqual([
      "j1",
    ]);
    expect(filterJobs(JOBS, { status: null, query: "12 SMITH" }).map((j) => j.id)).toEqual(
      ["j1"]
    );
    expect(filterJobs(JOBS, { status: null, query: "ht-09" }).map((j) => j.id)).toEqual([
      "j2",
    ]);
  });

  it("applies status and query together", () => {
    expect(
      filterJobs(JOBS, { status: "active", query: "cottage" }).map((j) => j.id)
    ).toEqual(["j4"]);
    expect(filterJobs(JOBS, { status: "draft", query: "cottage" })).toHaveLength(0);
  });

  it("ignores surrounding whitespace in the query and never mutates input", () => {
    const input = [...JOBS];
    expect(filterJobs(input, { status: null, query: "  rewire  " })).toHaveLength(1);
    expect(input).toHaveLength(5);
  });
});

describe("jobStatusCounts", () => {
  it("counts per status with the active fallback", () => {
    const counts = jobStatusCounts(JOBS);
    expect(counts.get("active")).toBe(2);
    expect(counts.get("on_hold")).toBe(1);
    expect(counts.get("complete")).toBe(1);
    expect(counts.get("draft")).toBe(1);
    expect(counts.get("archived")).toBeUndefined();
  });
});

describe("jobsEmptyStateMessage", () => {
  it("names both active filters", () => {
    expect(jobsEmptyStateMessage({ status: "on_hold", query: "smith" })).toBe(
      "No on hold jobs match “smith”. Try a different search or status."
    );
  });

  it("names the status alone", () => {
    expect(jobsEmptyStateMessage({ status: "draft", query: " " })).toBe(
      "No draft jobs in this list. Try a different status."
    );
  });

  it("names the query alone", () => {
    expect(jobsEmptyStateMessage({ status: null, query: "zzz" })).toBe(
      "No jobs match “zzz”. Try a different search term."
    );
  });
});
