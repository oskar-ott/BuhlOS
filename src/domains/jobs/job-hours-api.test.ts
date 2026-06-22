import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/job-hours.js (#134) — the recompute-on-read per-job
 * hours endpoint. Real HMAC sessions + mocked Blob (for requireAuth's users
 * lookup) + a stubbed listAllEntriesForApprovers (the blob scan). Asserts the
 * endpoint pulls submitted+approved in ONE scan, returns only entries with an
 * allocation on the job (split days included, draft/rejected/other-job/null-job
 * excluded), gates to admin tier, and stamps `asOf`.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const tePath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const handlerPath = requireFromHere.resolve("../../../api/job-hours.js");

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let capturedStatuses: string[] | undefined;

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: { role?: string; userId?: string; query?: Record<string, string>; anon?: boolean; method?: string }) {
  const res = createRes();
  const req = {
    method: opts.method || "GET",
    query: opts.query || {},
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_boss", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}

// Scan fixture (what the blob scan would yield for submitted+approved).
const alloc = (jobId: string | null, hours: number) => ({ jobId, hours, notes: null });
const ALL_ENTRIES = [
  { id: "e1", userId: "uA", userName: "Al", date: "2026-06-01", status: "submitted", submittedAt: "t1", allocations: [alloc("job-1", 7.6)] },
  { id: "e2", userId: "uB", userName: "Bo", date: "2026-06-02", status: "approved", submittedAt: "t2", approvedAt: "t2a", allocations: [alloc("job-1", 4), alloc("job-2", 3.6)] }, // split day
  { id: "e4", userId: "uA", userName: "Al", date: "2026-06-03", status: "approved", submittedAt: "t4", allocations: [alloc("job-2", 8)] }, // other job
  { id: "e6", userId: "uC", userName: "Cy", date: "2026-06-04", status: "submitted", submittedAt: "t6", allocations: [alloc(null, 7.6)] }, // null-job (overhead)
  // draft/rejected never returned by the scan (statuses filter) — represented by absence
];

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  capturedStatuses = undefined;
  const blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
      { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
    ] }],
  ]);

  for (const p of [blobPath, authPath, tePath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async () => {}),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[tePath] = {
    id: tePath, filename: tePath, loaded: true,
    exports: {
      listAllEntriesForApprovers: vi.fn(async ({ statuses }: { statuses?: string[] }) => {
        capturedStatuses = statuses;
        const wanted = statuses || ["submitted"];
        return clone(ALL_ENTRIES.filter((e) => wanted.includes(e.status)));
      }),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

type JobHours = { jobId: string; entries: Array<{ id: string; status: string; allocations: Array<{ jobId: string | null; hours: number }> }>; asOf: string };

describe("GET /api/job-hours", () => {
  it("returns this job's submitted+approved entries (split day included), excluding other-job/null-job", async () => {
    const res = await call({ query: { jobId: "job-1" } });
    expect(res.statusCode).toBe(200);
    const body = res.body as JobHours;
    expect(body.jobId).toBe("job-1");
    expect(body.entries.map((e) => e.id)).toEqual(["e1", "e2"]); // e4 (job-2), e6 (null) excluded
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pulls submitted AND approved in ONE scan (not draft/rejected)", async () => {
    await call({ query: { jobId: "job-1" } });
    expect(capturedStatuses).toEqual(["submitted", "approved"]);
  });

  it("preserves allocations so the split day's job-1 slice can be summed", async () => {
    const res = await call({ query: { jobId: "job-1" } });
    const split = (res.body as JobHours).entries.find((e) => e.id === "e2")!;
    expect(split.allocations).toEqual([
      { jobId: "job-1", hours: 4 },
      { jobId: "job-2", hours: 3.6 },
    ]);
    expect(split.status).toBe("approved");
  });

  it("400 without jobId; 405 on non-GET", async () => {
    expect((await call({ query: {} })).statusCode).toBe(400);
    expect((await call({ method: "POST", query: { jobId: "job-1" } })).statusCode).toBe(405);
  });

  it("403 for a field worker, 401 for anon (job labour is office data)", async () => {
    expect((await call({ userId: "u_field", role: "electrician", query: { jobId: "job-1" } })).statusCode).toBe(403);
    expect((await call({ anon: true, query: { jobId: "job-1" } })).statusCode).toBe(401);
  });
});
