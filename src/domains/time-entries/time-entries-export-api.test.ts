import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for GET /api/time-entries-export against the REAL handler.
 *
 * #895 convergence: this endpoint is now READ-ONLY. It previews/downloads CSV
 * and feeds the /hours/period rollup, but it NEVER stamps entries and NEVER
 * writes payroll-runs.json — recording a payroll run is the payroll-batch flow.
 * The POST finalise path is retired (410 Gone).
 *
 * Pins:
 *   - admin-tier only (403 otherwise) — the CSV carries hourly rates;
 *   - NO GET stamps entries or appends the runs log (with or without dryRun);
 *   - explicit fromDate/toDate are respected (the endpoint's default week is
 *     server-local and untrustworthy);
 *   - CSV shape selection (payroll | review | xero) is unchanged and shared;
 *   - POST is GONE (410) and points at the batch flow.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/time-entries-export.js");
const payrollInputsPath = requireFromHere.resolve("../../../api/_lib/payroll-inputs.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    sent: null as string | null,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(payload: string) {
      this.sent = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

async function call(
  userId: string,
  role: string,
  query: Record<string, string>,
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: "GET",
      query,
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
    },
    res,
  );
  return res;
}

async function callPost(
  userId: string,
  role: string,
  body: Record<string, unknown>,
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: {},
      body,
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
    },
    res,
  );
  return res;
}

function entry(userId: string, date: string, extra: Record<string, unknown> = {}) {
  return {
    id: `te_${userId}_${date}`,
    userId,
    date,
    status: "approved",
    totalHours: 8,
    allocations: [{ jobId: "j1", jobName: "Riverside", hours: 8 }],
    userName: userId,
    ...extra,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_lh", username: "lead", role: "lh", passwordHash: "$2a$10$x" },
      { id: "w1", username: "sparky", role: "electrician", hourlyRate: 50, passwordHash: "$2a$10$x" },
      { id: "w2", username: "appy", role: "tradie", hourlyRate: 30, passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside" }] });
  // Week under test: Mon 2026-06-08 .. Sun 2026-06-14. One entry outside it.
  blob.set("users/w1/time-entries/2026-06-09.json", entry("w1", "2026-06-09"));
  blob.set("users/w2/time-entries/2026-06-10.json", entry("w2", "2026-06-10"));
  blob.set("users/w1/time-entries/2026-06-01.json", entry("w1", "2026-06-01"));

  for (const p of [authPath, handlerPath, payrollInputsPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        blobs: [...blob.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ pathname: k, url: `memory://${k}` })),
      })),
      put: vi.fn(async () => ({})),
    },
  } as NodeJS.Module;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = String(url).replace(/^memory:\/\//, "").replace(/\?.*$/, "");
      if (!blob.has(key)) return { ok: false, json: async () => null };
      return { ok: true, json: async () => clone(blob.get(key)) };
    }),
  );

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
  // Freshness guarantee (2026-08-24): one instant retry instead of the ~5s
  // production backoff, so the refusal/recovery paths run without sleeping.
  (
    requireFromHere(payrollInputsPath) as {
      __setFreshnessRetryDelaysForTests: (d: number[]) => void;
    }
  ).__setFreshnessRetryDelaysForTests([0]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const WEEK = { fromDate: "2026-06-08", toDate: "2026-06-14" };

describe("GET /api/time-entries-export — read-only (#895)", () => {
  it("is admin-tier only — a leading hand gets 403", async () => {
    const res = await call("u_lh", "lh", { ...WEEK, dryRun: "1", format: "json" });
    expect(res.statusCode).toBe(403);
  });

  it("dryRun previews the explicit week WITHOUT stamping or logging", async () => {
    const res = await call("u_admin", "office", { ...WEEK, dryRun: "1", format: "json" });
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      range: { fromDate: string; toDate: string; dryRun: boolean };
      rows: Array<{ date: string; exportId: string }>;
      summary: { rowCount: number };
    };
    expect(body.range).toMatchObject({ ...WEEK, dryRun: true });
    // the out-of-range 2026-06-01 entry is excluded by the explicit range
    expect(body.rows.map((r) => r.date).sort()).toEqual(["2026-06-09", "2026-06-10"]);
    expect(body.summary.rowCount).toBe(2);

    // nothing stamped, nothing logged
    const w1 = blob.get("users/w1/time-entries/2026-06-09.json") as { exportId?: string };
    expect(w1.exportId).toBeUndefined();
    expect(blob.has("payroll-runs.json")).toBe(false);
  });

  it("#895: a non-dryRun GET is ALSO read-only — CSV download, but never stamps or logs", async () => {
    const res = await call("u_admin", "office", { ...WEEK });
    expect(res.statusCode).toBe(200);
    expect(res.sent).toContain("Week Start"); // full payroll CSV
    expect(res.headers["Content-Disposition"]).toContain("attachment");
    expect(res.headers["X-Export-Hash"]).toMatch(/^[0-9a-f]{64}$/);
    // the legacy committed-run headers are gone — no run was recorded
    expect(res.headers["X-Export-Id"]).toBeUndefined();

    const w1 = blob.get("users/w1/time-entries/2026-06-09.json") as { exportId?: string };
    const w2 = blob.get("users/w2/time-entries/2026-06-10.json") as { exportId?: string };
    expect(w1.exportId).toBeUndefined();
    expect(w2.exportId).toBeUndefined();
    expect(blob.has("payroll-runs.json")).toBe(false);
  });

  it("#380: a split day conserves the entry's stored ordinary/overtime in the rows", async () => {
    blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside" }, { id: "j2", name: "Depot" }] });
    blob.set(
      "users/w1/time-entries/2026-06-11.json",
      entry("w1", "2026-06-11", {
        totalHours: 10,
        ordinaryHours: 8,
        overtimeHours: 2,
        allocations: [
          { jobId: "j1", jobName: "Riverside", hours: 5 },
          { jobId: "j2", jobName: "Depot", hours: 5 },
        ],
      }),
    );
    const res = await call("u_admin", "office", {
      fromDate: "2026-06-11",
      toDate: "2026-06-11",
      dryRun: "1",
      format: "json",
    });
    const rows = (res.body as {
      rows: Array<{ jobId: string; ordinaryHours: number; overtimeHours: number }>;
    }).rows;
    const byJob = Object.fromEntries(
      rows.map((r) => [r.jobId, [r.ordinaryHours, r.overtimeHours]]),
    );
    expect(byJob).toEqual({ j1: [5, 0], j2: [3, 2] });

    // a job-filtered export keeps the DAY-context proration
    const filtered = await call("u_admin", "office", {
      fromDate: "2026-06-11",
      toDate: "2026-06-11",
      dryRun: "1",
      format: "json",
      jobId: "j2",
    });
    const fRows = (filtered.body as {
      rows: Array<{ ordinaryHours: number; overtimeHours: number }>;
    }).rows;
    expect(fRows).toHaveLength(1);
    expect(fRows[0]).toMatchObject({ ordinaryHours: 3, overtimeHours: 2 });
  });
});

// #131 — CSV shape selection (review / xero) over the SAME rows. Shape changes
// only columns + filename; shared with the locked-batch CSV via payroll-csv.js.
describe("GET /api/time-entries-export — CSV shapes (#131)", () => {
  const headerOf = (res: Res) => String(res.sent).split("\n")[0];
  const dataRows = (res: Res) => String(res.sent).trim().split("\n").slice(1).map((l) => l.split(","));
  const FAKE_COLS = ["Earnings Rate", "Travel", "Allowance", "Leave", "Pay run", "Payslip", "STP", "Super", "Tax", "TimesheetID"];

  it("default (no shape) is byte-compatible with the existing payroll columns", async () => {
    const res = await call("u_admin", "office", { ...WEEK, dryRun: "1" });
    const h = headerOf(res);
    expect(h).toContain("Week Start");
    expect(h).toContain("Rate ex-GST"); // admin payroll shape keeps rate/cost
    expect(res.headers["Content-Disposition"]).toContain("buhl-payroll_");
  });

  it("shape=review — rich human columns, period range, no rate/cost, no fake cols", async () => {
    const res = await call("u_admin", "office", { ...WEEK, shape: "review", dryRun: "1" });
    expect(headerOf(res)).toBe(
      "Pay Period Start,Pay Period End,Worker Name,Date,Day,Job,Ordinary Hours,Overtime Hours,Total Hours,Approval Status,Exported,Export ID,Notes",
    );
    expect(headerOf(res)).not.toContain("Rate ex-GST");
    expect(headerOf(res)).not.toContain("Line cost");
    for (const c of FAKE_COLS) expect(headerOf(res)).not.toContain(c);
    const first = dataRows(res)[0]!;
    expect(first[0]).toBe("2026-06-08"); // Pay Period Start = requested range
    expect(first[1]).toBe("2026-06-14");
    expect(res.headers["Content-Disposition"]).toContain("buhlos-review-hours-2026-06-08-to-2026-06-14.csv");
  });

  it("shape=xero — lean payroll-bridge columns only, no fake cols", async () => {
    const res = await call("u_admin", "office", { ...WEEK, shape: "xero", dryRun: "1" });
    expect(headerOf(res)).toBe(
      "Pay Period Start,Pay Period End,Worker Name,Xero Employee ID,Date,Ordinary Hours,Overtime Hours,Total Hours",
    );
    for (const c of [...FAKE_COLS, "Rate", "Line cost", "Job", "Notes"]) expect(headerOf(res)).not.toContain(c);
    expect(res.headers["Content-Disposition"]).toContain("buhlos-xero-ready-hours-2026-06-08-to-2026-06-14.csv");
  });

  it("xero shape: missing xeroEmployeeId is a BLANK id column (not faked)", async () => {
    const res = await call("u_admin", "office", { ...WEEK, shape: "xero", dryRun: "1" });
    const row = dataRows(res)[0]!; // w1/w2 have no xeroEmployeeId in the fixture
    expect(row[3]).toBe(""); // Xero Employee ID column blank
  });

  it("xero shape: a mapped worker shows the real Xero Employee ID", async () => {
    (blob.get("users.json") as { users: Array<{ id: string; xeroEmployeeId?: string }> }).users.find((u) => u.id === "w1")!.xeroEmployeeId = "XE-001";
    const res = await call("u_admin", "office", { ...WEEK, shape: "xero", dryRun: "1" });
    const w1row = dataRows(res).find((r) => r[2] === "w1")!;
    expect(w1row[3]).toBe("XE-001");
  });

  it("split day stays one row per allocation with OT prorated; totals match (shape=review)", async () => {
    blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside" }, { id: "j2", name: "Depot" }] });
    blob.set("users/w1/time-entries/2026-06-11.json", entry("w1", "2026-06-11", {
      totalHours: 10, ordinaryHours: 8, overtimeHours: 2,
      allocations: [
        { jobId: "j1", jobName: "Riverside", hours: 6 },
        { jobId: "j2", jobName: "Depot", hours: 4 },
      ],
    }));
    const res = await call("u_admin", "office", { fromDate: "2026-06-11", toDate: "2026-06-11", shape: "review", dryRun: "1" });
    const rows = dataRows(res); // Job=col5, Ordinary=6, Overtime=7, Total=8
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r[5]).sort()).toEqual(["Depot", "Riverside"]);
    expect(rows.reduce((s, r) => s + Number(r[8]), 0)).toBe(10); // total hours
    expect(rows.reduce((s, r) => s + Number(r[7]), 0)).toBeCloseTo(2, 5); // OT prorated
    expect(rows.reduce((s, r) => s + Number(r[6]), 0)).toBeCloseTo(8, 5); // ordinary
  });

  it("#895: a non-dryRun CSV with a shape STILL never stamps or logs", async () => {
    const res = await call("u_admin", "office", { ...WEEK, shape: "xero" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["X-Export-Id"]).toBeUndefined();
    expect((blob.get("users/w1/time-entries/2026-06-09.json") as { exportId?: string }).exportId).toBeUndefined();
    expect(blob.has("payroll-runs.json")).toBe(false);
  });
});

// #895 — POST finalise is retired. The only path that records a payroll run is
// the payroll-batch flow (create → validate → lock → export).
describe("POST /api/time-entries-export — retired (410) (#895)", () => {
  it("admin-tier only — a leading hand gets 403 (auth runs before the method check)", async () => {
    const res = await callPost("u_lh", "lh", { ...WEEK, shape: "xero" });
    expect(res.statusCode).toBe(403);
  });

  it("an admin finalise is GONE (410), points at the batch flow, and stamps nothing", async () => {
    const res = await callPost("u_admin", "office", { ...WEEK, shape: "xero" });
    expect(res.statusCode).toBe(410);
    const body = res.body as { code: string; replacement: string };
    expect(body.code).toBe("gone");
    expect(body.replacement).toBe("/api/xero/payroll-batches");
    expect((blob.get("users/w1/time-entries/2026-06-09.json") as { exportId?: string }).exportId).toBeUndefined();
    expect(blob.has("payroll-runs.json")).toBe(false);
  });
});

describe("confirmed PG worker links override the legacy users.json field (#248/#249)", () => {
  const mappingsPath = requireFromHere.resolve("../../../api/_lib/xero/worker-mappings.js");
  const dataRows = (res: Res) => String(res.sent).trim().split("\n").slice(1).map((l) => l.split(","));

  afterEach(() => {
    delete requireFromHere.cache[mappingsPath];
  });

  it("a confirmed link fills the Xero Employee ID even when the legacy field is stale", async () => {
    // Legacy field carries a stale value from before a reconnect…
    (blob.get("users.json") as { users: Array<{ id: string; xeroEmployeeId?: string }> })
      .users.find((u) => u.id === "w1")!.xeroEmployeeId = "stale-legacy-id";
    // …but PG holds the explicitly-confirmed link (the source of truth).
    requireFromHere.cache[mappingsPath] = {
      id: mappingsPath,
      filename: mappingsPath,
      loaded: true,
      exports: {
        mappingReadiness: vi.fn(async (workerIds: string[]) =>
          workerIds.map((id) => ({
            workerId: id,
            employeeId: id === "w1" ? "pg-confirmed-id" : null,
            mapped: id === "w1",
          }))
        ),
      },
    } as NodeJS.Module;

    const res = await call("u_admin", "office", { ...WEEK, shape: "xero", dryRun: "1" });
    const rows = dataRows(res);
    expect(rows.find((r) => r[2] === "w1")![3]).toBe("pg-confirmed-id");
    // Unmapped worker keeps the honest blank — a PG miss never fakes an id.
    expect(rows.find((r) => r[2] === "w2")![3]).toBe("");
  });

  it("mapping lookup failure (disconnected Xero) leaves the legacy field standing", async () => {
    (blob.get("users.json") as { users: Array<{ id: string; xeroEmployeeId?: string }> })
      .users.find((u) => u.id === "w1")!.xeroEmployeeId = "XE-legacy";
    requireFromHere.cache[mappingsPath] = {
      id: mappingsPath,
      filename: mappingsPath,
      loaded: true,
      exports: {
        mappingReadiness: vi.fn(async () => {
          throw new Error("not_connected");
        }),
      },
    } as NodeJS.Module;

    const res = await call("u_admin", "office", { ...WEEK, shape: "xero", dryRun: "1" });
    expect(dataRows(res).find((r) => r[2] === "w1")![3]).toBe("XE-legacy");
  });
});

// ── Freshness guarantee (2026-08-24 incident) ────────────────────────────────
// wk34's print-out silently dropped freshly-approved days: the CDN served the
// pre-approval document ("submitted") and the approved filter removed real
// hours with no error. The engine now verifies content against the blob's
// last-PUT time and REFUSES rather than producing a short artifact.
describe("freshness guarantee — a stale or unreadable day refuses the whole payroll read", () => {
  function listWith(uploadedAtByPath: Record<string, string>, extraPaths: string[] = []) {
    const vb = requireFromHere(vercelBlobPath) as { list: ReturnType<typeof vi.fn> };
    vb.list.mockImplementation(async ({ prefix }: { prefix: string }) => ({
      blobs: [...new Set([...blob.keys(), ...extraPaths])]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({
          pathname: k,
          url: `memory://${k}`,
          ...(uploadedAtByPath[k] ? { uploadedAt: uploadedAtByPath[k] } : {}),
        })),
    }));
  }

  it("REFUSES (503, naming the day) when a just-overwritten entry still reads stale — the wk34 bug", async () => {
    // The store still serves content stamped 10 minutes ago…
    blob.set(
      "users/w1/time-entries/2026-06-09.json",
      entry("w1", "2026-06-09", {
        status: "submitted",
        updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    );
    // …but the blob's last PUT was moments ago (the approval that hasn't propagated).
    listWith({ "users/w1/time-entries/2026-06-09.json": new Date().toISOString() });
    const res = await call("u_admin", "office", { ...WEEK, dryRun: "1", format: "json", status: "approved" });
    expect(res.statusCode).toBe(503);
    const err = (res.body as { error: string }).error;
    expect(err).toContain("payroll read refused");
    expect(err).toContain("sparky 2026-06-09 (just changed)");
    expect(err).toContain("Nothing was produced with missing hours");
  });

  it("recovers when a retry serves the fresh content — the day is included, from the retry not the stale read", async () => {
    const key = "users/w1/time-entries/2026-06-09.json";
    const stale = entry("w1", "2026-06-09", {
      status: "submitted",
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const fresh = entry("w1", "2026-06-09", {
      status: "approved",
      updatedAt: new Date().toISOString(),
    });
    listWith({ [key]: new Date().toISOString() });
    let calls = 0;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: unknown) => {
      const k = String(url).replace(/^memory:\/\//, "").replace(/\?.*$/, "");
      if (k === key) {
        calls += 1;
        return { ok: true, json: async () => clone(calls === 1 ? stale : fresh) };
      }
      if (!blob.has(k)) return { ok: false, json: async () => null };
      return { ok: true, json: async () => clone(blob.get(k)) };
    });
    const res = await call("u_admin", "office", { ...WEEK, dryRun: "1", format: "json", status: "approved" });
    expect(res.statusCode).toBe(200);
    const rows = (res.body as { rows: Array<{ date: string; workerId: string }> }).rows;
    expect(rows.some((r) => r.workerId === "w1" && r.date === "2026-06-09")).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it("REFUSES when a listed day-file cannot be read at all — never a silently shorter payroll", async () => {
    listWith({}, ["users/w2/time-entries/2026-06-11.json"]); // listed but unfetchable
    const res = await call("u_admin", "office", { ...WEEK, dryRun: "1", format: "csv", status: "approved" });
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: string }).error).toContain("appy 2026-06-11 (unreadable)");
    expect(res.sent).toBeNull(); // no CSV bytes were produced
  });

  it("accepts what it cannot verify (no uploadedAt in the listing; legacy rows without stamps) — never invents staleness", async () => {
    const res = await call("u_admin", "office", { ...WEEK, dryRun: "1", format: "json", status: "approved" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
  });
});
