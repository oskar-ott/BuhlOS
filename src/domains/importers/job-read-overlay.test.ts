import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * J6 admin read cutover. The admin jobs read is served from the PG reconstruction
 * per job, gated on a byte-identical migrated-fields hash, on a Blob spine —
 * Blob-only fields are preserved, drift/new/error fall back to Blob, and the
 * served output is provably == Blob. These exercise the REAL overlay with
 * injected getDb/isFlagOn (no database).
 */
const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/job-read-projection.js");

type Diag = {
  readSource: "blob" | "postgres";
  reason: string;
  flagOn: boolean;
  reconstructed: boolean;
  parityMatch: boolean | null;
  pgFaithfulCount: number;
  driftedCount: number;
  onlyInBlobCount: number;
  onlyInPgCount: number;
  matchedCount: number;
  blobHash: string | null;
  pgHash: string | null;
  fallbackUsed: boolean;
  error: string | null;
};
type Job = Record<string, unknown> & { id: string };

const mod = requireFromHere(p) as {
  overlayAdminJobs: (blob: Job[], pg: Job[]) => {
    jobs: Job[]; pgFaithfulCount: number; driftedCount: number;
    onlyInBlobCount: number; onlyInPgCount: number; matchedCount: number;
    parityMatch: boolean; blobHash: string; pgHash: string; driftedIds: string[];
  };
  readAdminJobsWithPgOverlay: (input?: Record<string, unknown>) => Promise<{ jobs: Job[]; diag: Diag }>;
};
const { overlayAdminJobs, readAdminJobsWithPgOverlay } = mod;

// A migrated structural job as the PG reconstruction would produce it.
function pgJob(id: string, over: Partial<Job> = {}): Job {
  return {
    id, name: "Job " + id, status: "active", ref: "R-" + id, type: "new build",
    serviceM8JobId: "sm8", siteAddress: "1 St", siteContactName: null, siteContactPhone: null,
    accessNotes: null, parkingNotes: null, safetyNotes: null, inductionRequired: true,
    startDate: "2026-01-01", dueDate: null, programmedDurationDays: 30,
    areaGroups: [{ id: "g1", name: "G1", order: 0, archived: false, areas: [{ id: "a1", name: "A1", spaceType: "apt", order: 1, archived: false, roughInTasks: [], fitOffTasks: [] }] }],
    roughInTasks: [{ id: "rt1", name: "Rough", order: 0, archived: false }],
    fitOffTasks: [],
    ...over,
  };
}
// The same job as it lives in Blob: identical migrated fields + Blob-only fields.
function blobJob(id: string, over: Partial<Job> = {}): Job {
  return {
    ...pgJob(id),
    createdAt: "2026-01-01T00:00:00.000Z", // Blob string form (PG ::text differs — excluded from parity)
    modules: { areas: true, snags: true },
    customFields: [{ key: "permit", value: "X" }],
    scopeOfWork: [{ id: "sw_1", title: "DB-1", detail: "", order: 0 }],
    clientUserId: "u_client",
    ...over,
  };
}

describe("overlayAdminJobs — per-job parity-gated Blob-spine overlay", () => {
  it("serves a faithful job from PG while preserving Blob-only fields; output == Blob", () => {
    const blob = [blobJob("j1")];
    const pg = [pgJob("j1")];
    const r = overlayAdminJobs(blob, pg);
    expect(r.pgFaithfulCount).toBe(1);
    expect(r.driftedCount).toBe(0);
    expect(r.parityMatch).toBe(true);
    // Blob-only fields survive…
    expect(r.jobs[0]!.modules).toEqual({ areas: true, snags: true });
    expect(r.jobs[0]!.customFields).toEqual([{ key: "permit", value: "X" }]);
    expect(r.jobs[0]!.scopeOfWork).toEqual([{ id: "sw_1", title: "DB-1", detail: "", order: 0 }]);
    expect(r.jobs[0]!.clientUserId).toBe("u_client");
    // …and the served job is byte-identical to the Blob job (faithful guarantee).
    expect(r.jobs[0]!).toEqual(blob[0]);
    expect(r.blobHash).toBe(r.pgHash);
  });

  it("keeps a drifted job on Blob untouched (PG stale vs Blob)", () => {
    const blob = [blobJob("j1", { status: "complete" })]; // admin edited Blob since import
    const pg = [pgJob("j1", { status: "active" })]; // PG frozen at import
    const r = overlayAdminJobs(blob, pg);
    expect(r.pgFaithfulCount).toBe(0);
    expect(r.driftedCount).toBe(1);
    expect(r.driftedIds).toEqual(["j1"]);
    expect(r.parityMatch).toBe(false);
    expect(r.jobs[0]!.status).toBe("complete"); // Blob wins
    expect(r.jobs[0]!).toEqual(blob[0]);
    expect(r.blobHash).not.toBe(r.pgHash);
  });

  it("treats a job present only in Blob (new/draft) as Blob-authoritative", () => {
    const blob = [blobJob("j1"), blobJob("j2")];
    const pg = [pgJob("j1")];
    const r = overlayAdminJobs(blob, pg);
    expect(r.onlyInBlobCount).toBe(1);
    expect(r.matchedCount).toBe(1);
    expect(r.jobs.map((j) => j.id)).toEqual(["j1", "j2"]);
  });

  it("counts a job present only in PG (stale) but never serves it (Blob = existence)", () => {
    const blob = [blobJob("j1")];
    const pg = [pgJob("j1"), pgJob("jZ")];
    const r = overlayAdminJobs(blob, pg);
    expect(r.onlyInPgCount).toBe(1);
    expect(r.jobs.map((j) => j.id)).toEqual(["j1"]);
  });

  it("array reordering counts as drift (order-sensitive → Blob-identical output)", () => {
    const reordered = pgJob("j1", {
      areaGroups: [{ id: "g1", name: "G1", order: 0, archived: false, areas: [{ id: "a1", name: "A1", spaceType: "apt", order: 1, archived: false, fitOffTasks: [], roughInTasks: [] }] }],
    });
    const blob = [blobJob("j1", { roughInTasks: [{ id: "rt1", name: "Rough", order: 0, archived: false }, { id: "rt2", name: "Second", order: 1, archived: false }] })];
    const pg = [pgJob("j1", { ...reordered, roughInTasks: [{ id: "rt2", name: "Second", order: 1, archived: false }, { id: "rt1", name: "Rough", order: 0, archived: false }] })];
    const r = overlayAdminJobs(blob, pg);
    expect(r.driftedCount).toBe(1); // same set, different order → drift
  });

  it("ignores object key order (key-order-normalised → no false drift)", () => {
    const blob = [blobJob("j1")];
    // Same values, different key insertion order.
    const reordered: Job = { status: "active", id: "j1", ref: "R-j1", name: "Job j1" } as Job;
    const pg = [pgJob("j1", reordered)];
    const r = overlayAdminJobs(blob, pg);
    expect(r.pgFaithfulCount).toBe(1);
  });
});

describe("readAdminJobsWithPgOverlay — dark gating + automatic Blob fallback", () => {
  const OLD = process.env.SUPABASE_DB_URL;
  afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });
  const throwDb = () => { throw new Error("getDb must not be called"); };

  it("no Supabase env → Blob, no flag/db read", async () => {
    delete process.env.SUPABASE_DB_URL;
    const blob = [blobJob("j1")];
    const r = await readAdminJobsWithPgOverlay({ blobJobs: blob, getDb: throwDb, isFlagOn: async () => true });
    expect(r.jobs).toBe(blob);
    expect(r.diag.readSource).toBe("blob");
    expect(r.diag.reason).toBe("no supabase env");
    expect(r.diag.fallbackUsed).toBe(false);
  });

  it("flag off → Blob, db never touched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const blob = [blobJob("j1")];
    const r = await readAdminJobsWithPgOverlay({ blobJobs: blob, getDb: throwDb, isFlagOn: async () => false });
    expect(r.jobs).toBe(blob);
    expect(r.diag.reason).toBe("flag off");
    expect(r.diag.fallbackUsed).toBe(false);
  });

  it("flag on but PG throws → full Blob fallback, never throws into caller", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const blob = [blobJob("j1")];
    const r = await readAdminJobsWithPgOverlay({
      blobJobs: blob, isFlagOn: async () => true,
      getDb: () => { throw new Error("pooler down"); },
    });
    expect(r.jobs).toBe(blob);
    expect(r.diag.readSource).toBe("blob");
    expect(r.diag.reason).toBe("error");
    expect(r.diag.fallbackUsed).toBe(true);
    expect(r.diag.error).toMatch(/pooler down/);
  });

  it("flag on + faithful PG → serves from Postgres (output == Blob)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    // Build the Blob jobs FROM the PG reconstruction so the migrated fields match.
    const rows = pgRows();
    const reconstructed = (requireFromHere(p) as { reconstructFromPg: (r: unknown) => { jobs: { jobs: Job[] } } })
      .reconstructFromPg(rows).jobs.jobs;
    const blob = reconstructed.map((j) => ({ ...j, modules: { areas: true }, customFields: [] }));
    const fakeDb = () => fakeSql(rows);
    const r = await readAdminJobsWithPgOverlay({ blobJobs: blob, isFlagOn: async () => true, getDb: fakeDb });
    expect(r.diag.readSource).toBe("postgres");
    expect(r.diag.reconstructed).toBe(true);
    expect(r.diag.parityMatch).toBe(true);
    expect(r.diag.pgFaithfulCount).toBe(1);
    expect(r.jobs[0]!.modules).toEqual({ areas: true }); // Blob-only field preserved
    expect(r.jobs).toEqual(blob); // byte-identical output
  });

  it("flag on but no tenant → Blob fallback (fallbackUsed)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const blob = [blobJob("j1")];
    const noTenant = () => (() => Promise.resolve([])); // every query empty → tenant lookup empty
    const r = await readAdminJobsWithPgOverlay({ blobJobs: blob, isFlagOn: async () => true, getDb: noTenant });
    expect(r.jobs).toBe(blob);
    expect(r.diag.reason).toBe("no tenant");
    expect(r.diag.fallbackUsed).toBe(true);
  });
});

// ── helpers: a fake postgres.js tagged-template client over fixed row sets ──
function pgRows() {
  const { compositeLegacyId } = requireFromHere(
    requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js"),
  ) as { compositeLegacyId: (j: string, l: string) => string };
  const AG = compositeLegacyId("j1", "g1");
  const AA = compositeLegacyId("j1", "a1");
  return {
    jobs: [{ legacy_id: "j1", name: "Job 1", status: "active", ref: "R1", job_type_label: "new build", external_ref: "sm8", site_address: "1 St", site_contact_name: null, site_contact_phone: null, access_notes: null, parking_notes: null, safety_notes: null, induction_required: true, start_date: "2026-01-01", due_date: null, programmed_duration_days: 30, created_at: "2026-01-01 00:00:00+00" }],
    groups: [{ legacy_id: AG, job_legacy: "j1", name: "G1", sort_order: 0, archived: false }],
    areas: [{ legacy_id: AA, job_legacy: "j1", group_legacy: AG, name: "A1", space_type: "apt", sort_order: 1, archived: false }],
    templates: [{ legacy_id: "rt_area", job_legacy: "j1", area_legacy: AA, stage: "roughIn", name: "Rough area", sort_order: 0, archived: false }],
    tasks: [{ job_legacy: "j1", area_legacy: AA, stage: "roughIn", legacy_template_id: "rt_area", status: "complete" }],
    evidence: [],
  };
}

function fakeSql(data: ReturnType<typeof pgRows>) {
  return (strings: TemplateStringsArray) => {
    const q = strings.join(" ");
    if (q.includes("from public.tenants")) return Promise.resolve([{ id: "t1" }]);
    if (q.includes("from public.jobs where")) return Promise.resolve(data.jobs);
    if (q.includes("from public.site_area_groups")) return Promise.resolve(data.groups);
    if (q.includes("from public.site_areas a")) return Promise.resolve(data.areas);
    if (q.includes("from public.job_task_templates")) return Promise.resolve(data.templates);
    if (q.includes("from public.tasks t")) return Promise.resolve(data.tasks);
    if (q.includes("from public.evidence_files")) return Promise.resolve(data.evidence);
    return Promise.resolve([]);
  };
}
