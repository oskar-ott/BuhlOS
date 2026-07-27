import { describe, expect, it } from "vitest";
import type { Job } from "@/domains/jobs/types";
import { isSafeActionHref } from "@/domains/exceptions/service";
import { singleJobTarget } from "./queue-card-targets";

function job(partial: Partial<Job> & { id: string }): Job {
  return {
    name: `Job ${partial.id}`,
    ...partial,
  } as Job;
}

describe("singleJobTarget", () => {
  it("falls back to the jobs index when zero or multiple jobs are affected", () => {
    expect(singleJobTarget([], "evidence")).toEqual({ href: "/v2/jobs", cta: "Open jobs" });
    expect(singleJobTarget([job({ id: "a" }), job({ id: "b" })], "evidence")).toEqual({
      href: "/v2/jobs",
      cta: "Open jobs",
    });
  });

  it("keeps normal single-job evidence links readable", () => {
    expect(singleJobTarget([job({ id: "birdwood-iv3232" })], "evidence")).toEqual({
      href: "/v2/jobs/birdwood-iv3232/evidence",
      cta: "Open evidence",
    });
  });

  it("encodes unsafe job id characters in single-job evidence links", () => {
    const oddJob = job({ id: "job/with?bad#chars" });
    const evidence = singleJobTarget([oddJob], "evidence");

    expect(evidence.href).toBe("/v2/jobs/job%2Fwith%3Fbad%23chars/evidence");
    expect(isSafeActionHref(evidence.href)).toBe(true);
    expect(evidence.href).not.toContain("job/with?bad#chars");
  });
});
