import { describe, expect, it } from "vitest";
import {
  captureHref,
  launchableJobs,
  launcherDecision,
  philJobDetailId,
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
