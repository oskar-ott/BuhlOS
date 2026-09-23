import { describe, expect, it } from "vitest";
import {
  effectiveJobStatus,
  filterJobs,
  jobStatusCounts,
  jobsEmptyStateMessage,
  jobsForStatusView,
  parseJobStatusParam,
} from "./list-filter";
import { JOB_PHASE_OPTIONS } from "./lifecycle";
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
  it("accepts every lifecycle phase the pills offer", () => {
    for (const s of JOB_PHASE_OPTIONS) {
      expect(parseJobStatusParam(s)).toBe(s);
    }
  });

  it("maps the old 'complete' pill to the closed history view", () => {
    expect(parseJobStatusParam("complete")).toBe("closed");
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
  it("'All' is the working portfolio — a closed job (complete, no stamp) is history", () => {
    // j3 is complete with no completedAt → closed → out of "All".
    expect(filterJobs(JOBS, { status: null, query: "" }).map((j) => j.id)).toEqual(["j1", "j2", "j4", "j5"]);
    expect(filterJobs(JOBS, { status: "closed", query: "" }).map((j) => j.id)).toEqual(["j3"]);
  });

  it("a job finished inside the callback window is 'finishing' and still in 'All'", () => {
    const fresh = job({ id: "j6", name: "Just Done", status: "complete", completedAt: new Date().toISOString() });
    const all = filterJobs([...JOBS, fresh], { status: null, query: "" }).map((j) => j.id);
    expect(all).toContain("j6");
    expect(filterJobs([fresh], { status: "finishing", query: "" })).toHaveLength(1);
    expect(filterJobs([fresh], { status: "closed", query: "" })).toHaveLength(0);
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

  it("matches the IV#### job code, case-insensitively, including a partial number", () => {
    const withCodes = [
      ...JOBS,
      job({ id: "j6", name: "Birdwood Reno", status: "active", code: "IV2041" }),
    ];
    expect(filterJobs(withCodes, { status: null, query: "IV2041" }).map((j) => j.id)).toEqual([
      "j6",
    ]);
    expect(filterJobs(withCodes, { status: null, query: "iv2041" }).map((j) => j.id)).toEqual([
      "j6",
    ]);
    expect(filterJobs(withCodes, { status: null, query: "2041" }).map((j) => j.id)).toEqual([
      "j6",
    ]);
    // A job with no code never matches a code search (null-safe).
    expect(filterJobs(withCodes, { status: null, query: "iv9999" })).toHaveLength(0);
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

describe("archived view", () => {
  const WITH_ARCHIVED: ReadonlyArray<Job> = [
    ...JOBS,
    job({ id: "a1", name: "Old Arthur St", status: "archived", code: "IV1001" }),
  ];

  it("the server ships archived rows ONLY for ?status=archived", () => {
    expect(jobsForStatusView(WITH_ARCHIVED, null).map((j) => j.id)).not.toContain("a1");
    expect(jobsForStatusView(WITH_ARCHIVED, "active").map((j) => j.id)).not.toContain("a1");
    expect(jobsForStatusView(WITH_ARCHIVED, "archived").map((j) => j.id)).toContain("a1");
    expect(jobsForStatusView(WITH_ARCHIVED, "archived")).toHaveLength(6);
  });

  it("the Archived filter lists archived jobs (it used to be permanently empty)", () => {
    expect(filterJobs(WITH_ARCHIVED, { status: "archived", query: "" }).map((j) => j.id)).toEqual([
      "a1",
    ]);
    expect(
      filterJobs(WITH_ARCHIVED, { status: "archived", query: "iv1001" }).map((j) => j.id)
    ).toEqual(["a1"]);
  });

  it("'All' never shows archived rows, even when the loaded list carries them", () => {
    const all = filterJobs(WITH_ARCHIVED, { status: null, query: "" });
    expect(all.map((j) => j.id)).not.toContain("a1");
    expect(all).toHaveLength(4); // j3 (closed) is history too
    expect(filterJobs(WITH_ARCHIVED, { status: null, query: "arthur" })).toHaveLength(0);
  });
});

describe("jobStatusCounts", () => {
  it("counts per status with the active fallback", () => {
    const counts = jobStatusCounts(JOBS);
    expect(counts.get("active")).toBe(2);
    expect(counts.get("on_hold")).toBe(1);
    expect(counts.get("closed")).toBe(1);
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
