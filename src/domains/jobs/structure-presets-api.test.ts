import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #192 — api/structure-presets.js against the real handler (mocked blob,
 * real HMAC sessions): capture semantics (ids stripped, archived skipped,
 * no state), naming collisions, tier gating, rename/delete lifecycle.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/structure-presets.js");

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

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "boss" },
          { id: "u_lh", username: "lead", role: "leadingHand", assignedJobIds: ["j1"] },
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
            areaGroups: [
              {
                id: "ag_1",
                name: "Unit type A",
                areas: [
                  {
                    id: "ar_1",
                    name: "Kitchen",
                    spaceType: "wet area",
                    roughInTasks: [
                      { id: "rt_1", name: "Island feed" },
                      { id: "rt_2", name: "Old", archived: true },
                    ],
                  },
                  { id: "ar_2", name: "Old laundry", archived: true },
                ],
              },
              { id: "ag_dead", name: "Demolished", archived: true, areas: [] },
            ],
          },
        ],
      },
    ],
    ["structure-presets.json", { presets: [] }],
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

describe("capture (#192)", () => {
  it("captures a group with ids stripped, archived areas/tasks skipped, audit on the source job", async () => {
    const res = await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", groupId: "ag_1", name: "Townhouse unit" },
    });
    expect(res.statusCode).toBe(201);
    const preset = (res.body as {
      preset: {
        name: string;
        group: {
          name: string;
          areas: Array<{
            id?: string;
            name: string;
            spaceType?: string;
            roughInTasks: Array<{ id?: string; name: string }>;
          }>;
        };
      };
    }).preset;
    expect(preset.name).toBe("Townhouse unit");
    expect(preset.group.name).toBe("Unit type A");
    expect(preset.group.areas).toHaveLength(1); // archived laundry dropped
    const kitchen = preset.group.areas[0]!;
    expect(kitchen.name).toBe("Kitchen");
    expect(kitchen.spaceType).toBe("wet area");
    expect(kitchen.id).toBeUndefined();
    expect(kitchen.roughInTasks.map((t: { name: string }) => t.name)).toEqual(["Island feed"]);
    expect(kitchen.roughInTasks[0]!.id).toBeUndefined();
    const audit = blob.get("jobs/j1/audit.json") as { entries: Array<{ kind: string }> };
    expect(audit.entries[0]!.kind).toBe("preset.captured");
  });

  it("refuses duplicates by name (409), archived groups (400) and unknown ids (404)", async () => {
    await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", groupId: "ag_1", name: "Townhouse unit" },
    });
    const dupe = await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", groupId: "ag_1", name: "Townhouse unit" },
    });
    expect(dupe.statusCode).toBe(409);
    const archived = await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", groupId: "ag_dead", name: "Nope" },
    });
    expect(archived.statusCode).toBe(400);
    const missing = await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", groupId: "nope", name: "Nope" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("is admin-tier only — a leading hand is refused", async () => {
    const res = await call({
      method: "GET",
      role: "leadingHand",
      userId: "u_lh",
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("lifecycle", () => {
  it("lists, renames (collision-guarded) and deletes without touching jobs", async () => {
    await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", groupId: "ag_1", name: "A" },
    });
    const list = await call({ method: "GET" });
    const id = (list.body as { presets: Array<{ id: string }> }).presets[0]!.id;

    const renamed = await call({ method: "PATCH", body: { id, name: "B" } });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.body as { preset: { name: string } }).preset.name).toBe("B");

    await call({
      method: "POST",
      query: { action: "capture" },
      body: { jobId: "j1", groupId: "ag_1", name: "C" },
    });
    const collide = await call({ method: "PATCH", body: { id, name: "C" } });
    expect(collide.statusCode).toBe(409);

    const del = await call({ method: "DELETE", query: { id } });
    expect(del.statusCode).toBe(200);
    const missing = await call({ method: "DELETE", query: { id } });
    expect(missing.statusCode).toBe(404);
    // the source job is untouched throughout
    const jobs = blob.get("jobs.json") as { jobs: Array<{ areaGroups: unknown[] }> };
    expect(jobs.jobs[0]!.areaGroups).toHaveLength(2);
  });
});
