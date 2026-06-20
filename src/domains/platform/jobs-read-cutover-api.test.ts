import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * J6 seam wiring in api/jobs.js: the admin tier flows through the (real-in-prod,
 * mocked-here) PG overlay; Phil/field/clients NEVER do; the overlay's jobs flow
 * into the response; and every admin read is recorded. The overlay's own logic
 * is covered by job-read-overlay.test.ts — here we mock it to assert the wiring.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const projPath = requireFromHere.resolve("../../../api/_lib/job-read-projection.js");
const diagPath = requireFromHere.resolve("../../../api/_lib/job-read-diagnostics.js");

type Job = Record<string, unknown> & { id: string };
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

let overlayCalls: Array<{ blobJobs: Job[] }>;
let recordCalls: unknown[];
let overlayReturn: (blobJobs: Job[]) => { jobs: Job[]; diag: unknown };

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
async function call(opts: { method: string; userId: string; role: string; query?: Record<string, string> }) {
  const res = createRes();
  await handler({ method: opts.method, query: opts.query ?? {}, headers: { cookie: cookieFor(opts.userId, opts.role) } }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.SUPABASE_DB_URL;
  overlayCalls = [];
  recordCalls = [];
  overlayReturn = (blobJobs) => ({ jobs: blobJobs, diag: { readSource: "blob", reason: "flag off", fallbackUsed: false } });

  blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-active"] },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-active"] },
      { id: "u_client", username: "builder", role: "client", assignedJobIds: [] },
    ] }],
    ["jobs.json", { jobs: [
      { id: "job-active", name: "Active", status: "active", clientUserId: "u_client", areaGroups: [] },
      { id: "job-draft", name: "Draft", status: "draft", areaGroups: [] },
    ] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[jobsPath];
  delete requireFromHere.cache[requireFromHere.resolve("../../../api/_lib/job-redaction.js")];
  delete requireFromHere.cache[auditPath];

  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      deleteBlob: vi.fn(async (key: string) => { blob.delete(key); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  requireFromHere.cache[projPath] = {
    id: projPath, filename: projPath, loaded: true,
    exports: {
      readAdminJobsWithPgOverlay: vi.fn(async (input: { blobJobs: Job[] }) => {
        overlayCalls.push(input);
        return overlayReturn(input.blobJobs);
      }),
    },
  } as NodeJS.Module;

  requireFromHere.cache[diagPath] = {
    id: diagPath, filename: diagPath, loaded: true,
    exports: { recordJobsRead: vi.fn((d: unknown) => { recordCalls.push(d); }) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(jobsPath);
});

describe("J6 admin read cutover — seam wiring", () => {
  it("routes the ADMIN tier through the PG overlay with the Blob jobs", async () => {
    const res = await call({ method: "GET", userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(overlayCalls).toHaveLength(1);
    expect(overlayCalls[0]!.blobJobs.map((j) => j.id).sort()).toEqual(["job-active", "job-draft"]);
    expect(recordCalls).toHaveLength(1);
  });

  it("the overlay's jobs flow into the response (admin sees overlaid data)", async () => {
    overlayReturn = (blobJobs) => ({
      jobs: blobJobs.map((j) => (j.id === "job-active" ? { ...j, name: "OVERLAID" } : j)),
      diag: { readSource: "postgres", reason: "served from postgres", fallbackUsed: false },
    });
    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-active" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { job: { name: string } }).job.name).toBe("OVERLAID");
  });

  it("admin still loads when the overlay reports a Blob fallback (no outage)", async () => {
    overlayReturn = (blobJobs) => ({ jobs: blobJobs, diag: { readSource: "blob", reason: "error", fallbackUsed: true } });
    const res = await call({ method: "GET", userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { jobs: unknown[] }).jobs.length).toBeGreaterThan(0);
    expect(recordCalls).toHaveLength(1);
  });

  it.each([
    ["field", "u_field", "electrician"],
    ["leading hand", "u_lh", "lh"],
    ["client", "u_client", "client"],
  ])("never touches the PG overlay for %s (Phil/clients stay on Blob)", async (_label, userId, role) => {
    const res = await call({ method: "GET", userId, role });
    expect(res.statusCode).toBe(200);
    expect(overlayCalls).toHaveLength(0);
    expect(recordCalls).toHaveLength(0);
  });
});
