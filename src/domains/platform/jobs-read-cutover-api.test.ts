import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * J6/J7 seam wiring in api/jobs.js: the ADMIN tier flows through the admin PG
 * overlay; FIELD/LEADING-HAND (Phil) flow through the Phil overlay scoped to their
 * VISIBLE jobs; CLIENTS never touch either; the overlay's jobs flow into the
 * response; and each read is recorded under the right audience. The overlays' own
 * logic is covered by job-read-overlay.test.ts — here we mock them to assert wiring.
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

let adminCalls: Array<{ blobJobs: Job[] }>;
let philCalls: Array<{ blobJobs: Job[]; visibleJobIds: string[] }>;
let recordCalls: Array<{ audience: string | undefined }>;
let adminReturn: (blobJobs: Job[]) => { jobs: Job[]; diag: unknown };
let philReturn: (blobJobs: Job[]) => { jobs: Job[]; diag: unknown };

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
  adminCalls = [];
  philCalls = [];
  recordCalls = [];
  adminReturn = (blobJobs) => ({ jobs: blobJobs, diag: { readSource: "blob", reason: "flag off", fallbackUsed: false } });
  philReturn = (blobJobs) => ({ jobs: blobJobs, diag: { readSource: "blob", reason: "flag off", fallbackUsed: false } });

  blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
      // assigned to an active job AND a draft job (the draft must NOT be visible)
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-active", "job-draft"] },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-active"] },
      { id: "u_client", username: "builder", role: "client", assignedJobIds: [] },
    ] }],
    ["jobs.json", { jobs: [
      { id: "job-active", name: "Active", status: "active", clientUserId: "u_client", areaGroups: [] },
      { id: "job-other", name: "Other", status: "active", areaGroups: [] }, // active but NOT assigned to field
      { id: "job-draft", name: "Draft", status: "draft", areaGroups: [] }, // assigned to field but draft
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
        adminCalls.push(input);
        return adminReturn(input.blobJobs);
      }),
      readPhilJobsWithPgOverlay: vi.fn(async (input: { blobJobs: Job[]; visibleJobIds: string[] }) => {
        philCalls.push(input);
        return philReturn(input.blobJobs);
      }),
    },
  } as NodeJS.Module;

  requireFromHere.cache[diagPath] = {
    id: diagPath, filename: diagPath, loaded: true,
    exports: { recordJobsRead: vi.fn((_d: unknown, audience?: string) => { recordCalls.push({ audience }); }) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(jobsPath);
});

describe("J6 admin read cutover — seam wiring", () => {
  it("routes the ADMIN tier through the ADMIN overlay (not Phil), records 'admin'", async () => {
    const res = await call({ method: "GET", userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(adminCalls).toHaveLength(1);
    expect(philCalls).toHaveLength(0);
    expect(adminCalls[0]!.blobJobs.map((j) => j.id).sort()).toEqual(["job-active", "job-draft", "job-other"]);
    expect(recordCalls).toEqual([{ audience: undefined }]); // admin = default audience
  });

  it("the overlay's jobs flow into the response (admin sees overlaid data)", async () => {
    adminReturn = (blobJobs) => ({
      jobs: blobJobs.map((j) => (j.id === "job-active" ? { ...j, name: "OVERLAID" } : j)),
      diag: { readSource: "postgres", reason: "served from postgres", fallbackUsed: false },
    });
    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "job-active" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { job: { name: string } }).job.name).toBe("OVERLAID");
  });
});

describe("J7 Phil read cutover — seam wiring", () => {
  it.each([
    ["field", "u_field", "electrician"],
    ["leading hand", "u_lh", "lh"],
  ])("routes %s through the PHIL overlay scoped to visible jobs, records 'phil'", async (_label, userId, role) => {
    const res = await call({ method: "GET", userId, role });
    expect(res.statusCode).toBe(200);
    expect(philCalls).toHaveLength(1);
    expect(adminCalls).toHaveLength(0);
    expect(recordCalls).toEqual([{ audience: "phil" }]);
    // The whole Blob list is passed (the existing filter narrows downstream)…
    expect(philCalls[0]!.blobJobs.map((j) => j.id).sort()).toEqual(["job-active", "job-draft", "job-other"]);
  });

  it("scopes visibleJobIds to assigned + non-draft/archived only (no leakage of unassigned or draft jobs)", async () => {
    await call({ method: "GET", userId: "u_field", role: "electrician" });
    // u_field is assigned job-active (active) + job-draft (draft). job-other is active but unassigned.
    expect(philCalls[0]!.visibleJobIds).toEqual(["job-active"]);
  });

  it("the Phil overlay's jobs flow into the field response", async () => {
    philReturn = (blobJobs) => ({
      jobs: blobJobs.map((j) => (j.id === "job-active" ? { ...j, name: "PHIL-OVERLAID" } : j)),
      diag: { readSource: "postgres", reason: "served from postgres", fallbackUsed: false },
    });
    const res = await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "job-active" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { job: { name: string } }).job.name).toBe("PHIL-OVERLAID");
  });

  it("field worker still loads when the Phil overlay reports a Blob fallback (no outage)", async () => {
    philReturn = (blobJobs) => ({ jobs: blobJobs, diag: { readSource: "blob", reason: "error", fallbackUsed: true } });
    const res = await call({ method: "GET", userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { jobs: unknown[] }).jobs.map((j) => (j as Job).id)).toEqual(["job-active"]); // only their visible job
  });

  it("CLIENTS never touch either overlay (untouched, pure Blob)", async () => {
    const res = await call({ method: "GET", userId: "u_client", role: "client" });
    expect(res.statusCode).toBe(200);
    expect(adminCalls).toHaveLength(0);
    expect(philCalls).toHaveLength(0);
    expect(recordCalls).toHaveLength(0);
  });
});
