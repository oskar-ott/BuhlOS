import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Snags row builder (#152, pure). Re-keys legacy capture coordinates onto the
 * canonical task identity via the SAME shared proof-projection the evidence
 * importer uses, and fails closed on any unresolvable or out-of-CHECK record.
 * snagsV2 only; snag_comments has no blob source.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/snags-rows.js");
const mod = requireFromHere(p) as {
  buildSnagRows: (sources: unknown, ctx: unknown) => {
    snagRows: Array<Record<string, unknown>>;
    quarantine: Array<{ table: string; id: string; reason: string }>;
    byGranularity: { task: number; area: number; job: number };
  };
  SNAG_INSERT_COLS: string[];
  SNAG_MUTABLE_COLS: string[];
};
const { buildSnagRows, SNAG_INSERT_COLS, SNAG_MUTABLE_COLS } = mod;

const legacyIdPath = requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js");
const { compositeLegacyId } = requireFromHere(legacyIdPath) as { compositeLegacyId: (j: string, l: string) => string };

const AL1 = compositeLegacyId("j1", "a1");
function ctx() {
  return {
    tenantId: "T",
    jobMap: new Map([["j1", "job-uuid"]]),
    areaMap: new Map([[AL1, "area-uuid"]]),
    taskMap: new Map([[`${AL1}|roughIn|t1`, "task-uuid"]]),
    userMap: new Map([["u1", "user-uuid"]]),
  };
}
function src(snagsV2: unknown[]) {
  return { jobs: { jobs: [{ id: "j1" }] }, jobData: { j1: { snagsV2 } } };
}
const base = { status: "open", priority: "normal", source: "phil", createdAt: "2026-01-01T00:00:00.000Z" };
const snag = (over: Record<string, unknown> = {}) => ({ id: "s", title: "Loose conduit", ...base, ...over });

describe("buildSnagRows — re-keying + granularity", () => {
  it("job-level snag: no area/task, granularity job", () => {
    const { snagRows, quarantine, byGranularity } = buildSnagRows(src([snag({ id: "s1" })]), ctx());
    expect(quarantine).toHaveLength(0);
    expect(snagRows[0]).toMatchObject({ legacy_id: "s1", title: "Loose conduit", status: "open", job_id: "job-uuid", site_area_id: null, task_id: null });
    expect(byGranularity).toEqual({ task: 0, area: 0, job: 1 });
  });

  it("area-level snag: site_area_id resolved, task_id null, assigned_to resolved", () => {
    const { snagRows, byGranularity } = buildSnagRows(src([snag({ id: "s2", areaId: "a1", priority: "high", source: "admin", assignedToId: "u1", assignedToName: "Tom" })]), ctx());
    expect(snagRows[0]).toMatchObject({ legacy_id: "s2", site_area_id: "area-uuid", task_id: null, assigned_to: "user-uuid", priority: "high", source: "admin" });
    expect(byGranularity.area).toBe(1);
  });

  it("task-level snag: full coordinate resolves to task_id; granularity task; transition actors re-keyed", () => {
    const { snagRows, byGranularity } = buildSnagRows(
      src([snag({ id: "s3", areaId: "a1", stage: "roughIn", taskId: "t1", status: "resolved", resolvedById: "u1", resolvedByName: "Tom", resolvedAt: "2026-02-02T00:00:00.000Z" })]),
      ctx(),
    );
    expect(snagRows[0]).toMatchObject({ task_id: "task-uuid", site_area_id: "area-uuid", stage: "roughIn", status: "resolved", resolved_by: "user-uuid", resolved_by_label: "Tom", resolved_at: "2026-02-02T00:00:00.000Z" });
    expect(byGranularity.task).toBe(1);
  });

  it("QUARANTINES a taskId with an incomplete coordinate (no stage) — never guessed onto a task", () => {
    const { quarantine, snagRows } = buildSnagRows(src([snag({ id: "s4", areaId: "a1", taskId: "t1" })]), ctx());
    expect(snagRows).toHaveLength(0);
    expect(quarantine[0]!.reason).toMatch(/without a full/);
  });

  it("QUARANTINES an unresolvable areaId and an unresolvable taskId (no wrong-task attach)", () => {
    expect(buildSnagRows(src([snag({ id: "s5", areaId: "ghost" })]), ctx()).quarantine[0]!.reason).toMatch(/does not resolve to a site_area/);
    expect(buildSnagRows(src([snag({ id: "s6", areaId: "a1", stage: "fitOff", taskId: "nope" })]), ctx()).quarantine[0]!.reason).toMatch(/does not resolve to a task/);
  });

  it("QUARANTINES out-of-CHECK status/priority/source/stage", () => {
    expect(buildSnagRows(src([snag({ id: "a", status: "weird" })]), ctx()).quarantine[0]!.reason).toMatch(/status/);
    expect(buildSnagRows(src([snag({ id: "b", priority: "huge" })]), ctx()).quarantine[0]!.reason).toMatch(/priority/);
    expect(buildSnagRows(src([snag({ id: "c", source: "client" })]), ctx()).quarantine[0]!.reason).toMatch(/source/);
    expect(buildSnagRows(src([snag({ id: "d", stage: "commissioning" })]), ctx()).quarantine[0]!.reason).toMatch(/stage/);
  });

  it("QUARANTINES a missing/over-length title, over-length description/rejection_reason, missing created_at, and duplicates", () => {
    expect(buildSnagRows(src([snag({ id: "e", title: "  " })]), ctx()).quarantine[0]!.reason).toMatch(/title missing/);
    expect(buildSnagRows(src([snag({ id: "f", title: "x".repeat(121) })]), ctx()).quarantine[0]!.reason).toMatch(/title exceeds/);
    expect(buildSnagRows(src([snag({ id: "g", description: "x".repeat(1001) })]), ctx()).quarantine[0]!.reason).toMatch(/description exceeds/);
    expect(buildSnagRows(src([snag({ id: "h", status: "rejected", rejectionReason: "x".repeat(501) })]), ctx()).quarantine[0]!.reason).toMatch(/rejection_reason exceeds/);
    expect(buildSnagRows(src([snag({ id: "i", createdAt: undefined })]), ctx()).quarantine[0]!.reason).toMatch(/created_at missing/);
    const dup = buildSnagRows(src([snag({ id: "x" }), snag({ id: "x" })]), ctx());
    expect(dup.snagRows).toHaveLength(1);
    expect(dup.quarantine[0]!.reason).toMatch(/duplicate/);
  });

  it("updated_at falls back to created_at; keeps insert/mutable column lists in lock-step", () => {
    const { snagRows } = buildSnagRows(src([snag({ id: "s7" })]), ctx());
    expect(snagRows[0]!.updated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(new Set(SNAG_INSERT_COLS)).toEqual(new Set(Object.keys(snagRows[0]!)));
    expect(SNAG_MUTABLE_COLS).not.toContain("legacy_id");
    expect(SNAG_MUTABLE_COLS).not.toContain("created_at");
    expect(SNAG_MUTABLE_COLS).toContain("status"); // workflow state can change on re-import
  });
});
