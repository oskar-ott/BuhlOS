import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * J10 seam wiring in api/data.js: the FIELD/Phil tier flows through the (real-in-
 * prod, mocked-here) task-status overlay; admin/clients read pure Blob; the
 * overlay's data flows into the response; each field read is recorded. Worker
 * isolation is the existing requireAuth({jobId}) gate (unchanged).
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const dataPath = requireFromHere.resolve("../../../api/data.js");
const trPath = requireFromHere.resolve("../../../api/_lib/task-read.js");
const trdPath = requireFromHere.resolve("../../../api/_lib/task-read-diagnostics.js");

type Data = Record<string, unknown>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let overlayCalls: Array<{ jobId: string }>;
let recordCalls: number;
let overlayReturn: (data: Data) => { data: Data; diag: unknown };

function clone<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
function createRes() {
  return { statusCode: 200, body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; }, setHeader() { return this; }, end() { return this; } };
}
function cookieFor(userId: string, role: string) { return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`; }
async function call(o: { userId: string; role: string; jobId?: string }) {
  const res = createRes();
  await handler({ method: "GET", query: { jobId: o.jobId ?? "job-1" }, headers: { cookie: cookieFor(o.userId, o.role) } }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.SUPABASE_DB_URL;
  overlayCalls = []; recordCalls = 0;
  overlayReturn = (data) => ({ data, diag: { source: "blob", reason: "flag off" } });

  blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-1"] },
      { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
    ] }],
    ["jobs.json", { jobs: [{ id: "job-1", name: "Job 1", status: "active", areaGroups: [] }] }],
    ["jobs/job-1/data.json", { dwellings: { a1: { roughIn: { tasks: { t1: "complete" } } } }, snags: [], notes: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[dataPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fb: unknown) => (blob.has(key) ? clone(blob.get(key)) : fb)),
      writeBlob: vi.fn(), deleteBlob: vi.fn(), setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[trPath] = {
    id: trPath, filename: trPath, loaded: true,
    exports: { readPhilTaskStatus: vi.fn(async (input: { jobId: string; data: Data }) => { overlayCalls.push(input); return overlayReturn(input.data); }) },
  } as NodeJS.Module;
  requireFromHere.cache[trdPath] = {
    id: trdPath, filename: trdPath, loaded: true,
    exports: { recordTaskRead: vi.fn(() => { recordCalls += 1; }) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(dataPath);
});

describe("J10 task-status read — /api/data seam wiring", () => {
  it.each([["field", "u_field", "electrician"], ["leading hand", "u_lh", "lh"]])(
    "routes %s through the task-status overlay (with jobId) + records the read",
    async (_l, userId, role) => {
      const res = await call({ userId, role });
      expect(res.statusCode).toBe(200);
      expect(overlayCalls).toEqual([{ jobId: "job-1", data: (blob.get("jobs/job-1/data.json")) }]);
      expect(recordCalls).toBe(1);
    },
  );

  it("the overlay's data flows into the response", async () => {
    overlayReturn = (data) => ({ data: { ...data, dwellings: { a1: { roughIn: { tasks: { t1: "OVERLAID" } } } } }, diag: { source: "postgres" } });
    const res = await call({ userId: "u_field", role: "electrician" });
    expect((res.body as { dwellings: { a1: { roughIn: { tasks: { t1: string } } } } }).dwellings.a1.roughIn.tasks.t1).toBe("OVERLAID");
  });

  it("ADMIN reads pure Blob — overlay NOT called (admin task reads = J11)", async () => {
    const res = await call({ userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(overlayCalls).toHaveLength(0);
    expect(recordCalls).toBe(0);
    expect((res.body as { dwellings: unknown }).dwellings).toBeTruthy();
  });

  it("a field read still succeeds when the overlay reports a Blob fallback", async () => {
    overlayReturn = (data) => ({ data, diag: { source: "blob", reason: "error", fallbackUsed: true } });
    const res = await call({ userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { dwellings: unknown }).dwellings).toBeTruthy();
  });
});
