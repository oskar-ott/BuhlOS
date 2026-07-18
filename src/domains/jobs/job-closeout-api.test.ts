import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Lean reset: closeout is dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_CLOSEOUT = "1";
});
afterAll(() => {
  delete process.env.FLAG_CLOSEOUT;
});

/**
 * #349 — GET/POST /api/job-closeout. Admin-tier only; close freezes an immutable
 * versioned snapshot (status → complete), reopen reverses it (versions kept),
 * archived → backfilled. Walks the per-user time-entry blobs via the @vercel/blob
 * list + fetch mock.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const costRatesPath = requireFromHere.resolve("../../../api/_lib/cost-rates.js");
const closeoutLibPath = requireFromHere.resolve("../../../api/_lib/job-closeout.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const handlerPath = requireFromHere.resolve("../../../api/job-closeout.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function createRes() {
  return {
    statusCode: 200, body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader() { return this; }, end() { return this; },
  };
}
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: { method?: string; role: string; userId?: string; query?: Record<string, string> }): Promise<Res> {
  const res = createRes();
  await handler({ method: opts.method || "GET", query: opts.query || {}, headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role) }, body: {} }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("jobs.json", { jobs: [{ id: "job-a", name: "Job A", status: "active", contractValue: 120000, labourEstimate: 40000, claimedToDate: 50000, startDate: "2026-01-01", dueDate: "2026-03-01" }] });
  blob.set("users.json", { users: [{ id: "u_admin", username: "boss", role: "admin" }, { id: "u_field", username: "Sparky", role: "electrician" }, { id: "u_lh", username: "Lead", role: "leadingHand" }] });
  blob.set("workforce/cost-rates.json", { rates: { u_field: [{ id: "cr1", costRateCents: 5000, chargeOutRateCents: null, effectiveFrom: "2026-01-01" }] } });
  blob.set("users/u_field/time-entries/2026-01-10.json", { userId: "u_field", date: "2026-01-10", status: "approved", allocations: [{ jobId: "job-a", hours: 8 }] });
  blob.set("users/u_field/time-entries/2026-02-20.json", { userId: "u_field", date: "2026-02-20", status: "approved", allocations: [{ jobId: "job-a", hours: 8 }] });
  blob.set("jobs/job-a/materials-list.json", { costRollup: { receivedExGst: 30000 } });
  blob.set("jobs/job-a/data.json", { snags: [{ status: "closed", createdAt: "2026-01-01", updatedAt: "2026-01-05" }, { status: "open" }] });

  for (const p of [authPath, handlerPath, costRatesPath, closeoutLibPath, auditPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fb: unknown) => (blob.has(key) ? clone(blob.get(key)) : fb)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath, filename: vercelBlobPath, loaded: true,
    exports: {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        blobs: [...blob.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ pathname: k, url: `memory://${k}` })),
      })),
      put: vi.fn(async () => ({})),
    },
  } as NodeJS.Module;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = String(url).replace(/^memory:\/\//, "").replace(/\?.*$/, "");
    if (!blob.has(key)) return { ok: false, json: async () => null };
    return { ok: true, json: async () => clone(blob.get(key)) };
  }));

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => vi.unstubAllGlobals());

const jobStatus = () => (blob.get("jobs.json") as { jobs: Array<{ id: string; status: string }> }).jobs[0]!.status;
const versions = () => ((blob.get("jobs/job-a/closeout.json") as { versions?: unknown[] } | undefined)?.versions ?? []);

describe("api/job-closeout — gate (#349)", () => {
  it("403s a leading hand", async () => {
    expect((await call({ role: "leadingHand", userId: "u_lh", query: { jobId: "job-a" } })).statusCode).toBe(403);
  });
  it("404s an unknown job", async () => {
    expect((await call({ role: "admin", query: { jobId: "nope" } })).statusCode).toBe(404);
  });
});

describe("api/job-closeout — close / reopen / re-close (#349)", () => {
  it("close freezes the snapshot, flips status to complete, writes one immutable version", async () => {
    const res = await call({ method: "POST", role: "admin", query: { jobId: "job-a", action: "close" } });
    expect(res.statusCode).toBe(201);
    const b = res.body as { status: string; snapshot: { labour: { costCents: number; hoursTotal: number }; margin: { cents: number }; duration: { actualDays: number | null }; snags: { closed: number; openNow: number } } };
    expect(b.status).toBe("complete");
    // 16h × $50 = $800 = 80000c labour; materials $30,000; contract $120,000.
    expect(b.snapshot.labour.costCents).toBe(80000);
    expect(b.snapshot.labour.hoursTotal).toBe(16);
    expect(b.snapshot.margin.cents).toBe(12_000_000 - 80000 - 3_000_000);
    expect(b.snapshot.snags.closed).toBe(1);
    expect(b.snapshot.snags.openNow).toBe(1);
    expect(jobStatus()).toBe("complete");
    expect(versions()).toHaveLength(1);
  });

  it("a second close 409s; reopen flips back to active and KEEPS the snapshot", async () => {
    await call({ method: "POST", role: "admin", query: { jobId: "job-a", action: "close" } });
    expect((await call({ method: "POST", role: "admin", query: { jobId: "job-a", action: "close" } })).statusCode).toBe(409);
    const re = await call({ method: "POST", role: "admin", query: { jobId: "job-a", action: "reopen" } });
    expect(re.statusCode).toBe(200);
    expect(jobStatus()).toBe("active");
    expect(versions()).toHaveLength(1); // snapshot kept after reopen
    // re-close appends a SECOND immutable version
    await call({ method: "POST", role: "admin", query: { jobId: "job-a", action: "close" } });
    expect(versions()).toHaveLength(2);
  });

  it("reopen 409s a job that isn't complete", async () => {
    expect((await call({ method: "POST", role: "admin", query: { jobId: "job-a", action: "reopen" } })).statusCode).toBe(409);
  });

  it("closing an archived job is allowed and marked backfilled", async () => {
    (blob.get("jobs.json") as { jobs: Array<{ status: string }> }).jobs[0]!.status = "archived";
    const res = await call({ method: "POST", role: "admin", query: { jobId: "job-a", action: "close" } });
    expect(res.statusCode).toBe(201);
    expect((res.body as { snapshot: { backfilled: boolean } }).snapshot.backfilled).toBe(true);
  });
});
