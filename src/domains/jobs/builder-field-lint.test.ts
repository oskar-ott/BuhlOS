import { describe, expect, it } from "vitest";
import { buildFieldLint, buildBuilderReadiness, buildPhilPreview } from "./builder";
import type { Job } from "./types";

function makeJob(over: Partial<Job> & { id: string; name: string }): Job {
  return { ...over } as Job;
}

/** A clean, publishable job: a name, one area with a rough-in task, a site. */
function cleanJob(): Job {
  return makeJob({
    id: "j",
    name: "Birdwood",
    status: "active",
    siteAddress: "1 Birdwood Ave",
    areaGroups: [
      {
        id: "g1",
        name: "Level 1",
        areas: [
          { id: "a1", name: "Unit 1", roughInTasks: [{ id: "t1", name: "Pull cables" }] },
        ],
      },
    ],
  } as Partial<Job> & { id: string; name: string });
}

describe("buildFieldLint", () => {
  it("passes a clean job", () => {
    expect(buildFieldLint(cleanJob())).toEqual([]);
  });

  it("warns about an area with no tasks at either stage", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      areaGroups: [{ id: "g1", name: "L1", areas: [{ id: "a1", name: "Empty room" }] }],
    } as Partial<Job> & { id: string; name: string });
    const issues = buildFieldLint(job);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "area-no-tasks",
      severity: "warning",
      target: { kind: "area", id: "a1", name: "Empty room" },
    });
  });

  it("does NOT warn when an area inherits job-level tasks", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      roughInTasks: [{ id: "jt", name: "Job rough" }],
      areaGroups: [{ id: "g1", name: "L1", areas: [{ id: "a1", name: "Unit 1" }] }],
    } as Partial<Job> & { id: string; name: string });
    expect(buildFieldLint(job)).toEqual([]);
  });

  it("errors on a per-area task with a blank name", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      areaGroups: [
        {
          id: "g1",
          name: "L1",
          areas: [{ id: "a1", name: "Unit 1", roughInTasks: [{ id: "t1", name: "   " }] }],
        },
      ],
    } as Partial<Job> & { id: string; name: string });
    const issues = buildFieldLint(job);
    expect(issues.some((i) => i.code === "blank-task" && i.severity === "error")).toBe(true);
  });

  it("ignores archived override tasks", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      areaGroups: [
        {
          id: "g1",
          name: "L1",
          areas: [
            {
              id: "a1",
              name: "Unit 1",
              roughInTasks: [{ id: "t1", name: "", archived: true }],
              fitOffTasks: [{ id: "t2", name: "Terminate" }],
            },
          ],
        },
      ],
    } as Partial<Job> & { id: string; name: string });
    // archived blank is skipped; the live fit-off task means the area isn't empty
    expect(buildFieldLint(job)).toEqual([]);
  });

  it("skips archived areas (they aren't field-visible)", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      areaGroups: [{ id: "g1", name: "L1", areas: [{ id: "a1", name: "Old room", archived: true }] }],
    } as Partial<Job> & { id: string; name: string });
    expect(buildFieldLint(job)).toEqual([]);
  });
});

describe("buildBuilderReadiness", () => {
  it("is `yes` / publishable for a clean job", () => {
    const r = buildBuilderReadiness(cleanJob());
    expect(r.state).toBe("yes");
    expect(r.canPublish).toBe(true);
    expect(r.blockingCount).toBe(0);
    expect(r.warningCount).toBe(0);
    expect(r.stateLabel).toBe("Ready to publish");
    expect(r.tone).toBe("success");
  });

  it("is `no` / not publishable when the publish gate raises a blocker", () => {
    const job = makeJob({ id: "j", name: "   " }); // blank name → publish error
    const r = buildBuilderReadiness(job);
    expect(r.state).toBe("no");
    expect(r.canPublish).toBe(false);
    expect(r.blockers.some((b) => b.source === "publish" && b.code === "name-missing")).toBe(true);
    expect(r.tone).toBe("danger");
  });

  it("is `warnings` / still publishable when only advisories remain", () => {
    // clean structure but no site address → publish warning, no blockers
    const job = makeJob({
      id: "j",
      name: "J",
      status: "active",
      areaGroups: [
        { id: "g1", name: "L1", areas: [{ id: "a1", name: "Unit 1", roughInTasks: [{ id: "t1", name: "Pull" }] }] },
      ],
    } as Partial<Job> & { id: string; name: string });
    const r = buildBuilderReadiness(job);
    expect(r.state).toBe("warnings");
    expect(r.canPublish).toBe(true);
    expect(r.warnings.some((w) => w.code === "no-site-address")).toBe(true);
  });

  it("folds field-lint warnings into the rollup alongside publish warnings", () => {
    const job = makeJob({
      id: "j",
      name: "J",
      status: "active",
      siteAddress: "1 St",
      // an empty area produces a field-lint warning; structure otherwise has a task
      areaGroups: [
        {
          id: "g1",
          name: "L1",
          areas: [
            { id: "a1", name: "Unit 1", roughInTasks: [{ id: "t1", name: "Pull" }] },
            { id: "a2", name: "Empty" },
          ],
        },
      ],
    } as Partial<Job> & { id: string; name: string });
    const r = buildBuilderReadiness(job);
    expect(r.warnings.some((w) => w.source === "field" && w.code === "area-no-tasks")).toBe(true);
  });
});

describe("buildPhilPreview carries the field-lint", () => {
  it("exposes fieldLint as part of the preview view-model", () => {
    const preview = buildPhilPreview(cleanJob());
    expect(Array.isArray(preview.fieldLint)).toBe(true);
    expect(preview.fieldLint).toEqual([]);
  });
});
