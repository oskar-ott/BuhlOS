import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * ServiceM8 → BuhlOS daily job sync (api/_lib/servicem8-sync.js) + its cron
 * handler (api/internal/sync-checks/servicem8.js).
 *
 * The matcher, name builder and needs-assignment projection are pure; the
 * runner is exercised with injected deps (in-memory blobs, fake ServiceM8
 * fetch, fake createJob) so no network / real blob store is touched. The
 * cron handler's auth + gating + status→HTTP mapping is covered the same
 * way as the hours sync-check.
 */

const requireFromHere = createRequire(import.meta.url);
const sync = requireFromHere(
  requireFromHere.resolve("../../../api/_lib/servicem8-sync.js"),
) as {
  REPORT_KEY: string;
  normalizeExternalId: (v: unknown) => string;
  findUnmatched: (
    sm8: Array<Record<string, unknown>>,
    jobs: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>;
  buildJobName: (s: Record<string, unknown>) => string;
  computeNeedsAssignment: (
    autoCreated: Array<{ id: string; name: string }>,
    jobs: Array<Record<string, unknown>>,
    users: Array<Record<string, unknown>>,
  ) => Array<{ id: string; name: string }>;
  runServiceM8Sync: (deps?: object) => Promise<SyncReport>;
};

type SyncReport = {
  lastRun?: string;
  status?: string;
  reason?: string;
  error?: string;
  sm8Count?: number;
  matchedCount?: number;
  created?: Array<{ id: string; name: string; sm8Number?: string }>;
  failed?: Array<Record<string, unknown>>;
  autoCreated?: Array<Record<string, unknown>>;
  needsAssignment?: Array<{ id: string; name: string }>;
};
const handleServiceM8SyncCheck = requireFromHere(
  requireFromHere.resolve("../../../api/internal/sync-checks/servicem8.js"),
) as (req: object, res: object, deps?: object) => Promise<unknown>;

const SM8 = (over: Partial<Record<string, string>> = {}) => ({
  uuid: "aaaa-bbbb-cccc",
  number: "1042",
  status: "Work Order",
  address: "12 Example St\nSydney NSW",
  company: "Smith Constructions",
  description: "",
  ...over,
});

function mockRes() {
  const r = {
    statusCode: 0,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
    end() {
      return r;
    },
    setHeader(k: string, v: string) {
      r.headers[k] = v;
      return r;
    },
  };
  return r;
}

describe("findUnmatched", () => {
  it("matches by serviceM8JobId against uuid or visible number, and by ref", () => {
    const sm8 = [
      SM8({ uuid: "u-1", number: "100" }),
      SM8({ uuid: "u-2", number: "200" }),
      SM8({ uuid: "u-3", number: "300" }),
      SM8({ uuid: "u-4", number: "400" }),
    ];
    const jobs = [
      { id: "a", serviceM8JobId: "U-1" }, // uuid match, case-insensitive
      { id: "b", serviceM8JobId: " 200 " }, // number match, whitespace-insensitive
      { id: "c", ref: "300" }, // ref carries the SM8 number
    ];
    const unmatched = sync.findUnmatched(sm8, jobs);
    expect(unmatched.map((s) => s.number)).toEqual(["400"]);
  });

  it("never treats an empty external id as a match", () => {
    const sm8 = [SM8({ uuid: "u-9", number: "" })];
    const jobs = [{ id: "a", serviceM8JobId: "" }, { id: "b", ref: "" }];
    expect(sync.findUnmatched(sm8, jobs)).toHaveLength(1);
  });
});

describe("buildJobName", () => {
  it("joins client and first address line", () => {
    expect(sync.buildJobName(SM8())).toBe("Smith Constructions — 12 Example St");
  });
  it("falls back to the SM8 number when client and address are blank", () => {
    expect(sync.buildJobName(SM8({ company: "", address: "" }))).toBe(
      "ServiceM8 job 1042",
    );
  });
});

describe("computeNeedsAssignment", () => {
  const autoCreated = [
    { id: "j1", name: "One" },
    { id: "j2", name: "Two" },
    { id: "j3", name: "Three" },
    { id: "gone", name: "Deleted" },
  ];
  const jobs = [
    { id: "j1", status: "active" },
    { id: "j2", status: "active" },
    { id: "j3", status: "complete" },
  ];
  it("flags live auto-created jobs no user is assigned to", () => {
    const users = [{ id: "w1", assignedJobIds: ["j2"] }];
    expect(sync.computeNeedsAssignment(autoCreated, jobs, users)).toEqual([
      { id: "j1", name: "One" },
    ]);
  });
});

function makeDeps(over: Record<string, unknown> = {}) {
  const blobs: Record<string, unknown> = {
    "jobs.json": { jobs: [{ id: "existing", name: "Existing", serviceM8JobId: "1000", status: "active" }] },
    "users.json": { users: [{ id: "w1", assignedJobIds: ["existing"] }] },
  };
  // Faithful-enough createJob stand-in: duplicate-id guard, push, persist.
  const create = vi.fn(async (data: { jobs: Array<Record<string, unknown>> }, input: Record<string, unknown>) => {
    const slug = String(input.id ?? input.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    if (data.jobs.some((j) => j.id === slug)) {
      return { ok: false as const, status: 400, error: "job id already exists" };
    }
    const job = { ...input, id: slug };
    data.jobs.push(job);
    blobs["jobs.json"] = data;
    return { ok: true as const, job };
  });
  const appendAudit = vi.fn(async (entry: Record<string, unknown>) => {
    void entry;
  });
  const deps = {
    env: { SERVICEM8_API_KEY: "key" },
    fetchJobs: vi.fn(async () => [SM8({ uuid: "u-new", number: "1042" })]),
    read: async (key: string, fallback: unknown) => blobs[key] ?? fallback,
    write: async (key: string, value: unknown) => {
      blobs[key] = value;
    },
    create,
    appendAudit,
    now: () => "2026-07-19T19:15:00.000Z",
    ...over,
  };
  return { deps, blobs, create, appendAudit };
}

describe("runServiceM8Sync", () => {
  it("skips (and records it) when the API key is not configured", async () => {
    const { deps, blobs } = makeDeps({ env: {} });
    const report = await sync.runServiceM8Sync(deps);
    expect(report.status).toBe("skipped");
    expect(blobs[sync.REPORT_KEY]).toMatchObject({ status: "skipped" });
  });

  it("auto-creates unmatched work orders as ACTIVE jobs with the SM8 link, and flags them for assignment", async () => {
    const { deps, create, appendAudit } = makeDeps();
    const report = await sync.runServiceM8Sync(deps);
    expect(report.status).toBe("ok");
    expect(report.sm8Count).toBe(1);
    expect(report.matchedCount).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({
      name: "Smith Constructions — 12 Example St",
      status: "active",
      serviceM8JobId: "1042",
      ref: "1042",
      siteAddress: "12 Example St\nSydney NSW",
    });
    expect(report.created).toHaveLength(1);
    // Newly created job has no assigned workers → hours still can't be logged.
    expect(report.needsAssignment).toEqual([
      { id: report.created![0]!.id, name: report.created![0]!.name },
    ]);
    expect(appendAudit).toHaveBeenCalledTimes(1);
    expect(appendAudit.mock.calls[0]![0]).toMatchObject({
      action: "job.created",
      metadata: { source: "servicem8_sync" },
    });
  });

  it("leaves matched work orders alone", async () => {
    const { deps, create } = makeDeps({
      fetchJobs: async () => [SM8({ uuid: "u-old", number: "1000" })],
    });
    const report = await sync.runServiceM8Sync(deps);
    expect(report.status).toBe("ok");
    expect(report.matchedCount).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(report.created).toEqual([]);
  });

  it("retries a slug collision with the SM8 number appended", async () => {
    const { deps, blobs, create } = makeDeps();
    (blobs["jobs.json"] as { jobs: unknown[] }).jobs.push({
      id: "smith-constructions-12-example-st",
      name: "Smith Constructions — 12 Example St",
      status: "active",
    });
    const report = await sync.runServiceM8Sync(deps);
    expect(report.status).toBe("ok");
    expect(create).toHaveBeenCalledTimes(2);
    expect(report.created![0]!.id).toContain("sm8-1042");
    expect(report.failed).toEqual([]);
  });

  it("records a fetch failure honestly and preserves the cumulative auto-created memory", async () => {
    const { deps, blobs } = makeDeps({
      fetchJobs: async () => {
        throw new Error("ServiceM8 job.json responded 401");
      },
    });
    blobs[sync.REPORT_KEY] = {
      status: "ok",
      autoCreated: [{ id: "j-old", name: "Old", createdAt: "2026-07-18T19:15:00.000Z" }],
      needsAssignment: [{ id: "j-old", name: "Old" }],
    };
    const report = await sync.runServiceM8Sync(deps);
    expect(report.status).toBe("error");
    expect(report.error).toContain("401");
    expect(report.autoCreated).toEqual([
      { id: "j-old", name: "Old", createdAt: "2026-07-18T19:15:00.000Z" },
    ]);
    expect(report.needsAssignment).toEqual([{ id: "j-old", name: "Old" }]);
  });
});

describe("cron handler", () => {
  const okDeps = (over: Record<string, unknown> = {}) => ({
    env: { CRON_SECRET: "s" },
    cronState: () => "ok",
    flagOn: async () => true,
    run: async () => ({ status: "ok", sm8Count: 3, matchedCount: 3, created: [], failed: [], needsAssignment: [] }),
    ...over,
  });

  it("denies a bad secret and refuses when unconfigured", async () => {
    const res1 = mockRes();
    await handleServiceM8SyncCheck({ method: "GET" }, res1, okDeps({ cronState: () => "denied" }));
    expect(res1.statusCode).toBe(401);

    const res2 = mockRes();
    await handleServiceM8SyncCheck({ method: "GET" }, res2, okDeps({ env: {} }));
    expect(res2.statusCode).toBe(503);
  });

  it("skips cleanly (200) when the flag is off, without running", async () => {
    const run = vi.fn();
    const res = mockRes();
    await handleServiceM8SyncCheck({ method: "GET" }, res, okDeps({ flagOn: async () => false, run }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps ok → 200 and error → 500 (red cron run)", async () => {
    const res1 = mockRes();
    await handleServiceM8SyncCheck({ method: "GET" }, res1, okDeps());
    expect(res1.statusCode).toBe(200);
    expect(res1.body).toMatchObject({ ok: true, status: "ok", sm8Count: 3 });

    const res2 = mockRes();
    await handleServiceM8SyncCheck(
      { method: "GET" },
      res2,
      okDeps({ run: async () => ({ status: "error", error: "boom" }) }),
    );
    expect(res2.statusCode).toBe(500);
    expect(res2.body).toMatchObject({ ok: false, status: "error", error: "boom" });
  });
});
