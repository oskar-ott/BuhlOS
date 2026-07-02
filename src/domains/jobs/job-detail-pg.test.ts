import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the ADMIN single-job PG direct read (api/_lib/job-detail-pg.js):
 *  - buildAdminExtrasRecord splits the job into the PG-owned migrated fields
 *    (hash only) and the Blob-only remainder (money, customFields, modules, …),
 *    preserving the top-level key order.
 *  - mergeAdminJobDetail reproduces the Blob job byte-identically (top-level)
 *    when PG is faithful.
 *  - readAdminJobDetailFromPg is DOUBLE-gated (extras freshness against
 *    jobs.json's uploadedAt + PG migrated-fields hash parity), never reads the
 *    jobs.json monolith, falls back (job:null) on every miss/error, and never
 *    throws.
 *  - persistAdminExtras only stamps a confirmed uploadedAt and never throws.
 *  - money redaction downstream is unchanged: the merged job redacts exactly
 *    like the Blob job.
 */
const requireFromHere = createRequire(import.meta.url);
const mod = requireFromHere("../../../api/_lib/job-detail-pg.js");
const { migratedFieldsHash, MIGRATED_JOB_FIELDS } = requireFromHere(
  "../../../api/_lib/job-read-projection.js"
);
const { redactJobForViewer } = requireFromHere("../../../api/_lib/job-redaction.js");

type Job = Record<string, unknown>;
type ExtrasRecord = { keyOrder: string[]; extras: Record<string, unknown>; migratedHash: string };
type ReadDiag = {
  source: string; reason: string; flagOn: boolean; parityPass: boolean | null;
  uploadedAt: string | null; rebuildExtras: boolean; latencyMs: number;
  fallbackUsed: boolean; error: string | null;
};
const {
  FLAG_KEY,
  adminExtrasKey,
  buildAdminExtrasRecord,
  mergeAdminJobDetail,
  readAdminJobDetailFromPg,
  persistAdminExtras,
  probeAdminJobDetailParity,
} = mod as {
  FLAG_KEY: string;
  adminExtrasKey: (jobId: string) => string;
  buildAdminExtrasRecord: (job: Job) => ExtrasRecord;
  mergeAdminJobDetail: (record: ExtrasRecord, pgJob: Job) => Job;
  readAdminJobDetailFromPg: (jobId: string, deps?: Record<string, unknown>) => Promise<{ job: Job | null; diag: ReadDiag }>;
  persistAdminExtras: (jobId: string, job: Job, uploadedAt: string, deps?: Record<string, unknown>) => Promise<{ persisted: boolean }>;
  probeAdminJobDetailParity: (deps?: Record<string, unknown>) => Promise<{
    wired: boolean; jobsTotal: number; jobsSampled: number; faithful: number;
    byteEqual: number; drifted: number; mergeDrift: number; unavailable: number;
    errored: number; latencyMs: number; error: string | null;
  }>;
};

// A representative Blob job: migrated scalars + structure, plus every category
// of Blob-only field PG does not store (money, modules, customFields,
// scopeOfWork, clientUserId, createdAt, an unknown future field).
function blobJob() {
  return {
    id: "job-1",
    name: "Tower A",
    status: "active",
    ref: "JOB-001",
    type: "t_resi",
    serviceM8JobId: null,
    siteAddress: "1 Smith St",
    siteContactName: "Sam",
    siteContactPhone: "0400",
    accessNotes: null,
    parkingNotes: null,
    safetyNotes: null,
    inductionRequired: false,
    startDate: "2026-06-01",
    dueDate: "2026-08-01",
    programmedDurationDays: 42,
    createdAt: "2026-05-30T01:02:03.000Z",
    clientUserId: "u_client",
    modules: { plans: true },
    customFields: [{ id: "cf1", label: "Lockbox", value: "1234" }],
    scopeOfWork: [{ id: "sw1", title: "DB-1", detail: "", order: 0 }],
    contractValue: 120000,
    labourEstimate: 40000,
    materialEstimate: 20000,
    claimedToDate: 50000,
    paidToDate: 30000,
    oldestClaimDays: 12,
    clientReference: "PO-1",
    contractNotes: "Net 30",
    futureUnknownField: { nested: true },
    areaGroups: [
      {
        id: "g1",
        name: "Ground",
        order: 0,
        archived: false,
        areas: [
          {
            id: "a1",
            name: "Unit 1",
            spaceType: "unit",
            order: 0,
            archived: false,
            roughInTasks: [],
            fitOffTasks: [],
          },
        ],
      },
    ],
    roughInTasks: [{ id: "t1", name: "Rough in power", order: 0, archived: false }],
    fitOffTasks: [],
  };
}

// The PG reconstruction of the same job — exactly the migrated fields (what
// loadOneJobStructureFromPg/reconstructFromPg produce), values equal to Blob.
function pgJobFor(job: Job) {
  const pg: Record<string, unknown> = {};
  for (const f of MIGRATED_JOB_FIELDS as string[]) {
    pg[f] = job[f] === undefined ? null : JSON.parse(JSON.stringify(job[f]));
  }
  pg.id = job.id;
  pg.createdAt = "2026-05-30T01:02:03+00:00"; // PG ::text form differs — deliberately NOT migrated
  return pg;
}

// A tagged-template fake `sql` that routes on the query text.
function fakeSql(routes: Array<{ match: string; rows: unknown[] }>) {
  const calls: string[] = [];
  const sql = async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    calls.push(text);
    for (const r of routes) {
      if (text.includes(r.match)) return r.rows;
    }
    return [];
  };
  return { sql, calls };
}

function pgRoutesFor(job: Job): Array<{ match: string; rows: unknown[] }> {
  return [
    { match: "from public.tenants", rows: [{ id: "tenant-1" }] },
    {
      match: "from public.jobs",
      rows: [
        {
          legacy_id: job.id, name: job.name, status: job.status, ref: job.ref,
          job_type_label: job.type, external_ref: job.serviceM8JobId,
          site_address: job.siteAddress, site_contact_name: job.siteContactName,
          site_contact_phone: job.siteContactPhone, access_notes: job.accessNotes,
          parking_notes: job.parkingNotes, safety_notes: job.safetyNotes,
          induction_required: job.inductionRequired, start_date: job.startDate,
          due_date: job.dueDate, programmed_duration_days: job.programmedDurationDays,
          created_at: "2026-05-30T01:02:03+00:00",
        },
      ],
    },
    {
      match: "from public.site_area_groups",
      rows: [
        {
          legacy_id: JSON.stringify([job.id, "g1"]), job_legacy: job.id,
          name: "Ground", sort_order: 0, archived: false,
        },
      ],
    },
    {
      match: "from public.site_areas",
      rows: [
        {
          legacy_id: JSON.stringify([job.id, "a1"]), job_legacy: job.id,
          group_legacy: JSON.stringify([job.id, "g1"]), name: "Unit 1",
          space_type: "unit", sort_order: 0, archived: false,
        },
      ],
    },
    {
      match: "from public.job_task_templates",
      rows: [
        {
          legacy_id: "t1", job_legacy: job.id, area_legacy: null,
          stage: "roughIn", name: "Rough in power", sort_order: 0, archived: false,
        },
      ],
    },
  ];
}

function freshDeps(over: Record<string, unknown> = {}) {
  const job = blobJob();
  const record = buildAdminExtrasRecord(job);
  const stored = { builtFromUploadedAt: "2026-07-01T00:00:00.000Z", record };
  const { sql, calls } = fakeSql(pgRoutesFor(job));
  const readBlob = vi.fn(async (key: string, fallback: unknown) => {
    if (key === adminExtrasKey(job.id)) return JSON.parse(JSON.stringify(stored));
    if (key === "jobs.json") throw new Error("fast path must never read the monolith");
    return fallback;
  });
  return {
    job,
    stored,
    sqlCalls: calls,
    deps: {
      readBlob,
      writeBlob: vi.fn(async () => undefined),
      blobUploadedAt: vi.fn(async () => "2026-07-01T00:00:00.000Z"),
      getDb: () => sql,
      isFlagOn: vi.fn(async (k: string) => k === FLAG_KEY),
      now: () => 0,
      ...over,
    },
  };
}

beforeEach(() => {
  process.env.SUPABASE_DB_URL = "postgres://test";
});
afterEach(() => {
  delete process.env.SUPABASE_DB_URL;
  vi.restoreAllMocks();
});

describe("buildAdminExtrasRecord", () => {
  it("puts every non-migrated field (money, modules, customFields, unknown) into extras and NONE of the migrated ones", () => {
    const job = blobJob();
    const rec = buildAdminExtrasRecord(job);
    for (const k of ["contractValue", "claimedToDate", "clientReference", "contractNotes", "modules", "customFields", "scopeOfWork", "clientUserId", "createdAt", "futureUnknownField", "id"]) {
      expect(rec.extras).toHaveProperty(k);
    }
    for (const k of MIGRATED_JOB_FIELDS as string[]) {
      expect(rec.extras).not.toHaveProperty(k);
    }
    expect(rec.keyOrder).toEqual(Object.keys(job));
    expect(rec.migratedHash).toBe(migratedFieldsHash(job));
  });
});

describe("mergeAdminJobDetail", () => {
  it("reproduces the Blob job byte-identically when PG is faithful (key set, order and values)", () => {
    const job = blobJob();
    const rec = buildAdminExtrasRecord(job);
    const merged = mergeAdminJobDetail(rec, pgJobFor(job));
    expect(JSON.stringify(merged)).toBe(JSON.stringify(job));
  });

  it("takes the structure from PG (load-bearing), not from the extras", () => {
    const job = blobJob();
    const rec = buildAdminExtrasRecord(job);
    const pg = pgJobFor(job);
    pg.areaGroups = [{ marker: "from-pg" }];
    const merged = mergeAdminJobDetail(rec, pg);
    expect(merged.areaGroups).toEqual([{ marker: "from-pg" }]);
  });

  it("keeps a Blob key the PG row lacks, as null (hash already proved canonical equality)", () => {
    const job = blobJob();
    const rec = buildAdminExtrasRecord(job);
    const pg = pgJobFor(job);
    delete pg.accessNotes;
    const merged = mergeAdminJobDetail(rec, pg);
    expect(Object.keys(merged)).toEqual(Object.keys(job));
    expect(merged.accessNotes).toBeNull();
  });
});

describe("readAdminJobDetailFromPg — gates and fallbacks", () => {
  it("serves the merged job from PG when extras are fresh and the hash matches — WITHOUT reading jobs.json", async () => {
    const { job, deps } = freshDeps();
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(diag.source).toBe("postgres");
    expect(diag.parityPass).toBe(true);
    expect(JSON.stringify(served)).toBe(JSON.stringify(job));
  });

  it("returns null when the flag is off", async () => {
    const { job, deps } = freshDeps({ isFlagOn: vi.fn(async () => false) });
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(served).toBeNull();
    expect(diag.reason).toBe("flag off");
    expect(diag.flagOn).toBe(false);
  });

  it("returns null without SUPABASE_DB_URL", async () => {
    delete process.env.SUPABASE_DB_URL;
    const { job, deps } = freshDeps();
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(served).toBeNull();
    expect(diag.reason).toBe("no supabase env");
  });

  it("falls back when the source uploadedAt can't be confirmed (and does NOT ask for a rebuild)", async () => {
    const { job, deps } = freshDeps({ blobUploadedAt: vi.fn(async () => null) });
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(served).toBeNull();
    expect(diag.reason).toBe("no uploadedAt");
    expect(diag.rebuildExtras).toBe(false);
  });

  it("falls back on missing extras and asks the full read to rebuild them", async () => {
    const { job, deps } = freshDeps({
      readBlob: vi.fn(async () => null),
    });
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(served).toBeNull();
    expect(diag.reason).toBe("extras miss");
    expect(diag.rebuildExtras).toBe(true);
    expect(diag.uploadedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("falls back on STALE extras (any jobs.json write invalidates) and asks for a rebuild", async () => {
    const { job, deps } = freshDeps({
      blobUploadedAt: vi.fn(async () => "2026-07-02T09:00:00.000Z"), // a write landed
    });
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(served).toBeNull();
    expect(diag.reason).toBe("extras stale");
    expect(diag.rebuildExtras).toBe(true);
  });

  it("falls back when the job is absent from PG (not yet mirrored)", async () => {
    const { job, deps, ...rest } = freshDeps();
    const { sql } = fakeSql([{ match: "from public.tenants", rows: [{ id: "tenant-1" }] }]);
    void rest;
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, {
      ...deps,
      getDb: () => sql,
    });
    expect(served).toBeNull();
    expect(diag.reason).toBe("job not in pg");
    expect(diag.fallbackUsed).toBe(true);
  });

  it("falls back when PG structure drifted from the Blob structure (lagging mirror can never serve stale)", async () => {
    const { job, deps } = freshDeps();
    const routes = pgRoutesFor(job);
    const jobsRoute = routes.find((r) => r.match === "from public.jobs")!;
    jobsRoute.rows = [{ ...(jobsRoute.rows[0] as Record<string, unknown>), name: "OLD NAME" }] as unknown[];
    const { sql } = fakeSql(routes);
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, { ...deps, getDb: () => sql });
    expect(served).toBeNull();
    expect(diag.parityPass).toBe(false);
    expect(diag.fallbackUsed).toBe(true);
  });

  it("never throws — a PG connection error degrades to a Blob fallback", async () => {
    const { job, deps } = freshDeps({
      getDb: () => {
        throw new Error("pooler down");
      },
    });
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(served).toBeNull();
    expect(diag.reason).toBe("error");
    expect(diag.error).toContain("pooler down");
  });

  it("rejects a malformed stored extras record (shape validation) and rebuilds", async () => {
    const { job, deps } = freshDeps({
      readBlob: vi.fn(async () => ({ builtFromUploadedAt: "2026-07-01T00:00:00.000Z", record: { extras: {} } })),
    });
    const { job: served, diag } = await readAdminJobDetailFromPg(job.id, deps);
    expect(served).toBeNull();
    expect(diag.reason).toBe("extras miss");
    expect(diag.rebuildExtras).toBe(true);
  });
});

describe("money redaction parity", () => {
  it("the merged job redacts exactly like the Blob job for every role", async () => {
    const { job, deps } = freshDeps();
    const { job: served } = await readAdminJobDetailFromPg(job.id, deps);
    for (const role of ["admin", "office", "lh", "electrician", "client"]) {
      expect(JSON.stringify(redactJobForViewer(served, role))).toBe(
        JSON.stringify(redactJobForViewer(job, role))
      );
    }
    // and the extras record DOES carry money (PG cannot) — the reason the
    // path is admin-gated at the call site.
    const rec = buildAdminExtrasRecord(job);
    expect(rec.extras.contractValue).toBe(120000);
  });
});

describe("persistAdminExtras", () => {
  it("writes the freshness-stamped record under the per-job key", async () => {
    const job = blobJob();
    const writeBlob = vi.fn(async () => undefined);
    const out = await persistAdminExtras(job.id, job, "2026-07-01T00:00:00.000Z", { writeBlob });
    expect(out.persisted).toBe(true);
    expect(writeBlob).toHaveBeenCalledWith(adminExtrasKey(job.id), {
      builtFromUploadedAt: "2026-07-01T00:00:00.000Z",
      record: buildAdminExtrasRecord(job),
    });
  });

  it("refuses to stamp an unconfirmed uploadedAt and never throws on a write failure", async () => {
    const job = blobJob();
    const writeBlob = vi.fn(async () => {
      throw new Error("blob write down");
    });
    expect((await persistAdminExtras(job.id, job, null as unknown as string, { writeBlob })).persisted).toBe(false);
    expect(writeBlob).not.toHaveBeenCalled();
    expect((await persistAdminExtras(job.id, job, "2026-07-01T00:00:00.000Z", { writeBlob })).persisted).toBe(false);
  });
});

describe("probeAdminJobDetailParity", () => {
  it("classifies faithful / drifted / unavailable across a sample and proves byte equality", async () => {
    const faithful = blobJob();
    const drifted = { ...blobJob(), id: "job-2", name: "Drifted" };
    const missing = { ...blobJob(), id: "job-3" };
    const routes = [
      { match: "from public.tenants", rows: [{ id: "tenant-1" }] },
    ];
    const { sql, calls } = fakeSql(routes);
    // Per-job routing: route on the bound jobId value instead (fake keeps it
    // simple — respond via a stateful map keyed on call order is brittle, so
    // give each job its own sql).
    void sql;
    void calls;
    const perJob: Record<string, ReturnType<typeof fakeSql>> = {
      "job-1": fakeSql(pgRoutesFor(faithful)),
      "job-2": fakeSql([
        { match: "from public.tenants", rows: [{ id: "tenant-1" }] },
        ...pgRoutesFor({ ...drifted, name: "OLD NAME" }).filter((r) => r.match !== "from public.tenants"),
      ]),
      "job-3": fakeSql([{ match: "from public.tenants", rows: [{ id: "tenant-1" }] }]),
    };
    let currentJob = "";
    const routingSql = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("from public.tenants")) return [{ id: "tenant-1" }];
      // every structure query binds the jobId — sniff it from the values
      const bound = vals.find((v) => typeof v === "string" && String(v).startsWith("job-"));
      if (typeof bound === "string") currentJob = bound;
      const target = perJob[currentJob];
      return target ? target.sql(strings) : [];
    };
    const readBlob = vi.fn(async (key: string, fallback: unknown) =>
      key === "jobs.json" ? { jobs: [faithful, drifted, missing] } : fallback
    );
    const probe = await probeAdminJobDetailParity({
      readBlob,
      getDb: () => routingSql,
      now: () => 0,
    });
    expect(probe.jobsTotal).toBe(3);
    expect(probe.jobsSampled).toBe(3);
    expect(probe.faithful).toBe(1);
    expect(probe.byteEqual).toBe(1);
    expect(probe.drifted).toBe(1);
    expect(probe.unavailable).toBe(1);
    expect(probe.mergeDrift).toBe(0);
    expect(probe.errored).toBe(0);
  });

  it("reports not wired without SUPABASE_DB_URL", async () => {
    delete process.env.SUPABASE_DB_URL;
    const probe = await probeAdminJobDetailParity({ now: () => 0 });
    expect(probe.wired).toBe(false);
  });
});
