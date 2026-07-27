import { describe, expect, it } from "vitest";
import {
  captureHref,
  launchableJobs,
  launcherDecision,
  philJobDetailId,
  preselectCaptureJob,
  recentShortcutJobs,
  type LaunchableJob,
} from "./philCapture";
import type { Job } from "@/domains/jobs/types";

function job(over: Partial<Job> & { id: string; name: string }): Job {
  return {
    status: "active",
    siteAddress: null,
    areaGroups: [],
    ...over,
  } as unknown as Job;
}

describe("launchableJobs", () => {
  it("drops archived jobs and keeps list order", () => {
    const result = launchableJobs([
      job({ id: "a", name: "Alpha" }),
      job({ id: "b", name: "Bravo", status: "archived" }),
      job({ id: "c", name: "Charlie", status: "on_hold" }),
    ]);
    expect(result.map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("projects only id/name/siteAddress", () => {
    const [first] = launchableJobs([
      job({ id: "a", name: "Alpha", siteAddress: "1 Site Rd" }),
    ]);
    expect(first).toEqual({ id: "a", name: "Alpha", siteAddress: "1 Site Rd" });
  });
});

describe("launcherDecision", () => {
  it("returns empty when the worker has no live jobs", () => {
    expect(launcherDecision([]).kind).toBe("empty");
    expect(
      launcherDecision([job({ id: "a", name: "Alpha", status: "archived" })]).kind
    ).toBe("empty");
  });

  it("auto-forwards when there is exactly one live job", () => {
    const decision = launcherDecision([job({ id: "only", name: "Only Job" })]);
    expect(decision.kind).toBe("single");
    if (decision.kind === "single") {
      expect(decision.job.id).toBe("only");
    }
  });

  it("offers a picker when there is more than one live job", () => {
    const decision = launcherDecision([
      job({ id: "a", name: "Alpha" }),
      job({ id: "b", name: "Bravo" }),
    ]);
    expect(decision.kind).toBe("choose");
    if (decision.kind === "choose") {
      expect(decision.jobs).toHaveLength(2);
    }
  });
});

describe("captureHref", () => {
  it("encodes the job id and carries a capture token", () => {
    expect(captureHref("job/1", 123)).toBe("/phil/jobs/job%2F1?capture=123");
  });

  it("defaults to a time-based token so repeat launches differ", () => {
    const href = captureHref("job-1");
    expect(href).toMatch(/^\/phil\/jobs\/job-1\?capture=\d+$/);
  });
});

describe("philJobDetailId", () => {
  it("returns the id on a job home route", () => {
    expect(philJobDetailId("/phil/jobs/birdwood-iv3232")).toBe("birdwood-iv3232");
  });

  it("returns null on the jobs index and other Phil routes", () => {
    expect(philJobDetailId("/phil/jobs")).toBeNull();
    expect(philJobDetailId("/phil/my-day")).toBeNull();
    expect(philJobDetailId("/phil/gear")).toBeNull();
  });

  it("returns null on job sub-routes (not the job home)", () => {
    expect(philJobDetailId("/phil/jobs/abc/itps/xyz")).toBeNull();
  });

  it("decodes an encoded id segment", () => {
    expect(philJobDetailId("/phil/jobs/job%2F1")).toBe("job/1");
  });
});

describe("preselectCaptureJob", () => {
  const jobs = [
    { id: "a", name: "Alpha", siteAddress: null },
    { id: "b", name: "Bravo", siteAddress: null },
  ];

  it("preselects the job home the FAB was tapped on when it's launchable", () => {
    expect(preselectCaptureJob(jobs, "b")).toBe("b");
  });

  it("ignores an initial job that isn't in the launchable list", () => {
    expect(preselectCaptureJob(jobs, "archived-job")).toBeNull();
  });

  it("preselects the worker's only job", () => {
    expect(preselectCaptureJob([jobs[0]!], null)).toBe("a");
  });

  it("never guesses between multiple jobs", () => {
    expect(preselectCaptureJob(jobs, null)).toBeNull();
    expect(preselectCaptureJob(jobs, undefined)).toBeNull();
  });

  it("returns null when there are no jobs at all", () => {
    expect(preselectCaptureJob([], "a")).toBeNull();
  });
});

describe("recentShortcutJobs (#146 — FAB long-press recents)", () => {
  const lj = (id: string, name = id, siteAddress: string | null = null): LaunchableJob => ({
    id,
    name,
    siteAddress,
  });
  const launchable = [lj("a", "Alpha"), lj("b", "Bravo"), lj("c", "Charlie"), lj("d", "Delta")];

  it("keeps recency order and projects the launchable job", () => {
    const r = recentShortcutJobs(["c", "a"], launchable);
    expect(r.map((j) => j.id)).toEqual(["c", "a"]);
    expect(r[0]).toEqual({ id: "c", name: "Charlie", siteAddress: null });
  });

  it("drops a stale recent that is no longer assigned (prevents the job-page 403)", () => {
    // "x" was opened once but the worker is no longer on it → not in launchable.
    const r = recentShortcutJobs(["x", "b"], launchable);
    expect(r.map((j) => j.id)).toEqual(["b"]);
  });

  it("drops a recent that has since been archived (archived jobs aren't launchable)", () => {
    // launchableJobs() already strips archived, so an archived id simply isn't
    // present in the launchable list passed in — modelled here by omission.
    const withoutArchived = [lj("a"), lj("c")]; // "b" archived → absent
    const r = recentShortcutJobs(["a", "b", "c"], withoutArchived);
    expect(r.map((j) => j.id)).toEqual(["a", "c"]);
  });

  it("caps to the max (default 3), preserving order", () => {
    const r = recentShortcutJobs(["d", "c", "b", "a"], launchable);
    expect(r.map((j) => j.id)).toEqual(["d", "c", "b"]);
  });

  it("honours a custom cap", () => {
    expect(recentShortcutJobs(["a", "b", "c"], launchable, 2).map((j) => j.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("de-duplicates a repeated recent id", () => {
    expect(recentShortcutJobs(["a", "a", "b"], launchable).map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("returns [] when every recent is stale → the FAB shows NO sheet (falls through)", () => {
    expect(recentShortcutJobs(["x", "y"], launchable)).toEqual([]);
    expect(recentShortcutJobs([], launchable)).toEqual([]);
  });

  it("integrates with launchableJobs: an archived recent is dropped end-to-end", () => {
    const all = [
      jobFix("a", "Alpha"),
      jobFix("z", "Zed", "archived"),
    ];
    const r = recentShortcutJobs(["z", "a"], launchableJobs(all));
    expect(r.map((j) => j.id)).toEqual(["a"]);
  });
});

function jobFix(id: string, name: string, status = "active"): Job {
  return { id, name, status, siteAddress: null, areaGroups: [] } as unknown as Job;
}
