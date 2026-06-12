import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #191 — api/job-blueprints.js against the real handler (mocked blob, real
 * HMAC sessions). Pins: admin-tier gating, whole-job capture (structure
 * only, no site/state), the empty-structure refusal, rename/delete
 * lifecycle, and copy semantics (delete never touches jobs).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/job-blueprints.js");

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: Handler;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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

async function call(opts: {
  method: string;
  role?: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const res = createRes();
  await handler(
    {
      method: opts.method,
      query: opts.query ?? {},
      body: opts.body,
      headers: {
        cookie: `buhl_session=${auth.signSession({
          userId: opts.userId ?? "u_admin",
          role: opts.role ?? "boss",
          exp: Date.now() + 60_000,
        })}`,
      },
    },
    res
  );
  return res;
}

function store(): Array<Record<string, unknown>> {
  return (blob.get("job-blueprints.json") as { blueprints: Array<Record<string, unknown>> })
    ?.blueprints ?? [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "boss" },
          { id: "u_lh", username: "lead", role: "leadingHand", assignedJobIds: ["j1"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["j1"] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          {
            id: "j1",
            name: "Townhouses",
            status: "active",
            siteAddress: "12 Magill Rd",
            clientUserId: "u_client",
            contractValue: 99000,
            type: "townhouse",
            modules: { snags: true },
            roughInTasks: [{ id: "rt_1", name: "Rough power" }],
            areaGroups: [
              {
                id: "ag_1",
                name: "Unit A",
                areas: [
                  { id: "ar_1", name: "Kitchen", roughInTasks: [{ id: "k1", name: "Island" }] },
                  { id: "ar_dead", name: "Old", archived: true },
                ],
              },
              { id: "ag_dead", name: "Demolished", archived: true, areas: [] },
            ],
          },
          { id: "j_empty", name: "Bare", status: "draft", areaGroups: [] },
        ],
      },
    ],
    ["job-blueprints.json", { blueprints: [] }],
  ]);
  for (const p of [blobPath, authPath, handlerPath]) delete requireFromHere.cache[p];
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
      deleteBlob: vi.fn(),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("gating", () => {
  it("admin tier only — field + LH callers 403", async () => {
    for (const role of ["electrician", "leadingHand"]) {
      const res = await call({ method: "GET", role, userId: role === "electrician" ? "u_field" : "u_lh" });
      expect(res.statusCode).toBe(403);
    }
    const admin = await call({ method: "GET" });
    expect(admin.statusCode).toBe(200);
  });
});

describe("capture", () => {
  it("captures whole-job structure only — no site/client/money/type/state", async () => {
    const res = await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", name: "Townhouse block", description: "Repeat unit shape" },
    });
    expect(res.statusCode).toBe(201);
    const bp = (res.body as { blueprint: Record<string, unknown> }).blueprint;
    expect(bp.name).toBe("Townhouse block");
    const structure = bp.structure as Record<string, unknown>;
    expect(structure.modules).toEqual({ snags: true });
    for (const banned of ["siteAddress", "clientUserId", "contractValue", "type", "status", "id"]) {
      expect(structure, banned).not.toHaveProperty(banned);
    }
    // archived group dropped; ids stripped.
    const groups = structure.areaGroups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]).not.toHaveProperty("id");
    expect((groups[0]!.areas as unknown[])).toHaveLength(1); // archived area dropped
    expect(bp.summary).toEqual({ groupCount: 1, areaCount: 1, taskCount: 2 });
  });

  it("refuses a job with no structure", async () => {
    const res = await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j_empty", name: "Nothing" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("validates name + job existence", async () => {
    expect((await call({ method: "POST", query: { action: "capture" }, body: { jobId: "j1" } })).statusCode).toBe(400);
    expect((await call({ method: "POST", query: { action: "capture" }, body: { jobId: "ghost", name: "x" } })).statusCode).toBe(404);
  });

  it("allows duplicate names (two estates, same shape) — ids disambiguate", async () => {
    await call({ method: "POST", query: { action: "capture" }, body: { jobId: "j1", name: "Same" } });
    const second = await call({ method: "POST", query: { action: "capture" }, body: { jobId: "j1", name: "Same" } });
    expect(second.statusCode).toBe(201);
    expect(store()).toHaveLength(2);
  });
});

describe("rename + delete (copy semantics)", () => {
  async function seedOne(): Promise<string> {
    const res = await call({ method: "POST", query: { action: "capture" }, body: { jobId: "j1", name: "Orig" } });
    return String((res.body as { blueprint: { id: string } }).blueprint.id);
  }

  it("renames", async () => {
    const id = await seedOne();
    const res = await call({ method: "PATCH", body: { id, name: "Renamed" } });
    expect(res.statusCode).toBe(200);
    expect(store()[0]!.name).toBe("Renamed");
  });

  it("deletes without touching jobs.json", async () => {
    const id = await seedOne();
    const jobsBefore = JSON.stringify(blob.get("jobs.json"));
    const res = await call({ method: "DELETE", query: { id } });
    expect(res.statusCode).toBe(200);
    expect(store()).toHaveLength(0);
    expect(JSON.stringify(blob.get("jobs.json"))).toBe(jobsBefore); // jobs untouched
    expect((await call({ method: "DELETE", query: { id } })).statusCode).toBe(404);
  });
});
