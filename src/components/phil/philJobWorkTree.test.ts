import { describe, expect, it } from "vitest";
import {
  activeAreaItpCountByArea,
  activeSnagCountByArea,
  areaStageAvailability,
  buildAreaCountMaps,
  countsForArea,
  evidenceCountByArea,
} from "./philJobWorkTree";
import type { Job, JobArea } from "@/domains/jobs/types";
import type { SnagItem } from "@/domains/snags/types";
import type { ITPInstance } from "@/domains/itp/types";
import type { EvidenceItem } from "@/domains/evidence/types";

/* ----------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------- */

const task = (id: string) => ({ id, name: id });

function snag(over: Partial<SnagItem>): SnagItem {
  return {
    id: over.id ?? "sn",
    jobId: "job-1",
    title: "snag",
    description: null,
    summary: null,
    stage: null,
    areaId: over.areaId ?? null,
    areaName: null,
    taskId: null,
    taskName: null,
    evidenceIds: [],
    status: over.status ?? "open",
    priority: "normal",
    source: "phil",
    createdById: "u1",
    createdByName: "Sam",
    createdByRole: "tradie",
    assignedToId: null,
    assignedToName: null,
    acknowledgedAt: null,
    acknowledgedById: null,
    acknowledgedByName: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    verifiedAt: null,
    verifiedById: null,
    verifiedByName: null,
    closedAt: null,
    closedById: null,
    closedByName: null,
    rejectedAt: over.status === "rejected" ? "2026-05-25T17:00:00.000Z" : null,
    rejectedById: over.status === "rejected" ? "admin" : null,
    rejectedByName: over.status === "rejected" ? "Anna" : null,
    rejectionReason: over.status === "rejected" ? "dupe" : null,
    auditLogIds: [],
    createdAt: "2026-05-25T14:30:00.000Z",
    updatedAt: "2026-05-25T14:30:00.000Z",
  } as SnagItem;
}

function itp(over: Partial<ITPInstance>): ITPInstance {
  return {
    id: over.id ?? "itp",
    templateId: "tpl",
    templateSnapshot: { name: "ITP", points: [] },
    scope: over.scope ?? "area",
    scopeId: over.scopeId,
    status: over.status ?? "pending",
    results: {},
    archived: over.archived ?? false,
    createdAt: "2026-05-26T08:00:00.000Z",
    createdBy: "anna",
    updatedAt: "2026-05-26T08:00:00.000Z",
  } as ITPInstance;
}

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
 * Snag counts
 * -------------------------------------------------------------------- */

describe("activeSnagCountByArea", () => {
  it("groups active snags by areaId", () => {
    const m = activeSnagCountByArea([
      snag({ id: "1", areaId: "a", status: "open" }),
      snag({ id: "2", areaId: "a", status: "in_progress" }),
      snag({ id: "3", areaId: "b", status: "rejected" }),
    ]);
    expect(m.get("a")).toBe(2);
    expect(m.get("b")).toBe(1);
  });

  it("counts rejected snags (worker still needs to act)", () => {
    const m = activeSnagCountByArea([snag({ areaId: "a", status: "rejected" })]);
    expect(m.get("a")).toBe(1);
  });

  it("ignores verified/closed snags and area-less snags", () => {
    const m = activeSnagCountByArea([
      snag({ id: "1", areaId: "a", status: "verified" }),
      snag({ id: "2", areaId: "a", status: "closed" }),
      snag({ id: "3", areaId: null, status: "open" }),
    ]);
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(0);
  });
});

/* ----------------------------------------------------------------------
 * ITP counts
 * -------------------------------------------------------------------- */

describe("activeAreaItpCountByArea", () => {
  it("counts only area-scoped, active, non-archived instances", () => {
    const m = activeAreaItpCountByArea([
      itp({ id: "1", scope: "area", scopeId: "a", status: "pending" }),
      itp({ id: "2", scope: "area", scopeId: "a", status: "in-progress" }),
      itp({ id: "3", scope: "area", scopeId: "a", status: "signed-off" }), // done
      itp({ id: "4", scope: "area", scopeId: "a", status: "pending", archived: true }),
      itp({ id: "5", scope: "job", status: "pending" }), // not area-scoped
      itp({ id: "6", scope: "level", scopeId: "grp", status: "pending" }),
    ]);
    expect(m.get("a")).toBe(2);
    expect(m.get("grp")).toBeUndefined();
  });

  it("includes witnessed instances (still worker-visible)", () => {
    const m = activeAreaItpCountByArea([
      itp({ scope: "area", scopeId: "a", status: "witnessed" }),
    ]);
    expect(m.get("a")).toBe(1);
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
      snags: [snag({ areaId: "a", status: "open" })],
      itps: [itp({ scope: "area", scopeId: "a", status: "pending" })],
      evidence: [evidence({ areaId: "a" }), evidence({ id: "2", areaId: "a" })],
    });
    expect(countsForArea(maps, "a")).toEqual({ snags: 1, itps: 1, photos: 2 });
  });

  it("returns all-zero for an area with nothing", () => {
    const maps = buildAreaCountMaps({ snags: [], itps: [], evidence: [] });
    expect(countsForArea(maps, "ghost")).toEqual({
      snags: 0,
      itps: 0,
      photos: 0,
    });
  });
});
