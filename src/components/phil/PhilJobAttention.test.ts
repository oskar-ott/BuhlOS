import { describe, expect, it } from "vitest";
import { deriveAttention } from "./PhilJobAttention";
import type { Job } from "@/domains/jobs/types";

/* ----------------------------------------------------------------------
 * Fixtures — only the fields deriveAttention reads. Everything else is
 * either covered by the domain schemas or irrelevant to the predicate.
 * -------------------------------------------------------------------- */

const baseJob: Job = {
  id: "birdwood-iv3232",
  name: "Birdwood Pub fitout",
} as Job;

/* ----------------------------------------------------------------------
 * Tests
 * -------------------------------------------------------------------- */

describe("deriveAttention", () => {
  it("returns no items for a clean job", () => {
    const { items, total } = deriveAttention({ job: baseJob });
    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it("surfaces induction required as an info-tone alert", () => {
    const inducedJob = { ...baseJob, inductionRequired: true } as Job;
    const { items } = deriveAttention({ job: inducedJob });
    const induction = items.find((i) => i.id === "induction");
    expect(induction).toBeDefined();
    expect(induction!.tone).toBe("info");
    expect(induction!.anchor).toBe("#phil-job-site");
    // Bible §07 — reasonShown is mandatory.
    expect(induction!.reasonShown.length).toBeGreaterThan(10);
  });

  it("clears the induction item once THIS worker has a record (#332)", () => {
    const inducedJob = { ...baseJob, inductionRequired: true } as Job;
    const { items } = deriveAttention({ job: inducedJob, inductionDone: true });
    expect(items.find((i) => i.id === "induction")).toBeUndefined();
  });
});
