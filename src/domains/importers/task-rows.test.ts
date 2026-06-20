import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * J3 task + event row builder (pure). FK resolution (override-aware templateScope),
 * fail-closed on any missing FK, and the import-baseline event shape. Expansion
 * itself lives in task-projection (one engine); this only maps instances → rows.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/task-rows.js");
const mod = requireFromHere(p) as {
  buildTaskRows: (instances: unknown[], ctx: unknown) => Array<Record<string, unknown>>;
  buildEventRows: (tenantId: string, inserted: Array<{ id: string; status: string }>, nowIso: string) => Array<Record<string, unknown>>;
  TASK_MUTABLE_COLS: string[];
  TASK_INSERT_COLS: string[];
  EVENT_INSERT_COLS: string[];
};
const { buildTaskRows, buildEventRows, TASK_MUTABLE_COLS, TASK_INSERT_COLS } = mod;

const NOW = "2026-06-20T00:00:00.000Z";
function ctx(over: Record<string, unknown> = {}) {
  return {
    tenantId: "T",
    jobMap: new Map([["j1", "job-uuid"]]),
    areaMap: new Map([["AL1", "area-uuid"]]),
    jobTemplateMap: new Map([["j1|roughIn|r1", "jobtpl-uuid"]]),
    areaTemplateMap: new Map([["AL1|fitOff|x1", "areatpl-uuid"]]),
    ...over,
  };
}
function inst(over: Record<string, unknown> = {}) {
  return { jobLegacy: "j1", areaLegacy: "AL1", stage: "roughIn", legacyTemplateId: "r1", name: "R1", status: "complete", sortOrder: 0, templateScope: "job", ...over };
}

describe("buildTaskRows", () => {
  it("resolves a job-level instance to a full task row (bare legacy_template_id; Supabase mints id)", () => {
    const row = buildTaskRows([inst()], ctx())[0]!;
    expect(row).toEqual({
      tenant_id: "T", job_id: "job-uuid", site_area_id: "area-uuid", task_template_id: "jobtpl-uuid",
      legacy_template_id: "r1", stage: "roughIn", name: "R1", status: "complete", sort_order: 0,
    });
    expect(row).not.toHaveProperty("id"); // Supabase mints tasks.id
  });

  it("resolves an area-override instance to the AREA-level template", () => {
    const row = buildTaskRows([inst({ stage: "fitOff", legacyTemplateId: "x1", templateScope: "area" })], ctx())[0]!;
    expect(row.task_template_id).toBe("areatpl-uuid");
  });

  it("fails closed on a missing job FK", () => {
    expect(() => buildTaskRows([inst({ jobLegacy: "ghost" })], ctx())).toThrow(/job ghost not found/);
  });
  it("fails closed on a missing site_area FK", () => {
    expect(() => buildTaskRows([inst({ areaLegacy: "ghost" })], ctx())).toThrow(/site_area ghost not found/);
  });
  it("fails closed on a missing template FK (never writes an orphan)", () => {
    expect(() => buildTaskRows([inst({ legacyTemplateId: "nope" })], ctx())).toThrow(/template not found/);
  });

  it("TASK_INSERT_COLS match the row keys (+tenant_id); deleted_at/created_at are NOT written (DB defaults)", () => {
    const row = buildTaskRows([inst()], ctx())[0]!;
    expect(new Set(TASK_INSERT_COLS)).toEqual(new Set(Object.keys(row)));
    expect(TASK_INSERT_COLS).not.toContain("deleted_at");
    expect(TASK_INSERT_COLS).not.toContain("created_at");
    // identity cols are not mutable; status/name/sort_order are
    expect(TASK_MUTABLE_COLS).not.toContain("legacy_template_id");
    expect(TASK_MUTABLE_COLS).toEqual(expect.arrayContaining(["status", "name", "sort_order"]));
  });
});

describe("buildEventRows", () => {
  it("builds one import-baseline event per inserted task (from null → imported status)", () => {
    const rows = buildEventRows("T", [{ id: "t1", status: "complete" }, { id: "t2", status: "not_started" }], NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      tenant_id: "T", task_id: "t1", from_status: null, to_status: "complete",
      source: "blob-migration", actor_label: "migration", created_at: NOW,
    });
    expect(rows[1]!.to_status).toBe("not_started");
  });
  it("produces no events when nothing was inserted (idempotent re-run)", () => {
    expect(buildEventRows("T", [], NOW)).toEqual([]);
  });
});
