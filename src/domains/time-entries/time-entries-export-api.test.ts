import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for GET /api/time-entries-export (#126) against the
 * REAL handler — the contract the weekly board's committed-export panel
 * builds on. Standard harness (signed sessions, in-memory blob), plus a
 * `@vercel/blob` list mock because the endpoint enumerates per-user
 * time-entry blobs by pathname, and a `send`/`setHeader`-capturing res.
 *
 * Pins:
 *   - admin-tier only (403 otherwise) — the CSV carries hourly rates;
 *   - dryRun NEVER stamps and never appends the runs log;
 *   - the committed run stamps exportId/exportedAt on every included entry,
 *     appends payroll-runs.json, and sets X-Export-Hash/X-Export-Id;
 *   - explicit fromDate/toDate are respected (the panel always sends them —
 *     the endpoint's default week is server-local and untrustworthy);
 *   - re-running a committed export RE-STAMPS (detected, not refused) —
 *     the UI's already-exported acknowledgement is the guard.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const timeEntriesLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/time-entries-export.js");

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

/** Give w1/w2 Xero employee ids so a Xero-ready finalise isn't mapping-blocked. */
function mapXeroIds() {
  const users = (blob.get("users.json") as {
    users: Array<{ id: string; xeroEmployeeId?: string }>;
  }).users;
  users.find((u) => u.id === "w1")!.xeroEmployeeId = "XE-1";
  users.find((u) => u.id === "w2")!.xeroEmployeeId = "XE-2";
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

  for (const p of [authPath, handlerPath, timeEntriesLibPath, activityPath]) {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const WEEK = { fromDate: "2026-06-08", toDate: "2026-06-14" };

describe("GET /api/time-entries-export (#126)", () => {
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

  it("the committed run stamps entries, appends the runs log and sets the headers", async () => {
    const res = await call("u_admin", "office", { ...WEEK });
    expect(res.statusCode).toBe(200);
    expect(res.sent).toContain("Week Start");
    expect(res.headers["Content-Disposition"]).toContain("attachment");
    expect(res.headers["X-Export-Hash"]).toMatch(/^[0-9a-f]{64}$/);
    const exportId = res.headers["X-Export-Id"];
    expect(exportId).toMatch(/^exp_/);

    // both in-range entries stamped with THIS run's id; out-of-range untouched
    const w1 = blob.get("users/w1/time-entries/2026-06-09.json") as { exportId: string };
    const w2 = blob.get("users/w2/time-entries/2026-06-10.json") as { exportId: string };
    const out = blob.get("users/w1/time-entries/2026-06-01.json") as { exportId?: string };
    expect(w1.exportId).toBe(exportId);
    expect(w2.exportId).toBe(exportId);
    expect(out.exportId).toBeUndefined();

    // append-only run log carries the fields the panel renders verbatim
    const runs = (blob.get("payroll-runs.json") as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      exportId,
      actorName: "boss",
      rowCount: 2,
      range: { fromDate: WEEK.fromDate, toDate: WEEK.toDate, status: "approved" },
    });
    expect(runs[0]!.hash).toBe(res.headers["X-Export-Hash"]);
  });

  it("re-running RE-STAMPS with the new run id (detected via preview, not refused)", async () => {
    const first = await call("u_admin", "office", { ...WEEK });
    const firstId = first.headers["X-Export-Id"];

    // the dry-run preview now shows the rows as already exported
    const preview = await call("u_admin", "office", { ...WEEK, dryRun: "1", format: "json" });
    const rows = (preview.body as { rows: Array<{ exportId: string }> }).rows;
    expect(rows.every((r) => r.exportId === firstId)).toBe(true);

    const second = await call("u_admin", "office", { ...WEEK });
    const secondId = second.headers["X-Export-Id"];
    expect(secondId).not.toBe(firstId);
    const w1 = blob.get("users/w1/time-entries/2026-06-09.json") as { exportId: string };
    expect(w1.exportId).toBe(secondId);
    const runs = (blob.get("payroll-runs.json") as { runs: unknown[] }).runs;
    expect(runs).toHaveLength(2);
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
    // rows sort by job NAME (Depot < Riverside) — compare as a set keyed by job
    const byJob = Object.fromEntries(
      rows.map((r) => [r.jobId, [r.ordinaryHours, r.overtimeHours]]),
    );
    expect(byJob).toEqual({ j1: [5, 0], j2: [3, 2] });

    // a job-filtered export keeps the DAY-context proration — j2's row still
    // carries the day's OT, it doesn't get re-derived as 5 ordinary.
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

  it("an empty week commits nothing: no stamp, no run log entry", async () => {
    const res = await call("u_admin", "office", {
      fromDate: "2026-07-06",
      toDate: "2026-07-12",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["X-Export-Id"]).toBeUndefined();
    expect(blob.has("payroll-runs.json")).toBe(false);
  });
});

// #131 — CSV shape selection (review / xero) over the SAME rows + dry-run/
// committed machinery. Shape changes only columns + filename.
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
    expect(rows.reduce((s, r) => s + Number(r[7]), 0)).toBeCloseTo(2, 5); // OT prorated, not re-attributed
    expect(rows.reduce((s, r) => s + Number(r[6]), 0)).toBeCloseTo(8, 5); // ordinary
  });

  it("dryRun=1 with a shape still NEVER stamps or logs", async () => {
    await call("u_admin", "office", { ...WEEK, shape: "xero", dryRun: "1" });
    expect((blob.get("users/w1/time-entries/2026-06-09.json") as { exportId?: string }).exportId).toBeUndefined();
    expect(blob.has("payroll-runs.json")).toBe(false);
  });

  it("committed export with a shape stamps the entries once and logs the run", async () => {
    const res = await call("u_admin", "office", { ...WEEK, shape: "xero" });
    const exportId = res.headers["X-Export-Id"];
    expect(exportId).toMatch(/^exp_/);
    expect((blob.get("users/w1/time-entries/2026-06-09.json") as { exportId: string }).exportId).toBe(exportId);
    expect((blob.get("payroll-runs.json") as { runs: unknown[] }).runs).toHaveLength(1);
  });
});

// #131 — POST finalise: the HARDENED committed path. Explicit (not a casual GET
// link), eligible-rows-only, NEVER re-stamps, blocks on no-rows / nothing-new /
// a Xero-ready run with any unmapped worker. The legacy GET-committed path above
// stays for the weekly panel (#126); these tests pin the new POST behaviour.
describe("POST /api/time-entries-export — finalise (#131)", () => {
  const headerOf = (res: Res) => String(res.sent).split("\n")[0];

  it("admin-tier only — a leading hand gets 403", async () => {
    const res = await callPost("u_lh", "lh", { ...WEEK, shape: "xero" });
    expect(res.statusCode).toBe(403);
  });

  it("stamps eligible rows with exportedAt + exportId, appends the run log, returns the run's xero CSV", async () => {
    mapXeroIds();
    const res = await callPost("u_admin", "office", { ...WEEK, shape: "xero" });
    expect(res.statusCode).toBe(200);
    const exportId = res.headers["X-Export-Id"];
    expect(exportId).toMatch(/^exp_/);
    expect(res.headers["X-Export-Hash"]).toMatch(/^[0-9a-f]{64}$/);

    // returns the Xero-ready CSV (the file this run pays)
    expect(headerOf(res)).toBe(
      "Pay Period Start,Pay Period End,Worker Name,Xero Employee ID,Date,Ordinary Hours,Overtime Hours,Total Hours",
    );
    expect(res.headers["Content-Disposition"]).toContain("buhlos-xero-ready-hours-2026-06-08-to-2026-06-14.csv");

    // both in-range entries stamped with THIS run; out-of-range untouched
    const w1 = blob.get("users/w1/time-entries/2026-06-09.json") as { exportedAt: string; exportId: string };
    const w2 = blob.get("users/w2/time-entries/2026-06-10.json") as { exportId: string };
    const out = blob.get("users/w1/time-entries/2026-06-01.json") as { exportId?: string };
    expect(w1.exportId).toBe(exportId);
    expect(w1.exportedAt).toMatch(/^20\d\d-\d\d-\d\d/);
    expect(w2.exportId).toBe(exportId);
    expect(out.exportId).toBeUndefined();

    // append-only run log, marked via:finalise, hash matches the header (deterministic)
    const runs = (blob.get("payroll-runs.json") as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ exportId, via: "finalise", rowCount: 2, newlyStamped: 2, alreadyExportedRows: 0 });
    expect(runs[0]!.hash).toBe(res.headers["X-Export-Hash"]);
  });

  it("is idempotent — a second finalise of the same range 409s, stamps nothing, and the original run id survives", async () => {
    mapXeroIds();
    const first = await callPost("u_admin", "office", { ...WEEK, shape: "xero" });
    const firstId = first.headers["X-Export-Id"];

    const second = await callPost("u_admin", "office", { ...WEEK, shape: "xero" });
    expect(second.statusCode).toBe(409);
    expect((second.body as { code: string }).code).toBe("all_exported");

    // original run id NOT overwritten; only ONE run logged
    const w1 = blob.get("users/w1/time-entries/2026-06-09.json") as { exportId: string };
    expect(w1.exportId).toBe(firstId);
    expect((blob.get("payroll-runs.json") as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("excludes already-exported rows — finalise stamps only the NEW ones, keeps the prior run id", async () => {
    mapXeroIds();
    // w1 already in a prior run; only w2 is eligible
    blob.set(
      "users/w1/time-entries/2026-06-09.json",
      entry("w1", "2026-06-09", { exportId: "exp_prior", exportedAt: "2026-06-08T00:00:00.000Z" }),
    );
    const res = await callPost("u_admin", "office", { ...WEEK, shape: "xero" });
    expect(res.statusCode).toBe(200);
    const exportId = res.headers["X-Export-Id"];
    const w1 = blob.get("users/w1/time-entries/2026-06-09.json") as { exportId: string };
    const w2 = blob.get("users/w2/time-entries/2026-06-10.json") as { exportId: string };
    expect(w1.exportId).toBe("exp_prior"); // untouched
    expect(w2.exportId).toBe(exportId); // newly stamped
    expect(res.headers["X-Row-Count"]).toBe("1");
    expect(res.headers["X-Already-Exported-Rows"]).toBe("1");
    const runs = (blob.get("payroll-runs.json") as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs[0]).toMatchObject({ rowCount: 1, newlyStamped: 1, alreadyExportedRows: 1 });
  });

  it("blocks when there are no approved hours (422 no_rows) — nothing stamped or logged", async () => {
    const res = await callPost("u_admin", "office", { fromDate: "2026-07-06", toDate: "2026-07-12", shape: "xero" });
    expect(res.statusCode).toBe(422);
    expect((res.body as { code: string }).code).toBe("no_rows");
    expect(blob.has("payroll-runs.json")).toBe(false);
  });

  it("blocks a Xero-ready finalise when a worker has no Xero employee id (422) — names them, stamps nothing", async () => {
    // w1/w2 are unmapped in the fixture
    const res = await callPost("u_admin", "office", { ...WEEK, shape: "xero" });
    expect(res.statusCode).toBe(422);
    const body = res.body as { code: string; unmappedWorkers: string[] };
    expect(body.code).toBe("unmapped_workers");
    expect(body.unmappedWorkers.sort()).toEqual(["w1", "w2"]);
    expect((blob.get("users/w1/time-entries/2026-06-09.json") as { exportId?: string }).exportId).toBeUndefined();
    expect(blob.has("payroll-runs.json")).toBe(false);
  });

  it("a bad range is rejected (400) before any work", async () => {
    const res = await callPost("u_admin", "office", { fromDate: "2026-06-14", toDate: "2026-06-08", shape: "xero" });
    expect(res.statusCode).toBe(400);
    expect(blob.has("payroll-runs.json")).toBe(false);
  });

  it("a review-shape finalise is NOT mapping-blocked (Review CSV doesn't promise Xero ids)", async () => {
    // w1/w2 unmapped, but shape=review → finalise proceeds and stamps
    const res = await callPost("u_admin", "office", { ...WEEK, shape: "review" });
    expect(res.statusCode).toBe(200);
    expect(headerOf(res)).toContain("Approval Status"); // review header
    expect((blob.get("users/w1/time-entries/2026-06-09.json") as { exportId?: string }).exportId).toMatch(/^exp_/);
  });
});
