import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Observations row builder (#152, pure). Re-keys legacy coordinates onto canonical
 * task identity via the SAME shared proof-projection; quarantines office items (no
 * jobId, since job_id is NOT NULL), unresolvable coordinates, and out-of-CHECK
 * values; resolves linked_snag_id best-effort; nulls linked_material_request_id.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/observations-rows.js");
const mod = requireFromHere(p) as {
  buildObservationRows: (sources: unknown, ctx: unknown) => {
    observationRows: Array<Record<string, unknown>>;
    quarantine: Array<{ table: string; id: string; reason: string }>;
    byGranularity: { task: number; area: number; job: number };
  };
  OBSERVATION_INSERT_COLS: string[];
  OBSERVATION_MUTABLE_COLS: string[];
};
const { buildObservationRows, OBSERVATION_INSERT_COLS, OBSERVATION_MUTABLE_COLS } = mod;

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
    snagMap: new Map([["sn1", "snag-uuid"]]),
  };
}
function src(observations: unknown[]) {
  return { observations: { observations } };
}
const base = { jobId: "j1", type: "note", status: "new", priority: "normal", source: "phil", createdAt: "2026-01-01T00:00:00.000Z" };
const obs = (over: Record<string, unknown> = {}) => ({ id: "o", title: "Check riser", ...base, ...over });

describe("buildObservationRows — re-keying + granularity", () => {
  it("job-level observation: no area/task; material link nulled; defaults", () => {
    const { observationRows, quarantine, byGranularity } = buildObservationRows(src([obs({ id: "o1" })]), ctx());
    expect(quarantine).toHaveLength(0);
    expect(observationRows[0]).toMatchObject({
      legacy_id: "o1", type: "note", status: "new", job_id: "job-uuid",
      site_area_id: null, task_id: null, requires_action: false,
      linked_material_request_id: null, photo_urls: [], updated_by: null,
    });
    expect(byGranularity).toEqual({ task: 0, area: 0, job: 1 });
  });

  it("task-level observation: full coordinate resolves; snag link + photos + assignee resolved", () => {
    const { observationRows, byGranularity } = buildObservationRows(
      src([obs({ id: "o2", areaId: "a1", stage: "roughIn", taskId: "t1", source: "buhlos", requiresAction: true, assignedToId: "u1", linkedSnagId: "sn1", photoUrls: ["https://blob/a.jpg", 7, "https://blob/b.jpg"], dueDate: "2026-03-03" })]),
      ctx(),
    );
    expect(observationRows[0]).toMatchObject({
      task_id: "task-uuid", site_area_id: "area-uuid", stage: "roughIn", source: "buhlos",
      requires_action: true, assigned_to: "user-uuid", linked_snag_id: "snag-uuid",
      photo_urls: ["https://blob/a.jpg", "https://blob/b.jpg"], due_date: "2026-03-03",
    });
    expect(byGranularity.task).toBe(1);
  });

  it("QUARANTINES an office item (no jobId — job_id is NOT NULL)", () => {
    const { quarantine, observationRows } = buildObservationRows(src([obs({ id: "o3", jobId: null })]), ctx());
    expect(observationRows).toHaveLength(0);
    expect(quarantine[0]!.reason).toMatch(/office item/);
  });

  it("dangling linkedSnagId nulls (best-effort), does not quarantine", () => {
    const { observationRows, quarantine } = buildObservationRows(src([obs({ id: "o4", linkedSnagId: "ghost" })]), ctx());
    expect(quarantine).toHaveLength(0);
    expect(observationRows[0]!.linked_snag_id).toBeNull();
  });

  it("QUARANTINES unresolvable job/area/task and incomplete task coordinate", () => {
    expect(buildObservationRows(src([obs({ id: "o5", jobId: "ghost" })]), ctx()).quarantine[0]!.reason).toMatch(/not found in Postgres/);
    expect(buildObservationRows(src([obs({ id: "o6", areaId: "ghost" })]), ctx()).quarantine[0]!.reason).toMatch(/does not resolve to a site_area/);
    expect(buildObservationRows(src([obs({ id: "o7", areaId: "a1", taskId: "t1" })]), ctx()).quarantine[0]!.reason).toMatch(/without a full/);
    expect(buildObservationRows(src([obs({ id: "o8", areaId: "a1", stage: "fitOff", taskId: "nope" })]), ctx()).quarantine[0]!.reason).toMatch(/does not resolve to a task/);
  });

  it("QUARANTINES out-of-CHECK type/status/priority/source/stage/convertedTo", () => {
    expect(buildObservationRows(src([obs({ id: "a", type: "weird" })]), ctx()).quarantine[0]!.reason).toMatch(/type/);
    expect(buildObservationRows(src([obs({ id: "b", status: "weird" })]), ctx()).quarantine[0]!.reason).toMatch(/status/);
    expect(buildObservationRows(src([obs({ id: "c", priority: "huge" })]), ctx()).quarantine[0]!.reason).toMatch(/priority/);
    expect(buildObservationRows(src([obs({ id: "d", source: "admin" })]), ctx()).quarantine[0]!.reason).toMatch(/source/); // admin is NOT valid for observations
    expect(buildObservationRows(src([obs({ id: "e", stage: "commissioning" })]), ctx()).quarantine[0]!.reason).toMatch(/stage/);
    expect(buildObservationRows(src([obs({ id: "f", convertedTo: "nope" })]), ctx()).quarantine[0]!.reason).toMatch(/convertedTo/);
  });

  it("QUARANTINES missing/over-length title, over-length description/resolution, missing created_at, dupes", () => {
    expect(buildObservationRows(src([obs({ id: "g", title: " " })]), ctx()).quarantine[0]!.reason).toMatch(/title missing/);
    expect(buildObservationRows(src([obs({ id: "h", title: "x".repeat(141) })]), ctx()).quarantine[0]!.reason).toMatch(/title exceeds/);
    expect(buildObservationRows(src([obs({ id: "i", description: "x".repeat(2001) })]), ctx()).quarantine[0]!.reason).toMatch(/description exceeds/);
    expect(buildObservationRows(src([obs({ id: "j", resolutionNote: "x".repeat(1001) })]), ctx()).quarantine[0]!.reason).toMatch(/resolution_note exceeds/);
    expect(buildObservationRows(src([obs({ id: "k", createdAt: undefined })]), ctx()).quarantine[0]!.reason).toMatch(/created_at missing/);
    const dup = buildObservationRows(src([obs({ id: "x" }), obs({ id: "x" })]), ctx());
    expect(dup.observationRows).toHaveLength(1);
    expect(dup.quarantine[0]!.reason).toMatch(/duplicate/);
  });

  it("keeps insert/mutable column lists in lock-step", () => {
    const { observationRows } = buildObservationRows(src([obs({ id: "o9" })]), ctx());
    expect(new Set(OBSERVATION_INSERT_COLS)).toEqual(new Set(Object.keys(observationRows[0]!)));
    expect(OBSERVATION_MUTABLE_COLS).not.toContain("legacy_id");
    expect(OBSERVATION_MUTABLE_COLS).not.toContain("created_at");
    expect(OBSERVATION_MUTABLE_COLS).toContain("status");
  });
});
