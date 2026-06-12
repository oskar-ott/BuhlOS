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
