import { describe, expect, it } from "vitest";
import {
  areaQuickLinks,
  areaStageAvailability,
  buildAreaCountMaps,
  countsForArea,
  evidenceCountByArea,
  hasAnyStage,
  soleStage,
} from "./philJobWorkTree";
import type { Job, JobArea } from "@/domains/jobs/types";
import type { EvidenceItem } from "@/domains/evidence/types";

/* ----------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------- */

const task = (id: string) => ({ id, name: id });

function evidence(over: Partial<EvidenceItem>): EvidenceItem {
  return {
    id: over.id ?? "ev",
    jobId: "job-1",
    areaId: over.areaId ?? null,
    stage: null,
    taskId: null,
    kind: "note",
    note: "x",
    status: "submitted",
    source: "phil",
    capturedById: "u1",
    capturedByName: "Sam",
    capturedAt: "2026-05-26T09:00:00.000Z",
    auditLogIds: [],
    createdAt: "2026-05-26T09:00:00.000Z",
    updatedAt: "2026-05-26T09:00:00.000Z",
  } as EvidenceItem;
}

/* ----------------------------------------------------------------------
 * areaStageAvailability
 * -------------------------------------------------------------------- */

describe("areaStageAvailability", () => {
  it("reports both stages when the job template has tasks and the area has no override", () => {
    const job = {
      roughInTasks: [task("r1")],
      fitOffTasks: [task("f1")],
    } as unknown as Job;
    const area = {} as JobArea;
    expect(areaStageAvailability(job, area)).toEqual({
      roughIn: true,
      fitOff: true,
    });
  });

  it("reports only rough-in when fit-off has no tasks anywhere", () => {
    const job = { roughInTasks: [task("r1")], fitOffTasks: [] } as unknown as Job;
    const area = {} as JobArea;
    expect(areaStageAvailability(job, area)).toEqual({
      roughIn: true,
      fitOff: false,
    });
  });

  it("uses the area override when present", () => {
    const job = {
      roughInTasks: [task("r1")],
      fitOffTasks: [task("f1")],
    } as unknown as Job;
    // Area overrides rough-in with its own (non-empty) list and fit-off
    // with an empty list — empty override falls back to job per
    // effectiveTasks, so fit-off stays true.
    const area = {
      roughInTasks: [task("ar1")],
      fitOffTasks: [],
    } as unknown as JobArea;
    expect(areaStageAvailability(job, area)).toEqual({
      roughIn: true,
      fitOff: true,
    });
  });

  it("excludes archived tasks from the stage check", () => {
    const job = {
      roughInTasks: [{ id: "r1", name: "r1", archived: true }],
      fitOffTasks: [],
    } as unknown as Job;
    const area = {} as JobArea;
    expect(areaStageAvailability(job, area)).toEqual({
      roughIn: false,
      fitOff: false,
    });
  });
});

/* ----------------------------------------------------------------------
 * Evidence counts
 * -------------------------------------------------------------------- */

describe("evidenceCountByArea", () => {
  it("groups evidence by areaId and ignores area-less captures", () => {
    const m = evidenceCountByArea([
      evidence({ id: "1", areaId: "a" }),
      evidence({ id: "2", areaId: "a" }),
      evidence({ id: "3", areaId: "b" }),
      evidence({ id: "4", areaId: null }),
    ]);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(1);
    expect(m.size).toBe(2);
  });
});

/* ----------------------------------------------------------------------
 * buildAreaCountMaps + countsForArea
 * -------------------------------------------------------------------- */

describe("countsForArea", () => {
  it("reads a single area's counts out of the prebuilt maps", () => {
    const maps = buildAreaCountMaps({
      evidence: [evidence({ areaId: "a" }), evidence({ id: "2", areaId: "a" })],
    });
    expect(countsForArea(maps, "a")).toEqual({ photos: 2 });
  });

  it("returns all-zero for an area with nothing", () => {
    const maps = buildAreaCountMaps({ evidence: [] });
    expect(countsForArea(maps, "ghost")).toEqual({ photos: 0 });
  });
});

/* ----------------------------------------------------------------------
 * soleStage / hasAnyStage
 * -------------------------------------------------------------------- */

describe("soleStage", () => {
  it("returns the single stage when only one has a plan", () => {
    expect(soleStage({ roughIn: true, fitOff: false })).toBe("roughIn");
    expect(soleStage({ roughIn: false, fitOff: true })).toBe("fitOff");
  });

  it("returns null when both stages have a plan (worker chooses)", () => {
    expect(soleStage({ roughIn: true, fitOff: true })).toBeNull();
  });

  it("returns null when neither stage has a plan", () => {
    expect(soleStage({ roughIn: false, fitOff: false })).toBeNull();
  });
});

describe("hasAnyStage", () => {
  it("is true when at least one stage has a plan", () => {
    expect(hasAnyStage({ roughIn: true, fitOff: false })).toBe(true);
    expect(hasAnyStage({ roughIn: false, fitOff: true })).toBe(true);
    expect(hasAnyStage({ roughIn: true, fitOff: true })).toBe(true);
  });

  it("is false when neither stage has a plan", () => {
    expect(hasAnyStage({ roughIn: false, fitOff: false })).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * areaQuickLinks
 * -------------------------------------------------------------------- */

describe("areaQuickLinks", () => {
  it("emits one link per non-zero count, with its anchor", () => {
    const links = areaQuickLinks({ photos: 5 });
    expect(links.map((l) => l.key)).toEqual(["photos"]);
    expect(links.map((l) => l.label)).toEqual(["5 photos"]);
    expect(links.map((l) => l.anchor)).toEqual(["#phil-job-capture"]);
  });

  it("hides zero counts (no zero-count noise)", () => {
    expect(areaQuickLinks({ photos: 0 })).toEqual([]);
  });

  it("singularises labels at count 1", () => {
    expect(areaQuickLinks({ photos: 1 }).map((l) => l.label)).toEqual(["1 photo"]);
  });

  it("never emits a document or material link (no area linkage exists)", () => {
    const keys = areaQuickLinks({ photos: 9 }).map((l) => l.key);
    expect(keys).not.toContain("documents");
    expect(keys).not.toContain("materials");
    expect(keys).toEqual(["photos"]);
  });
});
