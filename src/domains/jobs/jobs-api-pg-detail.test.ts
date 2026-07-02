import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Handler-level tests for the ADMIN single-job PG DIRECT read in api/jobs.js
 * (flag `supabase_read_job_detail`, engine api/_lib/job-detail-pg.js):
 *  - the fast path serves the single-job GET WITHOUT reading the jobs.json
 *    monolith, byte-identical to the full-read response (incl. money for
 *    admin);
 *  - stale/missing extras → the full read serves AND rebuilds the extras, so
 *    the NEXT read takes the fast path;
 *  - any PG failure → full-read fallback, response unchanged;
 *  - field/LH/clients never engage the PG path (admin-tier call-site gate).
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");
const supabaseDbPath = requireFromHere.resolve("../../../api/_lib/supabase-db.js");

let blob: Map<string, unknown>;
let readBlobMock: ReturnType<typeof vi.fn>;
let writeBlobMock: ReturnType<typeof vi.fn>;
let sqlImpl: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call({
  method,
  userId,
  role,
  query = {},
}: {
  method: string;
  userId: string;
  role: string;
  query?: Record<string, string>;
}) {
  const res = createRes();
  await handler({ method, query, headers: { cookie: cookieFor(userId, role) } }, res);
  return res;
}

// The job under test: migrated structure + every Blob-only category (money,
// modules, customFields, scopeOfWork, clientUserId, createdAt).
function jobFixture() {
  return {
    id: "job-pg",
    name: "PG Tower",
    status: "active",
    ref: "JOB-PG",
    type: "t_resi",
    serviceM8JobId: null,
    siteAddress: "1 Smith St",
    siteContactName: null,
    siteContactPhone: null,
    accessNotes: null,
    parkingNotes: null,
    safetyNotes: null,
    inductionRequired: false,
    startDate: "2026-06-01",
    dueDate: null,
    programmedDurationDays: null,
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

// PG rows that reconstruct jobFixture()'s migrated fields exactly.
function faithfulSql(job: ReturnType<typeof jobFixture>) {
  return async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("from public.tenants")) return [{ id: "tenant-1" }];
    if (text.includes("from public.jobs")) {
      return [
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
      ];
    }
    if (text.includes("from public.site_area_groups")) {
      return [
        {
          legacy_id: JSON.stringify([job.id, "g1"]), job_legacy: job.id,
          name: "Ground", sort_order: 0, archived: false,
        },
      ];
    }
    if (text.includes("from public.site_areas")) {
      return [
        {
          legacy_id: JSON.stringify([job.id, "a1"]), job_legacy: job.id,
          group_legacy: JSON.stringify([job.id, "g1"]), name: "Unit 1",
          space_type: "unit", sort_order: 0, archived: false,
        },
      ];
    }
    if (text.includes("from public.job_task_templates")) {
      return [
        {
          legacy_id: "t1", job_legacy: job.id, area_legacy: null,
          stage: "roughIn", name: "Rough in power", sort_order: 0, archived: false,
        },
      ];
    }
    return [];
  };
}

function monolithReads(): number {
  return readBlobMock.mock.calls.filter((c: unknown[]) => c[0] === "jobs.json").length;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.SUPABASE_DB_URL = "postgres://test";
  process.env.FLAG_SUPABASE_READ_JOB_DETAIL = "1";

  const job = jobFixture();
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
          { id: "u_office", username: "office", role: "office", assignedJobIds: [] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-pg"] },
          { id: "u_client", username: "builder", role: "client", assignedJobIds: [] },
        ],
      },
    ],
    ["jobs.json", clone({ jobs: [job] })], // cloned — the sql fake keeps its own reference
  ]);
  sqlImpl = faithfulSql(job);

  for (const p of [
    authPath,
    jobsPath,
    "../../../api/_lib/job-redaction.js",
    "../../../api/_lib/feature-flags.js",
    "../../../api/_lib/jobs-summary.js",
    "../../../api/_lib/job-detail-projection.js",
    "../../../api/_lib/job-detail-pg.js",
    "../../../api/_lib/admin-job-detail-read-diagnostics.js",
    "../../../api/_lib/job-audit.js",
    "../../../api/_lib/audit-log.js",
  ]) {
    delete requireFromHere.cache[requireFromHere.resolve(p)];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: (readBlobMock = vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      )),
      writeBlob: (writeBlobMock = vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      })),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
      blobUploadedAt: vi.fn(async () => "T1"),
    },
  } as NodeJS.Module;
  requireFromHere.cache[supabaseDbPath] = {
    id: supabaseDbPath,
    filename: supabaseDbPath,
    loaded: true,
    exports: {
      getDb: vi.fn(() => (strings: TemplateStringsArray, ...vals: unknown[]) => sqlImpl(strings, ...vals)),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(jobsPath);
});

afterEach(() => {
  delete process.env.SUPABASE_DB_URL;
  delete process.env.FLAG_SUPABASE_READ_JOB_DETAIL;
  delete requireFromHere.cache[supabaseDbPath];
  delete requireFromHere.cache[blobPath];
  vi.restoreAllMocks();
});

function seedFreshExtras() {
  const requireHere = requireFromHere("../../../api/_lib/job-detail-pg.js");
  const record = requireHere.buildAdminExtrasRecord(jobFixture());
  blob.set("jobs/job-pg/admin-extras.json", { builtFromUploadedAt: "T1", record });
}

describe("admin single-job PG direct read (supabase_read_job_detail)", () => {
  it("serves the admin GET from PG + extras WITHOUT reading the jobs.json monolith, byte-identical to the full read", async () => {
    seedFreshExtras();
    const fast = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-pg" } });
    expect(fast.statusCode).toBe(200);
    expect(monolithReads()).toBe(0); // THE point: the monolith was never read

    // Now the reference response: flag off → the authoritative full read.
    process.env.FLAG_SUPABASE_READ_JOB_DETAIL = "0";
    const full = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-pg" } });
    expect(full.statusCode).toBe(200);
    expect(monolithReads()).toBeGreaterThan(0);
    expect(JSON.stringify(fast.body)).toBe(JSON.stringify(full.body));

    // Money reached the admin on the fast path (extras carry it; redaction is
    // a no-op for admin, exactly like the Blob path).
    const served = (fast.body as { job: Record<string, unknown> }).job;
    expect(served.contractValue).toBe(120000);
    expect(served.clientReference).toBe("PO-1");
  });

  it("?withStats=1 rides the fast path with the SAME per-job stats enrichment", async () => {
    seedFreshExtras();
    const res = await call({
      method: "GET", userId: "u_admin", role: "admin",
      query: { id: "job-pg", withStats: "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(monolithReads()).toBe(0);
    const job = (res.body as { job: Record<string, unknown> }).job;
    expect(job.statsCrewCount).toBe(1); // u_field is assigned
    expect(job.statsAreaCount).toBe(1);
    expect(job.statsOpenSnags).toBe(0);
  });

  it("stale extras → the full read serves AND rebuilds them; the NEXT read skips the monolith", async () => {
    const record = requireFromHere("../../../api/_lib/job-detail-pg.js").buildAdminExtrasRecord(jobFixture());
    blob.set("jobs/job-pg/admin-extras.json", { builtFromUploadedAt: "T0-old", record });

    const first = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-pg" } });
    expect(first.statusCode).toBe(200);
    expect(monolithReads()).toBe(1); // fell back to the authoritative read
    expect(writeBlobMock).toHaveBeenCalledWith(
      "jobs/job-pg/admin-extras.json",
      expect.objectContaining({ builtFromUploadedAt: "T1" })
    );

    const second = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-pg" } });
    expect(second.statusCode).toBe(200);
    expect(monolithReads()).toBe(1); // unchanged — the second read took the PG fast path
    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });

  it("missing extras behave the same (rebuild on the fallback read)", async () => {
    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-pg" } });
    expect(res.statusCode).toBe(200);
    expect(monolithReads()).toBe(1);
    expect(blob.has("jobs/job-pg/admin-extras.json")).toBe(true);
  });

  it("PG failure → full-read fallback, response unchanged", async () => {
    seedFreshExtras();
    sqlImpl = async () => {
      throw new Error("pooler down");
    };
    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-pg" } });
    expect(res.statusCode).toBe(200);
    expect(monolithReads()).toBe(1);
    expect((res.body as { job: { id: string } }).job.id).toBe("job-pg");
  });

  it("PG structure drift (lagging mirror) → full-read fallback, never stale", async () => {
    // Blob + extras hold the current job; PG lags with a stale name (a failed
    // best-effort mirror). The hash gate must refuse PG and serve Blob.
    seedFreshExtras();
    sqlImpl = faithfulSql({ ...jobFixture(), name: "STALE PG NAME" });

    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-pg" } });
    expect(res.statusCode).toBe(200);
    expect(monolithReads()).toBe(1); // hash mismatch → authoritative read
    expect((res.body as { job: { name: string } }).job.name).toBe("PG Tower"); // never the stale PG name
  });

  it("field/LH/client viewers never engage the PG path (admin-tier call-site gate)", async () => {
    seedFreshExtras();
    const getDb = (requireFromHere.cache[supabaseDbPath] as NodeJS.Module).exports.getDb as ReturnType<typeof vi.fn>;

    const field = await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-pg" } });
    expect(field.statusCode).toBe(200);
    const fieldJob = (field.body as { job: Record<string, unknown> }).job;
    expect(fieldJob.contractValue).toBeUndefined(); // money never reaches the field
    expect(fieldJob.scopeOfWork).toBeUndefined();

    const client = await call({ method: "GET", userId: "u_client", role: "client", query: { id: "job-pg" } });
    expect(client.statusCode).toBe(200);

    expect(getDb).not.toHaveBeenCalled(); // PG never touched for non-admin viewers
  });
});
