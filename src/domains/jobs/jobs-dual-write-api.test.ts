import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * J8 seam wiring: the jobs.json structural write paths call the (real-in-prod,
 * mocked-here) best-effort PG mirror with the right jobId AFTER the Blob write,
 * and a mirror that reports failure never breaks the handler (no outage). The
 * mirror's own logic is covered by jobs-mirror.test.ts.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");
const createPath = requireFromHere.resolve("../../../api/_lib/job-create.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const mirrorPath = requireFromHere.resolve("../../../api/_lib/jobs-mirror.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let mirrorCalls: string[];
let mirrorReturn: { mirrored: boolean; reason?: string };

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
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
async function call(opts: { method: string; userId: string; role: string; query?: Record<string, string>; body?: unknown }) {
  const res = createRes();
  await handler({ method: opts.method, query: opts.query ?? {}, body: opts.body, headers: { cookie: cookieFor(opts.userId, opts.role) } }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.SUPABASE_DB_URL;
  mirrorCalls = [];
  mirrorReturn = { mirrored: false, reason: "flag off" };

  blob = new Map<string, unknown>([
    ["users.json", { users: [{ id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] }] }],
    ["job-types.json", { jobTypes: [] }],
    ["jobs.json", { jobs: [
      { id: "job-active", name: "Active", status: "active", areaGroups: [], roughInTasks: [], fitOffTasks: [] },
    ] }],
  ]);

  for (const pth of [authPath, jobsPath, createPath, auditPath, requireFromHere.resolve("../../../api/_lib/job-redaction.js")]) {
    delete requireFromHere.cache[pth];
  }

  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      deleteBlob: vi.fn(async (key: string) => { blob.delete(key); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  requireFromHere.cache[mirrorPath] = {
    id: mirrorPath, filename: mirrorPath, loaded: true,
    exports: { mirrorJobToPg: vi.fn(async (jobId: string) => { mirrorCalls.push(jobId); return mirrorReturn; }) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(jobsPath);
});

describe("J8 jobs dual-write — seam wiring", () => {
  it("POST create mirrors the NEW job's structure (after the Blob write)", async () => {
    const res = await call({ method: "POST", userId: "u_admin", role: "admin", body: { name: "Brand New Job" } });
    expect(res.statusCode).toBe(200);
    const newId = (res.body as { job: { id: string } }).job.id;
    expect(mirrorCalls).toEqual([newId]);
    // The job is actually in Blob (mirror runs after the write).
    expect((blob.get("jobs.json") as { jobs: Array<{ id: string }> }).jobs.some((j) => j.id === newId)).toBe(true);
  });

  it("PUT edit mirrors the edited job", async () => {
    const res = await call({ method: "PUT", userId: "u_admin", role: "admin", query: { id: "job-active" }, body: { id: "job-active", name: "Renamed" } });
    expect(res.statusCode).toBe(200);
    expect(mirrorCalls).toEqual(["job-active"]);
  });

  it("POST duplicate mirrors the new copy", async () => {
    const res = await call({ method: "POST", userId: "u_admin", role: "admin", query: { action: "duplicate", id: "job-active" }, body: {} });
    expect(res.statusCode).toBe(200);
    expect(mirrorCalls).toHaveLength(1);
    expect(mirrorCalls[0]).not.toBe("job-active"); // a NEW id
  });

  it("a mirror failure never breaks the save (handler still 200)", async () => {
    mirrorReturn = { mirrored: false, reason: "error" };
    const res = await call({ method: "PUT", userId: "u_admin", role: "admin", query: { id: "job-active" }, body: { id: "job-active", name: "Renamed2" } });
    expect(res.statusCode).toBe(200);
    expect((blob.get("jobs.json") as { jobs: Array<{ id: string; name: string }> }).jobs.find((j) => j.id === "job-active")?.name).toBe("Renamed2");
  });
});
