import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Material-requests row builder (#152, pure). One blob request → one header row +
 * one item row. Re-keys via the shared proof-projection; resolves
 * linked_observation_id best-effort; fails closed on out-of-CHECK header values AND
 * an invalid/missing line item.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/materials-rows.js");
const mod = requireFromHere(p) as {
  buildMaterialRequestRows: (sources: unknown, ctx: unknown) => {
    requestRows: Array<Record<string, unknown>>;
    itemsByLegacy: Array<{ legacyId: string; rows: Array<Record<string, unknown>>; canonical: string }>;
    quarantine: Array<{ table: string; id: string; reason: string }>;
    byGranularity: { task: number; area: number; job: number };
  };
  canonicaliseItems: (rows: Array<Record<string, unknown>>) => string;
  REQUEST_INSERT_COLS: string[];
  REQUEST_MUTABLE_COLS: string[];
  ITEM_INSERT_COLS: string[];
};
const { buildMaterialRequestRows, canonicaliseItems, REQUEST_INSERT_COLS, REQUEST_MUTABLE_COLS, ITEM_INSERT_COLS } = mod;

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
    obsMap: new Map([["ob1", "obs-uuid"]]),
  };
}
function src(requests: unknown[]) {
  return { materials: { requests } };
}
const base = { jobId: "j1", item: "25mm conduit", quantity: 50, unit: "m", status: "requested", urgency: "normal", source: "buhlos", createdAt: "2026-01-01T00:00:00.000Z" };
const mr = (over: Record<string, unknown> = {}) => ({ id: "m", ...base, ...over });

describe("buildMaterialRequestRows — header + item", () => {
  it("job-level request: header + one item row; obs link nulled when absent", () => {
    const { requestRows, itemsByLegacy, quarantine, byGranularity } = buildMaterialRequestRows(src([mr({ id: "m1" })]), ctx());
    expect(quarantine).toHaveLength(0);
    expect(requestRows[0]).toMatchObject({ legacy_id: "m1", status: "requested", urgency: "normal", source: "buhlos", job_id: "job-uuid", site_area_id: null, task_id: null, linked_observation_id: null });
    expect(itemsByLegacy[0]).toMatchObject({ legacyId: "m1" });
    expect(itemsByLegacy[0]!.rows[0]).toEqual({ item: "25mm conduit", quantity: 50, unit: "m", note: null, sort_order: 0 });
    expect(byGranularity).toEqual({ task: 0, area: 0, job: 1 });
  });

  it("task-level request: full coordinate resolves; obs link + requester resolved; requested_at defaults to created_at", () => {
    const { requestRows } = buildMaterialRequestRows(
      src([mr({ id: "m2", areaId: "a1", stage: "roughIn", taskId: "t1", linkedObservationId: "ob1", requestedById: "u1" })]),
      ctx(),
    );
    expect(requestRows[0]).toMatchObject({ task_id: "task-uuid", site_area_id: "area-uuid", stage: "roughIn", linked_observation_id: "obs-uuid", requested_by: "user-uuid", requested_at: "2026-01-01T00:00:00.000Z", created_by: "user-uuid" });
  });

  it("dangling linkedObservationId nulls (best-effort), does not quarantine", () => {
    const { requestRows, quarantine } = buildMaterialRequestRows(src([mr({ id: "m3", linkedObservationId: "ghost" })]), ctx());
    expect(quarantine).toHaveLength(0);
    expect(requestRows[0]!.linked_observation_id).toBeNull();
  });

  it("QUARANTINES no jobId, unresolvable job/area/task, incomplete task coordinate", () => {
    expect(buildMaterialRequestRows(src([mr({ id: "m4", jobId: null })]), ctx()).quarantine[0]!.reason).toMatch(/no jobId/);
    expect(buildMaterialRequestRows(src([mr({ id: "m5", jobId: "ghost" })]), ctx()).quarantine[0]!.reason).toMatch(/not found in Postgres/);
    expect(buildMaterialRequestRows(src([mr({ id: "m6", areaId: "ghost" })]), ctx()).quarantine[0]!.reason).toMatch(/does not resolve to a site_area/);
    expect(buildMaterialRequestRows(src([mr({ id: "m7", areaId: "a1", taskId: "t1" })]), ctx()).quarantine[0]!.reason).toMatch(/without a full/);
  });

  it("QUARANTINES out-of-CHECK status/urgency/source/stage", () => {
    expect(buildMaterialRequestRows(src([mr({ id: "a", status: "weird" })]), ctx()).quarantine[0]!.reason).toMatch(/status/);
    expect(buildMaterialRequestRows(src([mr({ id: "b", urgency: "huge" })]), ctx()).quarantine[0]!.reason).toMatch(/urgency/);
    expect(buildMaterialRequestRows(src([mr({ id: "c", source: "phil" })]), ctx()).quarantine[0]!.reason).toMatch(/source/); // phil NOT valid for materials
    expect(buildMaterialRequestRows(src([mr({ id: "d", stage: "commissioning" })]), ctx()).quarantine[0]!.reason).toMatch(/stage/);
  });

  it("QUARANTINES an invalid/missing line item (item required; quantity in (0,10M]; unit required)", () => {
    expect(buildMaterialRequestRows(src([mr({ id: "e", item: "  " })]), ctx()).quarantine[0]!.reason).toMatch(/item missing/);
    expect(buildMaterialRequestRows(src([mr({ id: "f", item: "x".repeat(201) })]), ctx()).quarantine[0]!.reason).toMatch(/item exceeds/);
    expect(buildMaterialRequestRows(src([mr({ id: "g", quantity: 0 })]), ctx()).quarantine[0]!.reason).toMatch(/quantity/);
    expect(buildMaterialRequestRows(src([mr({ id: "h", quantity: 20000000 })]), ctx()).quarantine[0]!.reason).toMatch(/quantity/);
    expect(buildMaterialRequestRows(src([mr({ id: "i", unit: "" })]), ctx()).quarantine[0]!.reason).toMatch(/unit missing/);
    expect(buildMaterialRequestRows(src([mr({ id: "j", unit: "x".repeat(25) })]), ctx()).quarantine[0]!.reason).toMatch(/unit exceeds/);
  });

  it("QUARANTINES missing created_at/requestedAt and duplicates", () => {
    expect(buildMaterialRequestRows(src([mr({ id: "k", createdAt: undefined, requestedAt: undefined })]), ctx()).quarantine[0]!.reason).toMatch(/created_at\/requestedAt missing/);
    const dup = buildMaterialRequestRows(src([mr({ id: "x" }), mr({ id: "x" })]), ctx());
    expect(dup.requestRows).toHaveLength(1);
    expect(dup.quarantine[0]!.reason).toMatch(/duplicate/);
  });

  it("canonicaliseItems is stable across quantity number/string forms; column lists in lock-step", () => {
    expect(canonicaliseItems([{ item: "x", quantity: 50, unit: "m", note: null, sort_order: 0 }]))
      .toBe(canonicaliseItems([{ item: "x", quantity: "50.000", unit: "m", note: null, sort_order: 0 }]));
    const { requestRows } = buildMaterialRequestRows(src([mr({ id: "m8" })]), ctx());
    expect(new Set(REQUEST_INSERT_COLS)).toEqual(new Set(Object.keys(requestRows[0]!)));
    expect(REQUEST_MUTABLE_COLS).not.toContain("legacy_id");
    expect(REQUEST_MUTABLE_COLS).not.toContain("created_at");
    expect(ITEM_INSERT_COLS).toEqual(["tenant_id", "material_request_id", "item", "quantity", "unit", "note", "sort_order"]);
  });
});
