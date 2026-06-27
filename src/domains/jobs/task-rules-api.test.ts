import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #224 — handler tests for the two task-generation endpoints, using the
 * audit-log-api.test.ts harness shape: stateful in-memory blob mock, real
 * session signing, real handlers.
 *   - api/task-rules.js     — maintain the rule set (admin-only)
 *   - api/generate-tasks.js — apply the rules to a job's areas (+ audit)
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const rulesApiPath = requireFromHere.resolve("../../../api/task-rules.js");
const genApiPath = requireFromHere.resolve("../../../api/generate-tasks.js");

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let rulesHandler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;
let genHandler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

type Task = { id: string; name: string };
type Area = { id: string; name: string; roughInTasks?: Task[]; fitOffTasks?: Task[] };
type Group = { id: string; name: string; areas: Area[] };
type StoredJobs = { jobs: Array<{ id: string; areaGroups: Group[] }> };

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
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

function call(
  handler: typeof rulesHandler,
  opts: { method?: string; role?: string; userId?: string; query?: Record<string, string>; body?: unknown; anon?: boolean }
) {
  const res = createRes();
  const req = {
    method: opts.method || "GET",
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_admin", opts.role || "admin") },
  };
  return handler(req, res).then(() => res);
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", role: "boss", assignedJobIds: [] },
          { id: "u_lh", role: "leadingHand", assignedJobIds: ["job-1"] },
          { id: "u_field", role: "electrician", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          {
            id: "job-1",
            name: "Birdwood",
            status: "active",
            type: "t_resi",
            areaGroups: [
              {
                id: "g1",
                name: "Level 1",
                areas: [
                  { id: "a1", name: "Main Bathroom" }, // empty → fillable
                  { id: "a2", name: "Kitchen" }, // no rule → untouched
                  { id: "a3", name: "Ensuite Bathroom", roughInTasks: [{ id: "keep", name: "Existing rough" }] },
                ],
              },
            ],
          },
          { id: "job-arch", name: "Archived", status: "archived", type: "t_resi", areaGroups: [] },
        ],
      },
    ],
    ["task-rules.json", { rules: [] }],
  ]);
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[auditPath];
  delete requireFromHere.cache[rulesApiPath];
  delete requireFromHere.cache[genApiPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
  rulesHandler = requireFromHere(rulesApiPath);
  genHandler = requireFromHere(genApiPath);
});

describe("api/task-rules.js — maintain the rule set", () => {
  it("401s an unauthenticated request", async () => {
    expect((await call(rulesHandler, { anon: true })).statusCode).toBe(401);
  });

  it("403s a non-admin (field worker)", async () => {
    expect((await call(rulesHandler, { role: "electrician", userId: "u_field" })).statusCode).toBe(403);
    expect((await call(rulesHandler, { role: "leadingHand", userId: "u_lh" })).statusCode).toBe(403);
  });

  it("GET returns the current rules", async () => {
    blob.set("task-rules.json", { rules: [{ id: "tr_1", jobType: null, areaPattern: "bath", roughIn: ["x"], fitOff: [] }] });
    const res = await call(rulesHandler, { role: "boss" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it("POST save normalises + mints ids and persists", async () => {
    const res = await call(rulesHandler, {
      method: "POST",
      role: "boss",
      query: { action: "save" },
      body: { rules: [{ jobType: "t_resi", areaPattern: " bath ", roughIn: ["  Run cable ", ""], fitOff: ["Fit GPOs"] }] },
    });
    expect(res.statusCode).toBe(200);
    const saved = (res.body as { rules: Array<{ id: string; areaPattern: string; roughIn: string[] }> }).rules;
    expect(saved[0]!.id).toMatch(/^tr_/);
    expect(saved[0]!.areaPattern).toBe("bath");
    expect(saved[0]!.roughIn).toEqual(["Run cable"]);
    expect((blob.get("task-rules.json") as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it("POST save rejects a rule with no tasks (400, no write)", async () => {
    const res = await call(rulesHandler, {
      method: "POST",
      role: "boss",
      query: { action: "save" },
      body: { rules: [{ areaPattern: "bath", roughIn: [], fitOff: [] }] },
    });
    expect(res.statusCode).toBe(400);
    expect((blob.get("task-rules.json") as { rules: unknown[] }).rules).toHaveLength(0);
  });
});

describe("api/generate-tasks.js — apply rules to a job", () => {
  beforeEach(() => {
    blob.set("task-rules.json", {
      rules: [
        { id: "tr_1", jobType: "t_resi", areaPattern: "bath", roughIn: ["Rough-in points", "Run cable"], fitOff: ["Fit GPOs"] },
      ],
    });
  });

  it("401s unauth; 403s a field worker", async () => {
    expect((await call(genHandler, { method: "POST", anon: true, body: { id: "job-1" } })).statusCode).toBe(401);
    expect((await call(genHandler, { method: "POST", role: "electrician", userId: "u_field", body: { id: "job-1" } })).statusCode).toBe(403);
  });

  it("404s a missing job; 409s an archived job", async () => {
    expect((await call(genHandler, { method: "POST", role: "boss", body: { id: "nope" } })).statusCode).toBe(404);
    expect((await call(genHandler, { method: "POST", role: "boss", body: { id: "job-arch" } })).statusCode).toBe(409);
  });

  it("fill-empty fills empty matching areas, leaves non-empty + non-matching alone, writes + audits", async () => {
    const res = await call(genHandler, { method: "POST", role: "boss", userId: "u_admin", body: { id: "job-1" } });
    expect(res.statusCode).toBe(200);
    const summary = (res.body as { changed: boolean; summary: Record<string, number> });
    expect(summary.changed).toBe(true);
    expect(summary.summary.areasFilled).toBe(2); // a1 (both stages) + a3 (fit-off only)

    const stored = (blob.get("jobs.json") as StoredJobs).jobs.find((j) => j.id === "job-1")!;
    const areas = stored.areaGroups[0]!.areas;
    const a1 = areas.find((a) => a.id === "a1")!;
    const a2 = areas.find((a) => a.id === "a2")!;
    const a3 = areas.find((a) => a.id === "a3")!;
    expect(a1.roughInTasks!.map((t) => t.name)).toEqual(["Rough-in points", "Run cable"]);
    expect(a1.fitOffTasks!.map((t) => t.name)).toEqual(["Fit GPOs"]);
    expect(a2.roughInTasks ?? []).toEqual([]); // no rule
    expect(a3.roughInTasks!.map((t) => t.name)).toEqual(["Existing rough"]); // non-empty kept
    expect(a3.fitOffTasks!.map((t) => t.name)).toEqual(["Fit GPOs"]); // empty stage filled

    // canonical audit entry written for the current month
    const monthKeys = [...blob.keys()].filter((k) => k.startsWith("audit/"));
    expect(monthKeys.length).toBeGreaterThan(0);
    const entries = (blob.get(monthKeys[0]!) as { entries: Array<{ action: string; jobId: string }> }).entries;
    expect(entries.some((e) => e.action === "job.tasks_generated" && e.jobId === "job-1")).toBe(true);
  });

  it("merge mode adds generated names into a non-empty list, preserving ids by name", async () => {
    blob.set("task-rules.json", {
      rules: [{ id: "tr_1", jobType: "t_resi", areaPattern: "ensuite", roughIn: ["Existing rough", "New rough"], fitOff: [] }],
    });
    const res = await call(genHandler, { method: "POST", role: "boss", body: { id: "job-1", mode: "merge" } });
    expect(res.statusCode).toBe(200);
    const stored = (blob.get("jobs.json") as StoredJobs).jobs.find((j) => j.id === "job-1")!;
    const a3 = stored.areaGroups[0]!.areas.find((a) => a.id === "a3")!;
    expect(a3.roughInTasks!.map((t) => t.name)).toEqual(["Existing rough", "New rough"]);
    expect(a3.roughInTasks!.find((t) => t.name === "Existing rough")!.id).toBe("keep"); // id preserved
  });

  it("a no-op generation (no matching empty areas) does not write or audit", async () => {
    blob.set("task-rules.json", { rules: [{ id: "tr_1", jobType: "t_comm", areaPattern: null, roughIn: ["x"], fitOff: [] }] }); // wrong jobType
    const res = await call(genHandler, { method: "POST", role: "boss", body: { id: "job-1" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { changed: boolean }).changed).toBe(false);
    const monthKeys = [...blob.keys()].filter((k) => k.startsWith("audit/"));
    expect(monthKeys.length).toBe(0); // no audit on no-op
  });
});
