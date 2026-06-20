import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * J3-prep task-expansion projection (read-only validation gate). Pure expansion of
 * job_task_templates → canonical task INSTANCES via the override-wins rule, with
 * canonical-identity collision detection, status mapping from recorded blob state,
 * suppressed (archived) counts, and orphaned-recorded-state detection. NO writes.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/task-projection.js");
const { buildTaskProjection } = requireFromHere(p) as {
  buildTaskProjection: (sources: unknown) => {
    clean: boolean;
    totals: { templates: number; instances: number; byStage: { roughIn: number; fitOff: number }; byStatus: { not_started: number; in_progress: number; complete: number } };
    overrides: number;
    suppressed: { archivedAreas: number; archivedTemplates: number; unknownState: number };
    collisions: Array<{ jobLegacy: string; areaLegacy: string; stage: string; templateId: string }>;
    malformed: Array<{ jobLegacy: string; areaLegacy: string; stage: string; name: string }>;
    orphanedState: Array<{ kind: string; jobLegacy: string; areaId: string; stage: string; taskId: string }>;
    jobs: Array<{ jobLegacy: string; name: string; instances: number; areas: Array<{ areaLegacy: string; areaName: string; roughIn: number; fitOff: number }> }>;
  };
};

const legacyIdPath = requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js");
const { compositeLegacyId } = requireFromHere(legacyIdPath) as { compositeLegacyId: (j: string, l: string) => string };

// Build sources: jobs.json + per-job data.json (dwellings state).
function sources(jobs: unknown[], jobData: Record<string, unknown> = {}) {
  return { jobs: { jobs }, jobData };
}
function job(id: string, over: Record<string, unknown> = {}) {
  return { id, name: `Job ${id}`, status: "active", areaGroups: [], ...over };
}
function area(id: string, over: Record<string, unknown> = {}) {
  return { id, name: `Area ${id}`, ...over };
}

describe("buildTaskProjection", () => {
  it("expands job-level templates across live areas × stages (one instance each)", () => {
    const j = job("j1", {
      roughInTasks: [{ id: "r1", name: "Rough 1" }, { id: "r2", name: "Rough 2" }],
      fitOffTasks: [{ id: "f1", name: "Fit 1" }],
      areaGroups: [{ id: "g1", name: "G", areas: [area("a1"), area("a2")] }],
    });
    const r = buildTaskProjection(sources([j]));
    // 2 areas × (2 rough + 1 fit) = 6 instances
    expect(r.totals.instances).toBe(6);
    expect(r.totals.byStage).toEqual({ roughIn: 4, fitOff: 2 });
    expect(r.totals.templates).toBe(3); // job-level definitions counted once
    expect(r.collisions).toHaveLength(0);
    expect(r.clean).toBe(true);
    const a1 = r.jobs[0]!.areas.find((a) => a.areaLegacy === compositeLegacyId("j1", "a1"))!;
    expect(a1).toMatchObject({ roughIn: 2, fitOff: 1 });
  });

  it("override-wins: a non-empty area override replaces the job default for that area+stage", () => {
    const j = job("j1", {
      roughInTasks: [{ id: "r1", name: "Default R1" }],
      areaGroups: [{ id: "g1", name: "G", areas: [
        area("a1"), // uses job default → r1
        area("a2", { roughInTasks: [{ id: "x1", name: "Override" }, { id: "x2", name: "Override 2" }] }),
      ] }],
    });
    const r = buildTaskProjection(sources([j]));
    expect(r.overrides).toBe(1); // a2 roughIn used an override
    const a1 = r.jobs[0]!.areas.find((a) => a.areaName === "Area a1")!;
    const a2 = r.jobs[0]!.areas.find((a) => a.areaName === "Area a2")!;
    expect(a1.roughIn).toBe(1); // default r1
    expect(a2.roughIn).toBe(2); // override x1,x2 (NOT the default)
    expect(r.totals.instances).toBe(3);
  });

  it("suppresses archived templates and archived areas (and counts them)", () => {
    const j = job("j1", {
      roughInTasks: [{ id: "r1", name: "Live" }, { id: "r2", name: "Old", archived: true }],
      areaGroups: [{ id: "g1", name: "G", areas: [area("a1"), area("a2", { archived: true })] }],
    });
    const r = buildTaskProjection(sources([j]));
    // only a1 live × 1 live template (r1) = 1 instance
    expect(r.totals.instances).toBe(1);
    expect(r.suppressed.archivedAreas).toBe(1);
    expect(r.suppressed.archivedTemplates).toBe(1);
    expect(r.totals.templates).toBe(1); // only the live r1 counted
  });

  it("detects a canonical-identity collision (duplicate taskId within one area+stage)", () => {
    const j = job("j1", {
      roughInTasks: [{ id: "dup", name: "A" }, { id: "dup", name: "B" }],
      areaGroups: [{ id: "g1", name: "G", areas: [area("a1")] }],
    });
    const r = buildTaskProjection(sources([j]));
    expect(r.collisions).toHaveLength(1);
    expect(r.collisions[0]).toMatchObject({ areaLegacy: compositeLegacyId("j1", "a1"), stage: "roughIn", templateId: "dup" });
    expect(r.clean).toBe(false);
    expect(r.totals.instances).toBe(1); // the collision is not double-counted
  });

  it("maps recorded blob state to instance status; unknown state → not_started (counted)", () => {
    const j = job("j1", {
      roughInTasks: [{ id: "r1", name: "R1" }, { id: "r2", name: "R2" }, { id: "r3", name: "R3" }],
      areaGroups: [{ id: "g1", name: "G", areas: [area("a1")] }],
    });
    const data = { j1: { dwellings: { a1: { roughIn: { tasks: { r1: "complete", r2: "in_progress", r3: "weird" } } } } } };
    const r = buildTaskProjection(sources([j], data));
    expect(r.totals.byStatus).toEqual({ not_started: 1, in_progress: 1, complete: 1 }); // r3 weird → not_started
    expect(r.suppressed.unknownState).toBe(1);
  });

  it("flags orphaned recorded state (no matching template, or non-live area)", () => {
    const j = job("j1", {
      roughInTasks: [{ id: "r1", name: "R1" }],
      areaGroups: [{ id: "g1", name: "G", areas: [area("a1"), area("a2", { archived: true })] }],
    });
    const data = { j1: { dwellings: {
      a1: { roughIn: { tasks: { r1: "complete", ghost: "complete" } } }, // ghost → no template
      a2: { roughIn: { tasks: { r1: "complete" } } },                    // a2 archived → non-live area
    } } };
    const r = buildTaskProjection(sources([j], data));
    expect(r.orphanedState).toHaveLength(2);
    expect(r.orphanedState.map((o) => o.kind).sort()).toEqual(["state→no-template", "state→non-live-area"]);
    expect(r.clean).toBe(false);
  });

  it("flags a malformed template (name but no id) instead of minting an undefined identity", () => {
    const j = job("j1", {
      roughInTasks: [{ id: "r1", name: "Good" }, { name: "No id" }],
      areaGroups: [{ id: "g1", name: "G", areas: [area("a1")] }],
    });
    const r = buildTaskProjection(sources([j]));
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]).toMatchObject({ areaLegacy: compositeLegacyId("j1", "a1"), stage: "roughIn", name: "No id" });
    expect(r.totals.instances).toBe(1); // only the good one becomes an instance
    expect(r.clean).toBe(false);
  });

  it("clean projection over a multi-job set has no collisions and reports per-job instances", () => {
    const j1 = job("j1", { roughInTasks: [{ id: "r1", name: "R1" }], areaGroups: [{ id: "g1", name: "G", areas: [area("a1")] }] });
    const j2 = job("j2", { fitOffTasks: [{ id: "f1", name: "F1" }], areaGroups: [{ id: "g2", name: "G", areas: [area("a1")] }] });
    const r = buildTaskProjection(sources([j1, j2]));
    expect(r.clean).toBe(true);
    expect(r.totals.instances).toBe(2);
    // same bare area id "a1" across two jobs must NOT collide (composite scoping)
    expect(r.collisions).toHaveLength(0);
    expect(r.jobs.map((x) => x.instances)).toEqual([1, 1]);
  });
});
