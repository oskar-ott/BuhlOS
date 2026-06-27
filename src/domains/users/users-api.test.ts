import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeAssignedJobIds } from "./assignment";

/**
 * Integration tests for the v2 job-assignment loop against the REAL serverless
 * handlers (api/users.js writes users.json; api/jobs.js reads the Phil-visible
 * list), with signed sessions and an in-memory Vercel Blob. Mirrors the harness
 * in src/domains/jobs/jobs-api.test.ts.
 *
 * Proves the mission contract end-to-end:
 *   - admin/office assign + remove a field worker (PUT /api/users)
 *   - other assignedJobIds are preserved
 *   - the assigned field worker then sees the ACTIVE job via /api/jobs (Phil)
 *   - removal hides it again; draft/archived never show even when assigned
 *   - field users cannot read or write /api/users (403)
 *   - passwordHash is never returned
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");
const usersPath = requireFromHere.resolve("../../../api/users.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let usersHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let jobsHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(
  handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>,
  {
    method,
    userId,
    role,
    query = {},
    body,
  }: {
    method: string;
    userId: string;
    role: string;
    query?: Record<string, string>;
    body?: unknown;
  }
) {
  const res = createRes();
  await handler({ method, query, body, headers: { cookie: cookieFor(userId, role) } }, res);
  return res;
}

/** Read a user's current assignedJobIds straight from the in-memory blob. */
function assignedIdsOf(userId: string): string[] {
  const data = blob.get("users.json") as { users: Array<{ id: string; assignedJobIds?: string[] }> };
  return data.users.find((u) => u.id === userId)?.assignedJobIds ?? [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", passwordHash: "$2a$10$x", assignedJobIds: [] },
          { id: "u_office", username: "office", role: "office", passwordHash: "$2a$10$x", assignedJobIds: [] },
          // Field worker pre-assigned to job-active + a second active job.
          { id: "u_field", username: "sparky", role: "electrician", passwordHash: "$2a$10$x", assignedJobIds: ["job-active", "other-job"] },
          // Unassigned field worker.
          { id: "u_field2", username: "appy", role: "tradie", passwordHash: "$2a$10$x", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "lh", passwordHash: "$2a$10$x", assignedJobIds: [] },
          { id: "u_client", username: "client", role: "client", passwordHash: "$2a$10$x", assignedJobIds: [] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-active", name: "Active site", status: "active" },
          { id: "other-job", name: "Other active", status: "active" },
          { id: "job-draft", name: "Draft job", status: "draft" },
          { id: "job-archived", name: "Archived job", status: "archived" },
        ],
      },
    ],
  ]);

  for (const p of [authPath, auditPath, usersPath, jobsPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  // Best-effort push on assign must not do real work in tests.
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { sendPushToUserId: vi.fn(async () => {}), getWebPush: vi.fn(() => null) },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  usersHandler = requireFromHere(usersPath);
  jobsHandler = requireFromHere(jobsPath);
});

/** What the assigned field worker sees in their Phil jobs list. */
async function philJobIds(userId: string, role: string): Promise<string[]> {
  const res = await call(jobsHandler, { method: "GET", userId, role });
  expect(res.statusCode).toBe(200);
  return (res.body as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id);
}

describe("GET /api/users (admin read)", () => {
  it("returns every account with passwordHash stripped", async () => {
    const res = await call(usersHandler, { method: "GET", userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    const users = (res.body as { users: Array<Record<string, unknown>> }).users;
    expect(users.length).toBe(6);
    for (const u of users) expect(u).not.toHaveProperty("passwordHash");
    // Non-field accounts ARE returned by the API — filtering to assignable
    // workers is the client's job (see assignment.ts filterAssignableWorkers).
    expect(users.map((u) => u.role)).toEqual(
      expect.arrayContaining(["admin", "office", "client", "electrician", "tradie", "lh"])
    );
  });

  it("403s a field worker (cannot read the user list)", async () => {
    const res = await call(usersHandler, { method: "GET", userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(403);
  });
});

describe("PUT /api/users — assign / remove (admin or office)", () => {
  it("admin assigns an unassigned field worker; they then see the active job in Phil", async () => {
    expect(await philJobIds("u_field2", "tradie")).toEqual([]);

    const res = await call(usersHandler, {
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "u_field2", assignedJobIds: computeAssignedJobIds([], "job-active", true) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty(["user", "passwordHash"]);
    expect(assignedIdsOf("u_field2")).toEqual(["job-active"]);
    expect(await philJobIds("u_field2", "tradie")).toEqual(["job-active"]);
  });

  it("OFFICE (admin tier, not literal 'admin') can also assign", async () => {
    const res = await call(usersHandler, {
      method: "PUT",
      userId: "u_office",
      role: "office",
      body: { id: "u_lh", assignedJobIds: computeAssignedJobIds([], "job-active", true) },
    });
    expect(res.statusCode).toBe(200);
    expect(assignedIdsOf("u_lh")).toEqual(["job-active"]);
  });

  it("removes a worker from one job while PRESERVING their other jobs", async () => {
    const next = computeAssignedJobIds(assignedIdsOf("u_field"), "job-active", false);
    const res = await call(usersHandler, {
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "u_field", assignedJobIds: next },
    });
    expect(res.statusCode).toBe(200);
    // job-active removed, other-job preserved.
    expect(assignedIdsOf("u_field")).toEqual(["other-job"]);
    // Phil now shows only the still-assigned active job, not job-active.
    expect(await philJobIds("u_field", "electrician")).toEqual(["other-job"]);
  });

  it("403s a field worker trying to assign themselves (write is admin-tier only)", async () => {
    const res = await call(usersHandler, {
      method: "PUT",
      userId: "u_field2",
      role: "tradie",
      body: { id: "u_field2", assignedJobIds: ["job-active"] },
    });
    expect(res.statusCode).toBe(403);
    expect(assignedIdsOf("u_field2")).toEqual([]); // unchanged
  });
});

describe("Phil visibility is gated on status, not just assignment", () => {
  it("never shows draft or archived jobs even when the worker is assigned to them", async () => {
    const res = await call(usersHandler, {
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "u_field2", assignedJobIds: ["job-active", "job-draft", "job-archived"] },
    });
    expect(res.statusCode).toBe(200);
    // Assigned to three jobs, but only the ACTIVE one is Phil-visible.
    expect(await philJobIds("u_field2", "tradie")).toEqual(["job-active"]);
  });
});

/**
 * GET ?action=listTradies — the assignable-worker directory behind the Gear
 * holder picker AND job assignment. The field-readiness audit found it gated on
 * literal `admin`/`leadingHand` (403'd office/boss/PM callers) and returning
 * only literal `tradie`/`leadingHand` (dropping electrician/apprentice/labourer
 * + LH aliases). These pin the normalised behaviour.
 */
describe("GET ?action=listTradies — assignable-worker directory (Gear + jobs)", () => {
  async function listTradies(userId: string, role: string) {
    return call(usersHandler, { method: "GET", userId, role, query: { action: "listTradies" } });
  }
  function rolesIn(res: Res): string[] {
    return (res.body as { users: Array<{ role: string }> }).users.map((u) => u.role).sort();
  }

  it("admin gets every field-tier worker + leading hand, never admins/office/clients", async () => {
    const res = await listTradies("u_admin", "admin");
    expect(res.statusCode).toBe(200);
    // electrician + tradie are field-tier; lh is a leading hand. office/admin/client excluded.
    expect(rolesIn(res)).toEqual(["electrician", "lh", "tradie"]);
  });

  it("OFFICE (admin tier, not literal 'admin') is allowed to call it — was a 403", async () => {
    const res = await listTradies("u_office", "office");
    expect(res.statusCode).toBe(200);
    expect(rolesIn(res)).toEqual(["electrician", "lh", "tradie"]);
  });

  it("a leading hand may call it", async () => {
    const res = await listTradies("u_lh", "lh");
    expect(res.statusCode).toBe(200);
  });

  it("a field worker CAN list workmates — the #306 handover picker", async () => {
    const res = await listTradies("u_field", "electrician");
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("403s a client", async () => {
    const res = await listTradies("u_client", "client");
    expect(res.statusCode).toBe(403);
  });

  it("strips passwordHash from every returned worker", async () => {
    const res = await listTradies("u_admin", "admin");
    const users = (res.body as { users: Array<Record<string, unknown>> }).users;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) expect(u).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("NEVER leaks the legacy hourlyRate — even to a leading hand or field worker (#304)", async () => {
    // Stamp a rate on every seeded user, the way the legacy create/update path
    // does (listTradies only ever returns field-tier + LH, so this is enough to
    // prove the rate is stripped). Set unconditionally — no literal role checks.
    for (const u of (blob.get("users.json") as { users: Array<Record<string, unknown>> }).users) {
      u.hourlyRate = 5000;
    }
    // The pay rate must be invisible to a leading hand AND a field worker (the
    // two non-admin callers of this endpoint) — the whole point of #304's store.
    for (const [userId, role] of [["u_lh", "lh"], ["u_field", "electrician"], ["u_admin", "admin"]] as const) {
      const res = await listTradies(userId, role);
      expect(res.statusCode).toBe(200);
      const users = (res.body as { users: Array<Record<string, unknown>> }).users;
      for (const u of users) expect(u).not.toHaveProperty("hourlyRate");
      expect(JSON.stringify(res.body)).not.toContain("hourlyRate");
    }
  });

  it("excludes a disabled field worker (not assignable)", async () => {
    (blob.get("users.json") as { users: Array<Record<string, unknown>> }).users.push({
      id: "u_exfield",
      username: "exfield",
      role: "tradie",
      disabled: true,
      passwordHash: "$2a$10$x",
      assignedJobIds: [],
    });
    const res = await listTradies("u_admin", "admin");
    const ids = (res.body as { users: Array<{ id: string }> }).users.map((u) => u.id);
    expect(ids).not.toContain("u_exfield");
  });
});
