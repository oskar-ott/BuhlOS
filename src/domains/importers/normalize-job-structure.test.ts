import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * J8.75 legacy structure normalizer. Canonicalises a blob job's representation
 * (order + sparse defaults + "" → null) to the PG-reconstruction shape so the
 * read overlays serve it from PG — WITHOUT changing data. Three guards keep it
 * safe (byte-faithful · data unchanged · no field dropped). The canonical pgRecon
 * jobs here are produced by the REAL reconstruction, so the test exercises the
 * true canonical shape.
 */
const requireFromHere = createRequire(import.meta.url);
type Job = Record<string, unknown> & { id: string; areaGroups: unknown[] };

const proj = requireFromHere(requireFromHere.resolve("../../../api/_lib/job-read-projection.js")) as {
  reconstructFromPg: (rows: unknown) => { jobs: { jobs: Job[] } };
  migratedFieldsHash: (job: unknown) => string;
};
const { normalizeJobStructure } = requireFromHere(requireFromHere.resolve("../../../scripts/importers/lib/normalize-job-structure.js")) as {
  normalizeJobStructure: (blob: Job, pg: Job | undefined) => { job: Job; normalized: boolean; reason: string };
};
const { compositeLegacyId } = requireFromHere(requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js")) as { compositeLegacyId: (j: string, l: string) => string };

const AG = compositeLegacyId("j1", "g1");
const AA = compositeLegacyId("j1", "a1");
// PG row shape → reconstructFromPg gives the canonical blob job. Two job-level
// templates (out of order by id) prove the canonical sort; an area-override too.
function reconJob(): Job {
  const rows = {
    jobs: [{ legacy_id: "j1", name: "Job 1", status: "active", ref: null, job_type_label: null, external_ref: null, site_address: null, site_contact_name: null, site_contact_phone: null, access_notes: null, parking_notes: null, safety_notes: null, induction_required: false, start_date: null, due_date: null, programmed_duration_days: null, created_at: "2026-01-01 00:00:00+00" }],
    groups: [{ legacy_id: AG, job_legacy: "j1", name: "G1", sort_order: 0, archived: false }],
    areas: [{ legacy_id: AA, job_legacy: "j1", group_legacy: AG, name: "A1", space_type: null, sort_order: 0, archived: false }],
    templates: [
      { legacy_id: "rt_b", job_legacy: "j1", area_legacy: null, stage: "roughIn", name: "Bee", sort_order: 0, archived: false },
      { legacy_id: "rt_a", job_legacy: "j1", area_legacy: null, stage: "roughIn", name: "Ay", sort_order: 0, archived: false },
      { legacy_id: "at1", job_legacy: "j1", area_legacy: AA, stage: "roughIn", name: "Area tpl", sort_order: 0, archived: false },
    ],
    tasks: [], evidence: [],
  };
  return proj.reconstructFromPg(rows).jobs.jobs[0]!;
}

describe("normalizeJobStructure", () => {
  it("already faithful (blob == canonical, + blob-only fields) → no change", () => {
    const pg = reconJob();
    const blob = { ...pg, modules: { areas: true } } as Job;
    const r = normalizeJobStructure(blob, pg);
    expect(r.normalized).toBe(false);
    expect(r.reason).toBe("already faithful");
    expect(r.job).toBe(blob);
  });

  it("sparse + unordered + \"\"→null blob → normalized, byte-faithful, Blob-only fields kept", () => {
    const pg = reconJob();
    // A legacy-shaped blob: same data, missing defaults, arrays out of order, "" headers, + modules.
    const blob = {
      id: "j1", name: "Job 1", status: "active", inductionRequired: false, // real jobs carry this
      ref: "", siteAddress: "", accessNotes: "", // "" → null
      areaGroups: [{ id: "g1", name: "G1", areas: [{ id: "a1", name: "A1", roughInTasks: [{ id: "at1", name: "Area tpl" }] }] }],
      roughInTasks: [{ id: "rt_b", name: "Bee" }, { id: "rt_a", name: "Ay" }], // reverse of canonical (rt_a, rt_b)
      fitOffTasks: [],
      modules: { areas: true }, customFields: [{ k: "v" }], // blob-only, must survive
    } as unknown as Job;
    const r = normalizeJobStructure(blob, pg);
    expect(r.normalized).toBe(true);
    // Byte-faithful → the read overlay will serve it from PG.
    expect(proj.migratedFieldsHash(r.job)).toBe(proj.migratedFieldsHash(pg));
    // Blob-only fields preserved.
    expect(r.job.modules).toEqual({ areas: true });
    expect(r.job.customFields).toEqual([{ k: "v" }]);
    // "" headers became null.
    expect(r.job.ref).toBeNull();
    // Canonical structure adopted (order + defaults).
    expect(r.job.areaGroups).toEqual(pg.areaGroups);
  });

  it("skips a job carrying nested blob-only fields (would be dropped) — data safety", () => {
    const pg = reconJob();
    const blob = {
      id: "j1", name: "Job 1", status: "active",
      areaGroups: [{ id: "g1", name: "G1", areas: [{ id: "a1", name: "A1", customFields: [{ k: "keep me" }] }] }],
      roughInTasks: [{ id: "rt_a", name: "Ay" }, { id: "rt_b", name: "Bee" }], fitOffTasks: [],
    } as unknown as Job;
    const r = normalizeJobStructure(blob, pg);
    expect(r.normalized).toBe(false);
    expect(r.reason).toMatch(/would drop blob-only fields.*area\.customFields/);
    expect(r.job).toBe(blob); // untouched
  });

  it("skips a job whose migrated DATA genuinely differs from PG (not representational)", () => {
    const pg = reconJob();
    const blob = {
      id: "j1", name: "Job 1", status: "active",
      areaGroups: [{ id: "g1", name: "RENAMED GROUP", areas: [{ id: "a1", name: "A1" }] }], // real value diff
      roughInTasks: [{ id: "rt_a", name: "Ay" }, { id: "rt_b", name: "Bee" }], fitOffTasks: [],
    } as unknown as Job;
    const r = normalizeJobStructure(blob, pg);
    expect(r.normalized).toBe(false);
    expect(r.reason).toMatch(/migrated data differs/);
    expect(r.job).toBe(blob);
  });

  it("skips when there is no PG reconstruction for the job", () => {
    const r = normalizeJobStructure(reconJob(), undefined);
    expect(r.normalized).toBe(false);
    expect(r.reason).toMatch(/no pg reconstruction/);
  });
});
