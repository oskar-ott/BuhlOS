import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  delete requireFromHere.cache[auditPath];
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
