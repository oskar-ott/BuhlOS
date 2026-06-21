import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task-status read seam wiring in api/data.js. The (real-in-prod, mocked-here)
 * parity overlay is reached per AUDIENCE, each behind its own flag:
 *   * FIELD/leading-hand → readPhilTaskStatus  (J10, recordTaskRead)
 *   * ADMIN/office       → readAdminTaskStatus  (J11, recordAdminTaskRead)
 *   * CLIENT (+ anything else) → pure Blob, neither overlay
 * The overlay's data flows into the response; each served read is recorded.
 * Reader isolation is the existing requireAuth({jobId}) gate (unchanged).
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const dataPath = requireFromHere.resolve("../../../api/data.js");
const trPath = requireFromHere.resolve("../../../api/_lib/task-read.js");
const trdPath = requireFromHere.resolve("../../../api/_lib/task-read-diagnostics.js");
const trdAdminPath = requireFromHere.resolve("../../../api/_lib/admin-task-read-diagnostics.js");
const erPath = requireFromHere.resolve("../../../api/_lib/evidence-read.js");
const erdPath = requireFromHere.resolve("../../../api/_lib/admin-evidence-read-diagnostics.js");

type Data = Record<string, unknown>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let philOverlayCalls: Array<{ jobId: string }>;
let adminOverlayCalls: Array<{ jobId: string }>;
let adminEvidenceCalls: Array<{ jobId: string; data: Data }>;
let recordCalls: number;
let adminRecordCalls: number;
let adminEvidenceRecordCalls: number;
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
  philOverlayCalls = []; adminOverlayCalls = []; adminEvidenceCalls = []; recordCalls = 0; adminRecordCalls = 0; adminEvidenceRecordCalls = 0;
  overlayReturn = (data) => ({ data, diag: { source: "blob", reason: "flag off" } });

  blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-1"] },
      { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
      { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
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
    exports: {
      readPhilTaskStatus: vi.fn(async (input: { jobId: string; data: Data }) => { philOverlayCalls.push(input); return overlayReturn(input.data); }),
      readAdminTaskStatus: vi.fn(async (input: { jobId: string; data: Data }) => { adminOverlayCalls.push(input); return overlayReturn(input.data); }),
    },
  } as NodeJS.Module;
  requireFromHere.cache[trdPath] = {
    id: trdPath, filename: trdPath, loaded: true,
    exports: { recordTaskRead: vi.fn(() => { recordCalls += 1; }) },
  } as NodeJS.Module;
  requireFromHere.cache[trdAdminPath] = {
    id: trdAdminPath, filename: trdAdminPath, loaded: true,
    exports: { recordAdminTaskRead: vi.fn(() => { adminRecordCalls += 1; }) },
  } as NodeJS.Module;
  requireFromHere.cache[erPath] = {
    id: erPath, filename: erPath, loaded: true,
    exports: { readAdminEvidence: vi.fn(async (input: { jobId: string; data: Data }) => { adminEvidenceCalls.push(input); return { data: input.data, diag: { source: "blob", reason: "flag off" } }; }) },
  } as NodeJS.Module;
  requireFromHere.cache[erdPath] = {
    id: erdPath, filename: erdPath, loaded: true,
    exports: { recordAdminEvidenceRead: vi.fn(() => { adminEvidenceRecordCalls += 1; }) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(dataPath);
});

describe("task-status read — /api/data seam wiring", () => {
  it.each([["field", "u_field", "electrician"], ["leading hand", "u_lh", "lh"]])(
    "routes %s through the PHIL overlay (J10) + records the read; admin overlay untouched",
    async (_l, userId, role) => {
      const res = await call({ userId, role });
      expect(res.statusCode).toBe(200);
      expect(philOverlayCalls).toEqual([{ jobId: "job-1", data: blob.get("jobs/job-1/data.json") }]);
      expect(recordCalls).toBe(1);
      expect(adminOverlayCalls).toHaveLength(0);
      expect(adminRecordCalls).toBe(0);
      expect(adminEvidenceCalls).toHaveLength(0); // evidence overlay is admin-only
      expect(adminEvidenceRecordCalls).toBe(0);
    },
  );

  it("routes ADMIN through the ADMIN task overlay (J11) THEN the evidence overlay + records both; phil untouched", async () => {
    const res = await call({ userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(adminOverlayCalls).toEqual([{ jobId: "job-1", data: blob.get("jobs/job-1/data.json") }]);
    expect(adminRecordCalls).toBe(1);
    // evidence overlay is chained AFTER the task overlay, on its output data.
    expect(adminEvidenceCalls).toEqual([{ jobId: "job-1", data: blob.get("jobs/job-1/data.json") }]);
    expect(adminEvidenceRecordCalls).toBe(1);
    expect(philOverlayCalls).toHaveLength(0);
    expect(recordCalls).toBe(0);
  });

  it("the admin evidence overlay receives the TASK overlay's output (chaining)", async () => {
    overlayReturn = (data) => ({ data: { ...data, dwellings: { a1: { roughIn: { tasks: { t1: "TASK_OVERLAID" } } } } }, diag: { source: "postgres" } });
    await call({ userId: "u_admin", role: "admin" });
    expect((adminEvidenceCalls[0]!.data as { dwellings: { a1: { roughIn: { tasks: { t1: string } } } } }).dwellings.a1.roughIn.tasks.t1).toBe("TASK_OVERLAID");
  });

  it("the phil overlay's data flows into a field response", async () => {
    overlayReturn = (data) => ({ data: { ...data, dwellings: { a1: { roughIn: { tasks: { t1: "OVERLAID" } } } } }, diag: { source: "postgres" } });
    const res = await call({ userId: "u_field", role: "electrician" });
    expect((res.body as { dwellings: { a1: { roughIn: { tasks: { t1: string } } } } }).dwellings.a1.roughIn.tasks.t1).toBe("OVERLAID");
  });

  it("the admin overlay's data flows into an admin response", async () => {
    overlayReturn = (data) => ({ data: { ...data, dwellings: { a1: { roughIn: { tasks: { t1: "OVERLAID" } } } } }, diag: { source: "postgres" } });
    const res = await call({ userId: "u_admin", role: "admin" });
    expect((res.body as { dwellings: { a1: { roughIn: { tasks: { t1: string } } } } }).dwellings.a1.roughIn.tasks.t1).toBe("OVERLAID");
  });

  it("CLIENT reads pure Blob — no overlay called (clients out of scope)", async () => {
    const res = await call({ userId: "u_client", role: "client" });
    expect(res.statusCode).toBe(200);
    expect(philOverlayCalls).toHaveLength(0);
    expect(adminOverlayCalls).toHaveLength(0);
    expect(adminEvidenceCalls).toHaveLength(0);
    expect(recordCalls).toBe(0);
    expect(adminRecordCalls).toBe(0);
    expect(adminEvidenceRecordCalls).toBe(0);
    expect((res.body as { dwellings: unknown }).dwellings).toBeTruthy();
  });

  it("an admin read still succeeds when the overlay reports a Blob fallback", async () => {
    overlayReturn = (data) => ({ data, diag: { source: "blob", reason: "error", fallbackUsed: true } });
    const res = await call({ userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { dwellings: unknown }).dwellings).toBeTruthy();
  });
});
