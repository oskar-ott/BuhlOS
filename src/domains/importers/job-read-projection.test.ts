import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * J5 dark Postgres read projection. reconstructFromPg rebuilds the Blob/job shape
 * from the canonical PG graph (inverse of the importers): composite area/group
 * legacy_id → blob id, bare legacy_template_id → blob taskId, uuid FKs → legacy ids.
 * readJobsFromPgIfEnabled is dark (flag off → Blob authoritative) + best-effort.
 */

type Entry = { id: string; name: string; order: number; archived: boolean };
type Area = Entry & { spaceType: string | null; roughInTasks: Entry[]; fitOffTasks: Entry[] };
type Group = Entry & { areas: Area[] };
type Job = Record<string, unknown> & { areaGroups: Group[]; roughInTasks: Entry[]; fitOffTasks: Entry[] };
type JobData = { dwellings: Record<string, Record<string, { tasks: Record<string, string> }>>; evidence: Array<Record<string, unknown>>; snags: unknown[]; notes: unknown[] };

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/job-read-projection.js");
const { reconstructFromPg, readJobsFromPgIfEnabled } = requireFromHere(p) as {
  reconstructFromPg: (rows: unknown) => { jobs: { jobs: Job[] }; jobData: Record<string, JobData> };
  readJobsFromPgIfEnabled: (deps?: Record<string, unknown>) => Promise<{ pg: boolean; reason?: string; sources?: unknown }>;
};
const legacyIdPath = requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js");
const { compositeLegacyId } = requireFromHere(legacyIdPath) as { compositeLegacyId: (j: string, l: string) => string };

const AG = compositeLegacyId("j1", "g1");
const AA = compositeLegacyId("j1", "a1");

function rows() {
  return {
    jobs: [{ legacy_id: "j1", name: "Job 1", status: "active", ref: "R1", job_type_label: "new build", external_ref: "sm8", site_address: "1 St", site_contact_name: null, site_contact_phone: null, access_notes: null, parking_notes: null, safety_notes: null, induction_required: true, start_date: "2026-01-01", due_date: null, programmed_duration_days: 30, created_at: "2026-01-01 00:00:00+00" }],
    groups: [{ legacy_id: AG, job_legacy: "j1", name: "G1", sort_order: 0, archived: false }],
    areas: [{ legacy_id: AA, job_legacy: "j1", group_legacy: AG, name: "A1", space_type: "apt", sort_order: 1, archived: false }],
    templates: [
      { legacy_id: "rt1", job_legacy: "j1", area_legacy: null, stage: "roughIn", name: "Rough job", sort_order: 0, archived: false },
      { legacy_id: "rt_area", job_legacy: "j1", area_legacy: AA, stage: "roughIn", name: "Rough area", sort_order: 0, archived: false },
    ],
    tasks: [{ job_legacy: "j1", area_legacy: AA, stage: "roughIn", legacy_template_id: "rt_area", status: "complete" }],
    evidence: [{ legacy_id: "ev1", job_legacy: "j1", area_legacy: AA, task_legacy_template_id: null, kind: "note", photo_blob_id: null, blob_url: null, thumbnail_url: null, note: "hi", stage: null, captured_by_legacy: "u1", captured_by_label: "Tom", captured_at: "2026-01-01 00:00:00+00", client_captured_at: null, exif_lat: null, exif_lng: null, status: "submitted", source: "phil", reviewed_by_legacy: null, reviewed_by_label: null, reviewed_at: null, rejection_reason: null, created_at: "2026-01-01 00:00:00+00" }],
  };
}

describe("reconstructFromPg", () => {
  it("rebuilds the job header in Blob shape (reverses the importer field mapping)", () => {
    const job = reconstructFromPg(rows()).jobs.jobs[0]!;
    expect(job).toMatchObject({
      id: "j1", name: "Job 1", status: "active", ref: "R1", type: "new build",
      serviceM8JobId: "sm8", siteAddress: "1 St", inductionRequired: true,
      startDate: "2026-01-01", programmedDurationDays: 30,
    });
  });

  it("rebuilds nested areaGroups→areas with composite legacy ids decomposed to blob ids", () => {
    const job = reconstructFromPg(rows()).jobs.jobs[0]!;
    expect(job.areaGroups).toHaveLength(1);
    expect(job.areaGroups[0]!).toMatchObject({ id: "g1", name: "G1", order: 0, archived: false });
    expect(job.areaGroups[0]!.areas[0]!).toMatchObject({ id: "a1", name: "A1", spaceType: "apt", order: 1, archived: false });
  });

  it("places job-level templates on the job and area-override templates on the area", () => {
    const job = reconstructFromPg(rows()).jobs.jobs[0]!;
    expect(job.roughInTasks).toEqual([{ id: "rt1", name: "Rough job", order: 0, archived: false }]);
    expect(job.areaGroups[0]!.areas[0]!.roughInTasks).toEqual([{ id: "rt_area", name: "Rough area", order: 0, archived: false }]);
  });

  it("rebuilds dwellings (task status) and evidence keyed by blob ids", () => {
    const data = reconstructFromPg(rows()).jobData.j1!;
    expect(data.dwellings).toEqual({ a1: { roughIn: { tasks: { rt_area: "complete" } } } });
    expect(data.evidence[0]!).toMatchObject({ id: "ev1", kind: "note", note: "hi", areaId: "a1", taskId: null, capturedById: "u1", capturedByName: "Tom", status: "submitted", source: "phil" });
  });

  it("fails closed on an area with no resolvable group (no silent drop → Blob fallback)", () => {
    const r = rows();
    r.areas[0]!.group_legacy = null as unknown as string;
    expect(() => reconstructFromPg(r)).toThrow(/no resolvable group/);
  });

  it("maps archived (deleted_at) PG rows back to archived:true blob entries", () => {
    const r = rows();
    r.groups[0]!.archived = true;
    r.areas[0]!.archived = true;
    const job = reconstructFromPg(r).jobs.jobs[0]!;
    expect(job.areaGroups[0]!.archived).toBe(true);
    expect(job.areaGroups[0]!.areas[0]!.archived).toBe(true);
  });
});

describe("readJobsFromPgIfEnabled — dark + best-effort (Blob authoritative)", () => {
  const OLD = process.env.SUPABASE_DB_URL;
  afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });
  const throwDb = () => { throw new Error("getDb must not be called"); };

  it("short-circuits when no SUPABASE env (no flag/db read)", async () => {
    delete process.env.SUPABASE_DB_URL;
    expect(await readJobsFromPgIfEnabled({ getDb: throwDb, isFlagOn: async () => true })).toEqual({ pg: false, reason: "no supabase env" });
  });

  it("does nothing when the flag is off (no db touch) — Blob stays authoritative", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    expect(await readJobsFromPgIfEnabled({ getDb: throwDb, isFlagOn: async () => false })).toEqual({ pg: false, reason: "flag off" });
  });

  it("is best-effort: a db error returns pg:false (never throws into the caller)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const res = await readJobsFromPgIfEnabled({ getDb: () => { throw new Error("pooler down"); }, isFlagOn: async () => true });
    expect(res).toEqual({ pg: false, reason: "error" });
  });
});
