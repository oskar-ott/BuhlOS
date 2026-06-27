import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/jobs.js. These exercise the real serverless
 * handler with signed sessions and an in-memory Vercel Blob replacement.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");

let blob: Map<string, unknown>;
let writeBlobMock: ReturnType<typeof vi.fn>;
let uploadedAtMock: ReturnType<typeof vi.fn>;
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
  return `buhl_session=${auth.signSession({
    userId,
    role,
    exp: Date.now() + 60_000,
  })}`;
}

async function call({
  method,
  userId,
  role,
  query = {},
  body,
}: {
  method: string;
  userId: string;
  role: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const res = createRes();
  await handler(
    {
      method,
      query,
      body,
      headers: { cookie: cookieFor(userId, role) },
    },
    res
  );
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
          {
            id: "u_field",
            username: "sparky",
            role: "electrician",
            assignedJobIds: ["job-active", "job-draft", "job-archived"],
          },
          {
            id: "u_office",
            username: "office",
            role: "office",
            assignedJobIds: [],
          },
          { id: "u_client", username: "builder", role: "client", assignedJobIds: [] },
          {
            id: "u_lh",
            username: "lead",
            role: "lh",
            assignedJobIds: ["job-active"],
          },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          {
            id: "job-active",
            name: "Active",
            status: "active",
            clientUserId: "u_client",
            contractValue: 120000,
            labourEstimate: 40000,
            materialEstimate: 30000,
            claimedToDate: 50000,
            paidToDate: 45000,
            oldestClaimDays: 12,
            scopeOfWork: [
              { id: "sw_1", title: "Supply and install DB-1", detail: "Incl. testing", order: 0 },
            ],
            areaGroups: [
              {
                id: "group-a",
                name: "Group A",
                areas: [
                  { id: "area-current", name: "Current area" },
                  { id: "area-archived", name: "Archived area", archived: true },
                ],
              },
            ],
          },
          { id: "job-draft", name: "Draft", status: "draft" },
          { id: "job-archived", name: "Archived", status: "archived" },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[jobsPath];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-redaction.js")];
  delete requireFromHere.cache[auditPath];
  // The jobs-summary fast path reads flags + the summary through the injected
  // blob mock; re-require feature-flags so its top-level readBlob binding picks
  // up the mock (jobs-summary lazy-requires blob, so it needs no busting).
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/feature-flags.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/jobs-summary.js")];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-detail-projection.js")];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: (writeBlobMock = vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      })),
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
      // Freshness probe for the jobs-summary path: a fixed source uploadedAt so a
      // rebuilt summary stamps + validates deterministically in tests.
      blobUploadedAt: (uploadedAtMock = vi.fn(async () => "T1")),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(jobsPath);
});

describe("GET /api/jobs field visibility", () => {
  it("returns active jobs but hides draft and archived jobs from field lists", async () => {
    const res = await call({ method: "GET", userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { jobs: Array<{ id: string }> }).jobs.map((job) => job.id)).toEqual([
      "job-active",
    ]);
  });

  it("returns 404 for field reads of draft or archived jobs", async () => {
    for (const id of ["job-draft", "job-archived"]) {
      const res = await call({
        method: "GET",
        userId: "u_field",
        role: "electrician",
        query: { id },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("GET /api/jobs?id=…&withStats=1 — single-job hub stats truthfulness", () => {
  it("omits stats* on a plain single-job GET (unchanged behaviour)", async () => {
    const res = await call({
      method: "GET",
      userId: "u_admin",
      role: "admin",
      query: { id: "job-active" },
    });
    expect(res.statusCode).toBe(200);
    const job = (res.body as { job: Record<string, unknown> }).job;
    expect(job.id).toBe("job-active");
    expect(job.statsCrewCount).toBeUndefined();
    expect(job.statsAreaCount).toBeUndefined();
    expect(job.statsItpsActive).toBeUndefined();
  });

  it("enriches the single-job GET with real stats* when ?withStats=1 (no fabricated 'all clear')", async () => {
    // Real per-job data so the counts are non-trivial (and would all read as
    // undefined under the pre-fix single-job path that returned before stats).
    blob.set("jobs/job-active/data.json", {
      dwellings: {},
      snags: [],
      evidence: [{ id: "e1", status: "submitted" }],
      snagsV2: [{ id: "s1", status: "open" }],
    });
    blob.set("jobs/job-active/itps.json", {
      instances: [{ id: "i1", status: "witnessed" }],
    });

    const res = await call({
      method: "GET",
      userId: "u_admin",
      role: "admin",
      query: { id: "job-active", withStats: "1" },
    });
    expect(res.statusCode).toBe(200);
    const job = (res.body as { job: Record<string, number> }).job;
    // stats* are now PRESENT on the single-job GET (they used to be undefined,
    // collapsing the hub Status/attention card into a fabricated "all clear").
    expect(job.statsCrewCount).toBe(2); // u_field + u_lh assigned to job-active
    expect(job.statsAreaCount).toBe(1); // the archived area is stripped from the projection
    expect(job.statsEvidenceV2Pending).toBe(1);
    expect(job.statsSnagsV2Active).toBe(1);
    expect(job.statsItpsActive).toBe(1);
    expect(job.statsItpsNeedsReview).toBe(1);
  });
});

describe("money-field redaction (#382)", () => {
  const MONEY = [
    "contractValue",
    "labourEstimate",
    "materialEstimate",
    "claimedToDate",
    "paidToDate",
    "oldestClaimDays",
  ] as const;

  it.each([
    ["electrician (field)", "u_field", "electrician"],
    ["leading hand", "u_lh", "lh"],
    ["client (own job)", "u_client", "client"],
  ])("%s sees NO money fields on single or list GET", async (_label, userId, role) => {
    const single = await call({ method: "GET", userId, role, query: { id: "job-active" } });
    expect(single.statusCode).toBe(200);
    const job = (single.body as { job: Record<string, unknown> }).job;
    for (const f of MONEY) expect(job, f).not.toHaveProperty(f);

    const listRes = await call({ method: "GET", userId, role });
    const rows = (listRes.body as { jobs: Record<string, unknown>[] }).jobs;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) for (const f of MONEY) expect(row, f).not.toHaveProperty(f);
  });

  it("withStats list rows are redacted the same way", async () => {
    const res = await call({
      method: "GET",
      userId: "u_field",
      role: "electrician",
      query: { withStats: "1" },
    });
    const rows = (res.body as { jobs: Record<string, unknown>[] }).jobs;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) for (const f of MONEY) expect(row, f).not.toHaveProperty(f);
  });

  it("admin TIER responses keep every figure untouched", async () => {
    for (const [userId, role] of [
      ["u_admin", "admin"],
      ["u_office", "office"],
    ] as const) {
      const single = await call({ method: "GET", userId, role, query: { id: "job-active" } });
      const job = (single.body as { job: Record<string, unknown> }).job;
      expect(job).toMatchObject({
        contractValue: 120000,
        labourEstimate: 40000,
        materialEstimate: 30000,
        claimedToDate: 50000,
        paidToDate: 45000,
        oldestClaimDays: 12,
      });
    }
  });
});

describe("scope-of-work visibility + writes (#200)", () => {
  it("field and client GETs never carry scopeOfWork (single, list, withStats)", async () => {
    for (const [userId, role] of [
      ["u_field", "electrician"],
      ["u_client", "client"],
    ] as const) {
      const single = await call({ method: "GET", userId, role, query: { id: "job-active" } });
      expect((single.body as { job: Record<string, unknown> }).job).not.toHaveProperty("scopeOfWork");
      const list = await call({ method: "GET", userId, role });
      for (const row of (list.body as { jobs: Record<string, unknown>[] }).jobs) {
        expect(row).not.toHaveProperty("scopeOfWork");
      }
      const stats = await call({ method: "GET", userId, role, query: { withStats: "1" } });
      for (const row of (stats.body as { jobs: Record<string, unknown>[] }).jobs) {
        expect(row).not.toHaveProperty("scopeOfWork");
      }
    }
  });

  it("a leading hand READS scope (audience adminAndLH) but cannot WRITE it", async () => {
    const single = await call({
      method: "GET",
      userId: "u_lh",
      role: "lh",
      query: { id: "job-active" },
    });
    const job = (single.body as { job: { scopeOfWork: unknown[] } }).job;
    expect(job.scopeOfWork).toHaveLength(1);
    // ...but the LH still never sees money fields.
    expect(job).not.toHaveProperty("contractValue");

    const put = await call({
      method: "PUT",
      userId: "u_lh",
      role: "lh",
      body: { id: "job-active", scopeOfWork: [{ title: "Sneaky edit" }] },
    });
    expect(put.statusCode).toBe(403);
  });

  it("admin PUT round-trips with server ids + normalised order; empty array clears", async () => {
    const put = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: {
        id: "job-active",
        scopeOfWork: [
          { title: "Second item", detail: "" },
          { id: "sw_1", title: "Supply and install DB-1", detail: "Incl. testing" },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const stored = (blob.get("jobs.json") as { jobs: Array<{ id: string; scopeOfWork: Array<Record<string, unknown>> }> })
      .jobs.find((j) => j.id === "job-active")!.scopeOfWork;
    expect(stored).toHaveLength(2);
    expect(stored.map((i) => i.order)).toEqual([0, 1]); // normalised
    expect(stored[1]!.id).toBe("sw_1"); // existing id preserved
    expect(String(stored[0]!.id)).toMatch(/^sw_/); // server-assigned

    const clear = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "job-active", scopeOfWork: [] },
    });
    expect(clear.statusCode).toBe(200);
    const cleared = (blob.get("jobs.json") as { jobs: Array<{ id: string; scopeOfWork: unknown[] }> })
      .jobs.find((j) => j.id === "job-active")!.scopeOfWork;
    expect(cleared).toEqual([]);
  });

  it("PUT rejects a same-name remap that collapses into duplicate live area ids (no write)", async () => {
    // job-active already has a live area "Current area" (id area-current). Two
    // input areas BOTH named "Current area" carry distinct submitted ids, so
    // validateAreaGroups passes — but the name-based remap reuses area-current
    // for both, collapsing them onto one live id. The persisted-output guard
    // must reject this before writeBlob.
    const writesBefore = writeBlobMock.mock.calls.length;
    const put = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: {
        id: "job-active",
        areaGroups: [
          {
            id: "group-a",
            name: "Group A",
            areas: [
              { id: "ar_new1", name: "Current area" },
              { id: "ar_new2", name: "Current area" },
            ],
          },
        ],
      },
    });
    expect(put.statusCode).toBe(400);
    expect((put.body as { error: string }).error).toContain("duplicate");
    expect((put.body as { error: string }).error).toContain("area-current");
    // No jobs.json write happened for this rejected PUT.
    expect(writeBlobMock.mock.calls.length).toBe(writesBefore);
    // And the stored job still has exactly one live area-current.
    const stored = (blob.get("jobs.json") as {
      jobs: Array<{ id: string; areaGroups?: Array<{ areas?: Array<{ id: string; archived?: boolean }> }> }>;
    }).jobs.find((j) => j.id === "job-active");
    const liveCurrent = (stored?.areaGroups ?? [])
      .flatMap((g) => g.areas ?? [])
      .filter((a) => a.id === "area-current" && !a.archived);
    expect(liveCurrent).toHaveLength(1);
  });

  it("PUT accepts a valid areaGroups update that remaps without a collision", async () => {
    const put = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: {
        id: "job-active",
        areaGroups: [
          {
            id: "group-a",
            name: "Group A",
            areas: [
              { id: "area-current", name: "Current area" },
              { id: "ar_new", name: "New room" },
            ],
          },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const stored = (blob.get("jobs.json") as {
      jobs: Array<{ id: string; areaGroups: Array<{ areas: Array<{ id: string; name: string }> }> }>;
    }).jobs.find((j) => j.id === "job-active")!;
    const ids = stored.areaGroups.flatMap((g) => g.areas).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(ids).toContain("area-current");
    expect(stored.areaGroups[0]!.areas.map((a) => a.name)).toContain("New room");
  });

  // #578 — the PUT remap must not lose server-owned structural metadata or
  // delete archived entries the payload can't carry. Server is the retention
  // authority (the client structureFrozen guard is not relied on).
  const areasOf = (gi = 0) =>
    (
      blob.get("jobs.json") as {
        jobs: Array<{
          id: string;
          areaGroups: Array<{
            areas: Array<{ id: string; name: string; archived?: boolean; order?: number; customFields?: unknown }>;
          }>;
        }>;
      }
    ).jobs.find((j) => j.id === "job-active")!.areaGroups[gi]!.areas;

  it("#578: retains an archived area the payload omits (not deleted)", async () => {
    const put = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: {
        id: "job-active",
        // omits area-archived entirely (what the builder/direct PUT does)
        areaGroups: [{ id: "group-a", name: "Group A", areas: [{ id: "area-current", name: "Current area" }] }],
      },
    });
    expect(put.statusCode).toBe(200);
    const archived = areasOf().find((a) => a.id === "area-archived");
    expect(archived).toBeTruthy();
    expect(archived!.archived).toBe(true);
    expect(archived!.name).toBe("Archived area");
  });

  it("#578: preserves order + customFields on a matched active area when the payload omits them", async () => {
    // seed metadata
    await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: {
        id: "job-active",
        areaGroups: [
          {
            id: "group-a",
            name: "Group A",
            areas: [
              { id: "area-current", name: "Current area", order: 5, customFields: [{ key: "floor", label: "Floor", value: "L3" }] },
              { id: "area-archived", name: "Archived area", archived: true },
            ],
          },
        ],
      },
    });
    // edit again WITHOUT order/customFields (a builder round-trip drops them)
    await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "job-active", areaGroups: [{ id: "group-a", name: "Group A", areas: [{ id: "area-current", name: "Current area" }] }] },
    });
    const cur = areasOf().find((a) => a.name === "Current area")!;
    expect(cur.order).toBe(5);
    expect(cur.customFields).toEqual([{ key: "floor", label: "Floor", value: "L3", type: "text" }]);
    expect(areasOf().some((a) => a.name === "Archived area" && a.archived)).toBe(true);
  });

  it("#578: still deletes an ACTIVE area the payload omits (only archived is retained)", async () => {
    const put = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: {
        id: "job-active",
        // omits BOTH area-current (active) and area-archived (archived)
        areaGroups: [{ id: "group-a", name: "Group A", areas: [{ id: "ar_new", name: "Brand new" }] }],
      },
    });
    expect(put.statusCode).toBe(200);
    const names = areasOf().map((a) => a.name);
    expect(names).not.toContain("Current area"); // active omitted → deleted (legit edit)
    expect(names).toContain("Archived area"); // archived omitted → retained
    expect(names).toContain("Brand new");
  });

  it("validation: missing title and oversized detail are hard 400s", async () => {
    const noTitle = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "job-active", scopeOfWork: [{ title: "" }] },
    });
    expect(noTitle.statusCode).toBe(400);
    const huge = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "job-active", scopeOfWork: [{ title: "ok", detail: "x".repeat(2001) }] },
    });
    expect(huge.statusCode).toBe(400);
    expect((huge.body as { error: string }).error).toContain("2000");
  });
});

describe("POST and PUT /api/jobs", () => {
  it("creates an office-only draft, updates it, publishes it, and parks it as draft", async () => {
    const created = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "SMOKE_TEST_api_job", status: "draft" },
    });
    expect(created.statusCode).toBe(200);
    expect((created.body as { job: { status: string } }).job.status).toBe("draft");

    const updated = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "smoke-test-api-job", siteAddress: "1 Test Rd" },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.body as { job: { siteAddress: string } }).job.siteAddress).toBe("1 Test Rd");

    for (const status of ["active", "draft"] as const) {
      const res = await call({
        method: "PUT",
        userId: "u_admin",
        role: "admin",
        body: { id: "smoke-test-api-job", status },
      });
      expect(res.statusCode).toBe(200);
      expect((res.body as { job: { status: string } }).job.status).toBe(status);
    }
  });

  it("blocks field users from mutating builder data", async () => {
    const res = await call({
      method: "PUT",
      userId: "u_field",
      role: "electrician",
      body: { id: "job-active", name: "Not allowed" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PUT status validation (#383)", () => {
  it("rejects an out-of-enum status with 400 — 'paused' can never come back", async () => {
    const res = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "job-active", status: "paused" },
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain("status must be one of");
  });

  it("accepts every canonical status", async () => {
    for (const status of ["active", "complete", "archived", "on_hold", "draft"]) {
      const res = await call({
        method: "PUT",
        userId: "u_admin",
        role: "admin",
        body: { id: "job-active", status },
      });
      expect(res.statusCode, status).toBe(200);
    }
  });
});

describe("role normalisation — admin tier + LH aliases", () => {
  it("unassigned admin-tier (office) can open and list draft/archived jobs", async () => {
    // Regression for the literal `role === 'admin'` single-GET gate: the admin
    // TIER can edit a draft via PUT (canManageJob) and must be able to open it.
    for (const id of ["job-draft", "job-archived"]) {
      const res = await call({ method: "GET", userId: "u_office", role: "office", query: { id } });
      expect(res.statusCode).toBe(200);
      expect((res.body as { job: { id: string } }).job.id).toBe(id);
    }
    const list = await call({ method: "GET", userId: "u_office", role: "office" });
    expect(list.statusCode).toBe(200);
    expect((list.body as { jobs: Array<{ id: string }> }).jobs.map((job) => job.id)).toEqual([
      "job-active",
      "job-draft",
      "job-archived",
    ]);
  });

  it("field users still 404 on draft/archived single GET (no widening)", async () => {
    for (const id of ["job-draft", "job-archived"]) {
      const res = await call({ method: "GET", userId: "u_field", role: "electrician", query: { id } });
      expect(res.statusCode).toBe(404);
    }
  });

  it("an LH alias ('lh') is held to the money/module edit restriction", async () => {
    const res = await call({
      method: "PUT",
      userId: "u_lh",
      role: "lh",
      body: { id: "job-active", contractValue: 5 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("an LH alias can still edit field-safe basics (e.g. site address)", async () => {
    const res = await call({
      method: "PUT",
      userId: "u_lh",
      role: "lh",
      body: { id: "job-active", siteAddress: "7 Cable St" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { job: { siteAddress: string } }).job.siteAddress).toBe("7 Cable St");
  });

  it("only office-tier callers can opt into archived structural data", async () => {
    const field = await call({
      method: "GET",
      userId: "u_field",
      role: "electrician",
      query: { id: "job-active", includeArchived: "1" },
    });
    expect(field.statusCode).toBe(200);
    expect(
      (field.body as { job: { areaGroups: Array<{ areas: Array<{ id: string }> }> } }).job
        .areaGroups[0]!.areas.map((area) => area.id)
    ).toEqual(["area-current"]);

    const office = await call({
      method: "GET",
      userId: "u_office",
      role: "office",
      query: { id: "job-active", includeArchived: "1" },
    });
    expect(office.statusCode).toBe(200);
    expect(
      (office.body as { job: { areaGroups: Array<{ areas: Array<{ id: string }> }> } }).job
        .areaGroups[0]!.areas.map((area) => area.id)
    ).toEqual(["area-current", "area-archived"]);
  });
});

describe("DELETE /api/jobs — QA test-job cleanup", () => {
  // Re-seed jobs.json with the test-data shapes this branch guards:
  // a parked smoke job (deletable), the allowed Active fixture (refused —
  // active), and a real draft (refused — not test data). Done per-test on
  // top of beforeEach so the shared fixture other suites assert against
  // stays untouched.
  function seedTestJobs() {
    blob.set("jobs.json", {
      jobs: [
        { id: "job-real-draft", name: "Real Client Fitout", status: "draft" },
        { id: "smoke-test-1-job-b", name: "SMOKE_TEST_1_Job_Builder", status: "draft" },
        { id: "smoke-test-2-job-b", name: "SMOKE_TEST_2_Job_Builder", status: "draft" },
        { id: "qa-seed-field-active-job", name: "QA_SEED_FIELD_ACTIVE_JOB", status: "active" },
      ],
    });
    blob.set("jobs/smoke-test-1-job-b/data.json", { dwellings: {}, snags: [], notes: [] });
    blob.set("jobs/smoke-test-1-job-b/audit.json", { entries: [] });
    blob.set("jobs/smoke-test-2-job-b/data.json", { dwellings: {}, snags: [], notes: [] });
  }

  function jobsIds(): string[] {
    return (blob.get("jobs.json") as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id);
  }

  it("is admin-only — field and office-tier callers get 403", async () => {
    seedTestJobs();
    for (const caller of [
      { userId: "u_field", role: "electrician" },
      { userId: "u_office", role: "office" },
      { userId: "u_lh", role: "lh" },
    ]) {
      const res = await call({
        method: "DELETE",
        ...caller,
        query: { id: "smoke-test-1-job-b" },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(jobsIds()).toContain("smoke-test-1-job-b");
  });

  it("404s on an unknown id and 400s without an id", async () => {
    seedTestJobs();
    const missing = await call({
      method: "DELETE",
      userId: "u_admin",
      role: "admin",
      query: { id: "nope" },
    });
    expect(missing.statusCode).toBe(404);
    const noId = await call({ method: "DELETE", userId: "u_admin", role: "admin" });
    expect(noId.statusCode).toBe(400);
  });

  it("refuses real jobs — only QA-prefixed names are deletable", async () => {
    seedTestJobs();
    const res = await call({
      method: "DELETE",
      userId: "u_admin",
      role: "admin",
      query: { id: "job-real-draft" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/only automated test jobs/i);
    expect(jobsIds()).toContain("job-real-draft");
  });

  it("refuses active test jobs — protects the allowed Active fixture", async () => {
    seedTestJobs();
    const res = await call({
      method: "DELETE",
      userId: "u_admin",
      role: "admin",
      query: { id: "qa-seed-field-active-job" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/park it to draft/i);
    expect(jobsIds()).toContain("qa-seed-field-active-job");
  });

  it("deletes a parked smoke job: row removed, per-job blobs swept, others intact", async () => {
    seedTestJobs();
    const res = await call({
      method: "DELETE",
      userId: "u_admin",
      role: "admin",
      query: { id: "smoke-test-1-job-b" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, deletedId: "smoke-test-1-job-b" });
    expect(jobsIds()).toEqual([
      "job-real-draft",
      "smoke-test-2-job-b",
      "qa-seed-field-active-job",
    ]);
    expect(blob.has("jobs/smoke-test-1-job-b/data.json")).toBe(false);
    expect(blob.has("jobs/smoke-test-1-job-b/audit.json")).toBe(false);
  });

  it("batch-deletes several parked jobs with a SINGLE jobs.json write", async () => {
    seedTestJobs();
    const res = await call({
      method: "DELETE",
      userId: "u_admin",
      role: "admin",
      query: { id: "smoke-test-1-job-b,smoke-test-2-job-b" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      deleted: ["smoke-test-1-job-b", "smoke-test-2-job-b"],
      refused: [],
    });
    expect(jobsIds()).toEqual(["job-real-draft", "qa-seed-field-active-job"]);
    expect(blob.has("jobs/smoke-test-1-job-b/data.json")).toBe(false);
    expect(blob.has("jobs/smoke-test-2-job-b/data.json")).toBe(false);
    // The whole point of the batch form: one read-modify-write of
    // jobs.json per request, so a second delete can never operate on (and
    // resurrect from) a pre-write snapshot.
    const jobsWrites = writeBlobMock.mock.calls.filter(([key]) => key === "jobs.json");
    expect(jobsWrites).toHaveLength(1);
  });

  it("batch reports refused ids (real / live / unknown) without failing eligible ones", async () => {
    seedTestJobs();
    const res = await call({
      method: "DELETE",
      userId: "u_admin",
      role: "admin",
      query: {
        id: "smoke-test-1-job-b,job-real-draft,qa-seed-field-active-job,nope",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      deleted: string[];
      refused: Array<{ id: string; error: string }>;
    };
    expect(body.deleted).toEqual(["smoke-test-1-job-b"]);
    expect(body.refused.map((r) => r.id)).toEqual([
      "job-real-draft",
      "qa-seed-field-active-job",
      "nope",
    ]);
    expect(body.refused[0]!.error).toMatch(/only automated test jobs/i);
    expect(body.refused[1]!.error).toMatch(/park it to draft/i);
    expect(body.refused[2]!.error).toMatch(/not found/i);
    // Refused rows are untouched.
    expect(jobsIds()).toEqual([
      "job-real-draft",
      "smoke-test-2-job-b",
      "qa-seed-field-active-job",
    ]);
  });
});

describe("POST /api/jobs?action=duplicate (#190)", () => {
  beforeEach(() => {
    blob.set("jobs.json", {
      jobs: [
        {
          id: "townhouse-a",
          name: "Townhouse A",
          status: "active",
          type: null,
          siteAddress: "1 Estate Rd",
          siteContactName: "Bob the Super",
          inductionRequired: true,
          startDate: "2026-05-01",
          ref: "JOB-0042",
          clientUserId: "u_client_1",
          statsCrewCount: 7,
          roughInTasks: [
            { id: "rt_1", name: "Rough-in power", order: 1 },
            { id: "rt_2", name: "Old task", archived: true },
          ],
          fitOffTasks: [{ id: "ft_1", name: "Fit-off power" }],
          areaGroups: [
            {
              id: "ag_1",
              name: "Ground",
              areas: [
                {
                  id: "ar_1",
                  name: "Kitchen",
                  spaceType: "wet area",
                  roughInTasks: [{ id: "rt_9", name: "Island feed" }],
                },
                { id: "ar_2", name: "Old laundry", archived: true },
              ],
            },
            { id: "ag_2", name: "Demolished wing", archived: true, areas: [] },
          ],
        },
      ],
    });
  });

  it("admin duplicates: fresh ids, draft status, structure copied, archived + operational state dropped", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "duplicate", id: "townhouse-a" },
    });
    expect(res.statusCode).toBe(200);
    const job = (res.body as { job: Record<string, unknown> }).job;
    expect(job.name).toBe("Townhouse A (copy)");
    expect(job.status).toBe("draft");

    const stored = (blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> }).jobs.find(
      (j) => j.name === "Townhouse A (copy)"
    )!;
    expect(stored.id).not.toBe("townhouse-a");
    // structure copied, fresh ids
    const groups = stored.areaGroups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1); // archived wing dropped
    expect(groups[0]!.name).toBe("Ground");
    expect(groups[0]!.id).not.toBe("ag_1");
    const areas = groups[0]!.areas as Array<Record<string, unknown>>;
    expect(areas).toHaveLength(1); // archived laundry dropped
    expect(areas[0]!.name).toBe("Kitchen");
    expect(areas[0]!.id).not.toBe("ar_1");
    expect(areas[0]!.spaceType).toBe("wet area");
    const overrides = areas[0]!.roughInTasks as Array<Record<string, unknown>>;
    expect(overrides[0]!.name).toBe("Island feed");
    expect(overrides[0]!.id).not.toBe("rt_9");
    const rt = stored.roughInTasks as Array<Record<string, unknown>>;
    expect(rt.map((t) => t.name)).toEqual(["Rough-in power"]); // archived task dropped
    expect(rt[0]!.id).not.toBe("rt_1");
    // site basics copied; operational state NOT
    expect(stored.siteAddress).toBe("1 Estate Rd");
    expect(stored.siteContactName).toBe("Bob the Super");
    expect(stored.inductionRequired).toBe(true);
    expect(stored.clientUserId).toBeNull();
    expect(stored.ref).toBeUndefined();
    expect(stored.startDate).toBeUndefined();
    expect(stored.statsCrewCount).toBeUndefined();
    // per-job blobs seeded EMPTY (no task state / evidence / history copied)
    expect(blob.get(`jobs/${stored.id}/data.json`)).toEqual({ dwellings: {}, snags: [], notes: [] });
    // audit records the source
    const audit = blob.get(`jobs/${stored.id}/audit.json`) as { entries: Array<{ kind: string; summary: string }> };
    expect(audit.entries[0]!.kind).toBe("duplicated");
    expect(audit.entries[0]!.summary).toContain("townhouse-a");
  });

  it("second copy gets a non-colliding name and id", async () => {
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { action: "duplicate", id: "townhouse-a" } });
    const res2 = await call({ method: "POST", userId: "u_admin", role: "admin", query: { action: "duplicate", id: "townhouse-a" } });
    expect(res2.statusCode).toBe(200);
    expect((res2.body as { job: { name: string } }).job.name).toBe("Townhouse A (copy 2)");
  });

  it("the duplicate is invisible to the field until published", async () => {
    await call({ method: "POST", userId: "u_admin", role: "admin", query: { action: "duplicate", id: "townhouse-a" } });
    const res = await call({ method: "GET", userId: "u_field", role: "electrician" });
    const names = (res.body as { jobs: Array<{ name: string }> }).jobs.map((j) => j.name);
    expect(names).not.toContain("Townhouse A (copy)");
  });

  it("403s non-admin tiers and 404s an unknown source", async () => {
    const lh = await call({ method: "POST", userId: "u_lh", role: "lh", query: { action: "duplicate", id: "townhouse-a" } });
    expect(lh.statusCode).toBe(403);
    const missing = await call({ method: "POST", userId: "u_admin", role: "admin", query: { action: "duplicate", id: "nope" } });
    expect(missing.statusCode).toBe(404);
  });
});

// Guards the Phil-LCP read-path perf change: the GET prelude now fires the three
// INDEPENDENT cold blob reads (users.json via getCurrentUser, jobs.json, and —
// on the list GET — job-types.json) concurrently instead of serially, and the
// list enrichment consumes that PREFETCHED job-types data. These prove the
// parallelization is output-preserving and still auth-gated.
describe("GET /api/jobs read-path parallelization (perf) — output parity", () => {
  it("field list still resolves typeName from the (now prefetched, parallel) job-types.json", async () => {
    const jobsBlob = blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> };
    jobsBlob.jobs.find((j) => j.id === "job-active")!.type = "jt_resi";
    blob.set("job-types.json", { jobTypes: [{ id: "jt_resi", name: "Residential" }] });

    const res = await call({ method: "GET", userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    const jobs = (res.body as { jobs: Array<Record<string, unknown>> }).jobs;
    // Visibility is unchanged by the parallelization: active only, no draft/archived.
    expect(jobs.map((j) => j.id)).toEqual(["job-active"]);
    // typeName resolved from the prefetched lookup (proves jobTypesData is consumed).
    expect(jobs[0]!.typeName).toBe("Residential");
  });

  it("does not leak job data on an unauthenticated GET (parallel reads discarded before the 401 gate)", async () => {
    const res = createRes();
    await handler({ method: "GET", query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toHaveProperty("jobs");
  });
});

// Guards the Phil jobs-summary read path (FLAG_PHIL_JOBS_SUMMARY_READ): the
// field/LH plain LIST is served from the derived jobs-summary.json (rebuilt here
// from the in-memory jobs.json on first read). These prove parity with the full
// read on the fields field consumers use, per-role redaction, visibility, and
// that admin/unauth are never summary-served.
describe("GET /api/jobs jobs-summary read path (perf, flag-gated)", () => {
  type JobRow = Record<string, unknown>;
  const rows = (r: { body: unknown }) => (r.body as { jobs: JobRow[] }).jobs;
  const used = (r: { body: unknown }) =>
    rows(r).map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      ref: j.ref,
      siteAddress: j.siteAddress,
      typeName: j.typeName,
    }));

  beforeEach(() => {
    // Give the active job the fields the field list shows + a resolvable type.
    const jobsBlob = blob.get("jobs.json") as { jobs: JobRow[] };
    const active = jobsBlob.jobs.find((j) => j.id === "job-active")!;
    active.type = "jt_resi";
    active.ref = "JOB-001";
    active.siteAddress = "1 Smith St";
    active.scopeOfWork = [{ id: "sw_1", title: "Supply and install DB-1" }];
    blob.set("job-types.json", { jobTypes: [{ id: "jt_resi", name: "Residential" }] });
  });
  afterEach(() => {
    delete process.env.FLAG_PHIL_JOBS_SUMMARY_READ;
    delete process.env.FLAG_SUPABASE_READ_PHIL_JOBS;
  });

  it("PRECEDENCE: summary path supersedes the supabase_read_phil_jobs PG overlay for the field list", async () => {
    // Both field-path overlays on. The summary must WIN (it removes the monolith
    // read; the PG overlay only rides on top of it). Proven by the response
    // omitting structure (areaGroups) — the summary record drops it, the full/
    // overlay read keeps it — so structure-absent == summary path ran.
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    process.env.FLAG_SUPABASE_READ_PHIL_JOBS = "1";
    const res = await call({ method: "GET", userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    const active = rows(res).find((j) => j.id === "job-active")!;
    expect(active).toBeDefined();
    expect(active).not.toHaveProperty("areaGroups"); // summary path (not the overlay/full read)
    expect(active.typeName).toBe("Residential");
  });

  it("PARITY: summary path === full read on the used fields + visibility (field tier)", async () => {
    delete process.env.FLAG_PHIL_JOBS_SUMMARY_READ;
    const full = await call({ method: "GET", userId: "u_field", role: "electrician" });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const summary = await call({ method: "GET", userId: "u_field", role: "electrician" });

    expect(summary.statusCode).toBe(200);
    expect(used(summary)).toEqual(used(full));
    // visibility unchanged: only the assigned active job (no draft/archived)
    expect(rows(summary).map((j) => j.id)).toEqual(["job-active"]);
    // typeName resolved from the pre-built summary
    expect(rows(summary)[0]!.typeName).toBe("Residential");
    // money never present on the cheap path
    expect(rows(summary)[0]).not.toHaveProperty("contractValue");
  });

  it("ROLE REDACTION: LH sees scopeOfWork via the summary, a plain field worker does not", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const lh = await call({ method: "GET", userId: "u_lh", role: "lh" });
    const field = await call({ method: "GET", userId: "u_field", role: "electrician" });
    const lhActive = rows(lh).find((j) => j.id === "job-active")!;
    const fieldActive = rows(field).find((j) => j.id === "job-active")!;
    expect(lhActive.scopeOfWork).toBeDefined();
    expect(fieldActive.scopeOfWork).toBeUndefined();
  });

  it("SCOPE GUARD: admin list is NOT summary-served even with the flag on (keeps full structure)", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const res = await call({ method: "GET", userId: "u_admin", role: "admin" });
    const active = rows(res).find((j) => j.id === "job-active")!;
    expect(active).toBeDefined();
    // the full read carries areaGroups; the summary omits it → proves the full path ran
    expect(active.areaGroups).toBeDefined();
  });

  it("WITHSTATS: ?withStats=1 uses the SUMMARY path (no areaGroups) with correct snag/ITP stats", async () => {
    // 2 active snags (open + in_progress; closed excluded), 2 active ITPs
    // (witnessed + pending; completed excluded; archived excluded).
    blob.set("jobs/job-active/data.json", {
      snagsV2: [{ status: "open" }, { status: "in_progress" }, { status: "closed" }],
    });
    blob.set("jobs/job-active/itps.json", {
      instances: [
        { status: "witnessed" },
        { status: "pending" },
        { status: "completed" },
        { status: "in-progress", archived: true },
      ],
    });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const res = await call({
      method: "GET",
      userId: "u_field",
      role: "electrician",
      query: { withStats: "1" },
    });
    const active = rows(res).find((j) => j.id === "job-active")!;
    expect(active).not.toHaveProperty("areaGroups"); // summary path, not the full read
    expect(active.statsSnagsV2Active).toBe(2);
    expect(active.statsItpsActive).toBe(2);
    // task/area stats (need areaGroups) are NOT served on this path
    expect(active).not.toHaveProperty("statsTasksTotal");
    // and still no money on the cheap path
    expect(active).not.toHaveProperty("contractValue");
  });

  it("WITHSTATS PARITY: summary stats == full-read stats for the two field stats", async () => {
    blob.set("jobs/job-active/data.json", {
      snagsV2: [{ status: "open" }, { status: "rejected" }, { status: "verified" }],
    });
    blob.set("jobs/job-active/itps.json", { instances: [{ status: "witnessed" }] });
    delete process.env.FLAG_PHIL_JOBS_SUMMARY_READ;
    const full = await call({ method: "GET", userId: "u_field", role: "electrician", query: { withStats: "1" } });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const summary = await call({ method: "GET", userId: "u_field", role: "electrician", query: { withStats: "1" } });
    const f = rows(full).find((j) => j.id === "job-active")!;
    const s = rows(summary).find((j) => j.id === "job-active")!;
    expect({ snags: s.statsSnagsV2Active, itps: s.statsItpsActive }).toEqual({
      snags: f.statsSnagsV2Active,
      itps: f.statsItpsActive,
    });
    expect(s.statsSnagsV2Active).toBe(2); // open + rejected (verified excluded)
    expect(s.statsItpsActive).toBe(1);
  });

  it("WITHSTATS FALLBACK: a summary read failure falls back to the full read (no 500, areaGroups present)", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    uploadedAtMock.mockRejectedValueOnce(new Error("blob list down")); // makes readJobsSummary throw
    const res = await call({ method: "GET", userId: "u_field", role: "electrician", query: { withStats: "1" } });
    expect(res.statusCode).toBe(200);
    const active = rows(res).find((j) => j.id === "job-active")!;
    expect(active).toBeDefined();
    expect(active).toHaveProperty("areaGroups"); // full read ran (fallback)
    expect(active).toHaveProperty("statsSnagsV2Active");
  });

  it("401: summary path leaks no job data when unauthenticated (flag on)", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const res = createRes();
    await handler({ method: "GET", query: {}, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toHaveProperty("jobs");
  });
});

// Guards the Phil SINGLE-JOB structure projection (same FLAG_PHIL_JOBS_SUMMARY_READ):
// /api/jobs?id=… for field/LH is served from the per-job jobs/<id>/field-detail.json
// projection instead of the jobs.json monolith. These prove byte parity with the
// full single-job read, that the projection (not the monolith) is served on a fresh
// hit, never-stale rebuild, per-role redaction, money omission, admin scope-guard,
// draft/archived 404, fallback on error, and 401.
describe("GET /api/jobs?id=… job-detail projection (perf, flag-gated)", () => {
  const single = (r: { body: unknown }) => (r.body as { job: Record<string, unknown> }).job;
  const DETAIL_KEY = "jobs/job-active/field-detail.json";

  afterEach(() => {
    delete process.env.FLAG_PHIL_JOBS_SUMMARY_READ;
    delete process.env.FLAG_SUPABASE_READ_PHIL_JOBS;
  });

  it("PARITY (field): projection === full read for the single-job GET (structure, archived-filter, redaction)", async () => {
    delete process.env.FLAG_PHIL_JOBS_SUMMARY_READ;
    const full = single(await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } }));
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const proj = single(await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } }));
    expect(proj).toEqual(full);
    // structure kept + archived area filtered (projectJobStructure ran)
    const areas = (proj.areaGroups as Array<{ areas: Array<{ id: string }> }>)[0]!.areas.map((a) => a.id);
    expect(areas).toEqual(["area-current"]); // area-archived filtered out
    // money never present on the field path
    expect(proj).not.toHaveProperty("contractValue");
  });

  it("PARITY (LH): projection === full read, scopeOfWork retained for the leading hand", async () => {
    delete process.env.FLAG_PHIL_JOBS_SUMMARY_READ;
    const full = single(await call({ method: "GET", userId: "u_lh", role: "lh", query: { id: "job-active" } }));
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const proj = single(await call({ method: "GET", userId: "u_lh", role: "lh", query: { id: "job-active" } }));
    expect(proj).toEqual(full);
    expect(proj.scopeOfWork).toBeDefined();
    expect(proj).not.toHaveProperty("contractValue"); // LH still never sees money
  });

  it("PROJECTION SERVED (fresh hit): a fresh per-job blob is served, not the monolith", async () => {
    blob.set(DETAIL_KEY, {
      builtFromUploadedAt: "T1", // matches the fixed uploadedAt mock → fresh
      record: { id: "job-active", name: "FROM-PROJECTION", status: "active", areaGroups: [] },
    });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const job = single(await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } }));
    expect(job.name).toBe("FROM-PROJECTION"); // proves the projection blob (not jobs.json) was the source
  });

  it("PRECEDENCE: the projection supersedes the supabase_read_phil_jobs PG overlay for the field single-job read", async () => {
    blob.set(DETAIL_KEY, {
      builtFromUploadedAt: "T1",
      record: { id: "job-active", name: "FROM-PROJECTION", status: "active", areaGroups: [] },
    });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    process.env.FLAG_SUPABASE_READ_PHIL_JOBS = "1"; // overlay on — projection must still win
    const job = single(await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } }));
    expect(job.name).toBe("FROM-PROJECTION"); // short-circuits before the monolith read + PG overlay
  });

  it("NEVER STALE (rebuild): a stale per-job blob is ignored; fresh monolith data is served + re-stamped", async () => {
    blob.set(DETAIL_KEY, {
      builtFromUploadedAt: "OLD", // mismatch vs "T1" → stale
      record: { id: "job-active", name: "STALE-NAME", status: "active", areaGroups: [] },
    });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const job = single(await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } }));
    expect(job.name).toBe("Active"); // rebuilt from the monolith, not the stale blob
    // re-stamped with the current uploadedAt for the next read
    expect((blob.get(DETAIL_KEY) as { builtFromUploadedAt: string }).builtFromUploadedAt).toBe("T1");
  });

  it("ROLE REDACTION: a plain field worker's single-job projection carries no scopeOfWork", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const job = single(await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } }));
    expect(job.scopeOfWork).toBeUndefined();
  });

  it("SCOPE GUARD: admin single-job is NOT projection-served (keeps money via the full read)", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const job = single(await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-active" } }));
    expect(job.contractValue).toBe(120000); // full read for admin → money intact ⇒ projection did not run
  });

  it("UNASSIGNED: a worker is 403'd for a job they're not on (fast path defers to the full read, no leak)", async () => {
    const jobsBlob = blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> };
    jobsBlob.jobs.push({ id: "job-unassigned", name: "Someone else's site", status: "active" });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const res = await call({ method: "GET", userId: "u_lh", role: "lh", query: { id: "job-unassigned" } });
    expect(res.statusCode).toBe(403); // not in assignedJobIds → fast path skipped → full read 403s
    expect(res.body).not.toHaveProperty("job"); // and never serves the job
  });

  it("DRAFT/ARCHIVED: field 404s through the projection path (falls through to the authoritative read)", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    for (const id of ["job-draft", "job-archived"]) {
      const res = await call({ method: "GET", userId: "u_field", role: "electrician", query: { id } });
      expect(res.statusCode, id).toBe(404);
    }
  });

  it("WITHSTATS: ?id=…&withStats=1 stays on the full read (admin-hub knob, not projection-served)", async () => {
    blob.set("jobs/job-active/data.json", { snagsV2: [{ status: "open" }] });
    blob.set("jobs/job-active/itps.json", { instances: [{ status: "witnessed" }] });
    blob.set(DETAIL_KEY, {
      builtFromUploadedAt: "T1",
      record: { id: "job-active", name: "FROM-PROJECTION", status: "active", areaGroups: [] },
    });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const job = single(await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active", withStats: "1" } }));
    expect(job.name).toBe("Active"); // full read ran (the projection marker did NOT win)
    expect(job).toHaveProperty("statsSnagsV2Active");
  });

  it("FALLBACK: a projection read error falls back to the full monolith read (no 500)", async () => {
    blob.set(DETAIL_KEY, {
      builtFromUploadedAt: "T1",
      record: { id: "job-active", name: "FROM-PROJECTION", status: "active", areaGroups: [] },
    });
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    uploadedAtMock.mockRejectedValueOnce(new Error("blob list down")); // makes readJobDetailProjection throw
    const res = await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } });
    expect(res.statusCode).toBe(200);
    expect(single({ body: res.body }).name).toBe("Active"); // monolith served, not the seeded projection
  });

  it("401: projection path leaks no job when unauthenticated (flag on)", async () => {
    process.env.FLAG_PHIL_JOBS_SUMMARY_READ = "true";
    const res = createRes();
    await handler({ method: "GET", query: { id: "job-active" }, headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toHaveProperty("job");
  });
});
