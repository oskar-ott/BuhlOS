import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/task-toggle.js — the field-worker task completion
 * endpoint. Exercises the real serverless handler with signed sessions and an
 * in-memory Vercel Blob replacement (same harness shape as jobs-api.test.ts).
 *
 * Focus: the safety contract a field worker depends on —
 *   - real persistence to jobs/<id>/data.json dwellings
 *   - assignment + role gates (client / unassigned blocked)
 *   - draft / archived JOB rejection (defence-in-depth vs the GET gate)
 *   - archived AREA / archived TASK rejection (match the field-visible plan)
 *   - no fabricated state: only the toggled task moves; a light audit stamp.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/task-toggle.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>,
) => Promise<unknown>;

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
  return `buhl_session=${auth.signSession({
    userId,
    role,
    exp: Date.now() + 60_000,
  })}`;
}

async function call({
  method = "POST",
  userId,
  role,
  jobId,
  body,
}: {
  method?: string;
  userId: string;
  role: string;
  jobId?: string;
  body?: unknown;
}) {
  const res = createRes();
  await handler(
    {
      method,
      query: jobId ? { jobId } : {},
      body,
      headers: { cookie: cookieFor(userId, role) },
    },
    res,
  );
  return res;
}

/** Read the persisted task map straight out of the in-memory blob. */
function persistedTasks(jobId: string, areaId: string, stage: string) {
  const data = blob.get(`jobs/${jobId}/data.json`) as
    | { dwellings?: Record<string, Record<string, { tasks?: Record<string, string> }>> }
    | undefined;
  return data?.dwellings?.[areaId]?.[stage]?.tasks ?? {};
}

const ROUGH_IN_TASKS = [
  { id: "t1", name: "Pull power" },
  { id: "t2", name: "Rough lighting" },
  { id: "t-arch", name: "Retired task", archived: true },
];

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
          {
            id: "u_field",
            username: "sparky",
            role: "electrician",
            assignedJobIds: ["job-active", "job-draft", "job-archived"],
          },
          {
            id: "u_other",
            username: "elsewhere",
            role: "electrician",
            assignedJobIds: ["job-other"],
          },
          {
            id: "u_client",
            username: "owner",
            role: "client",
            assignedJobIds: ["job-active"],
          },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          {
            id: "job-active",
            name: "Active",
            status: "active",
            roughInTasks: ROUGH_IN_TASKS,
            areaGroups: [
              {
                id: "g1",
                name: "Group",
                areas: [
                  { id: "area-1", name: "Area 1" },
                  { id: "area-arch", name: "Archived area", archived: true },
                ],
              },
              {
                id: "g-arch",
                name: "Archived group",
                archived: true,
                areas: [{ id: "area-in-arch-group", name: "Hidden" }],
              },
            ],
          },
          {
            id: "job-draft",
            name: "Draft",
            status: "draft",
            roughInTasks: [{ id: "t1", name: "Pull power" }],
            areaGroups: [
              { id: "g1", name: "Group", areas: [{ id: "area-1", name: "Area 1" }] },
            ],
          },
          {
            id: "job-archived",
            name: "Archived",
            status: "archived",
            roughInTasks: [{ id: "t1", name: "Pull power" }],
            areaGroups: [
              { id: "g1", name: "Group", areas: [{ id: "area-1", name: "Area 1" }] },
            ],
          },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

const validBody = (over: Record<string, unknown> = {}) => ({
  areaId: "area-1",
  stage: "roughIn",
  taskId: "t1",
  state: "complete",
  ...over,
});

describe("POST /api/task-toggle — happy path persistence", () => {
  it("persists a real state change to the job data blob", async () => {
    const res = await call({
      userId: "u_field",
      role: "electrician",
      jobId: "job-active",
      body: validBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ changed: true, state: "complete", previous: "not_started", by: "sparky" });
    expect(persistedTasks("job-active", "area-1", "roughIn")).toEqual({ t1: "complete" });
  });

  it("stamps a light who/when audit on the dwelling (no global activity feed)", async () => {
    await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody() });
    const data = blob.get("jobs/job-active/data.json") as {
      dwellings: Record<string, { lastTouchedBy?: string; lastTouchedAt?: string }>;
    };
    const dwelling = data.dwellings["area-1"];
    expect(dwelling?.lastTouchedBy).toBe("sparky");
    expect(typeof dwelling?.lastTouchedAt).toBe("string");
    // Only the per-job data blob was written — no new activity/audit blob key.
    expect([...blob.keys()].sort()).toEqual(
      ["jobs.json", "jobs/job-active/data.json", "users.json"],
    );
  });

  it("no-ops (changed:false) when the state already matches", async () => {
    await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody() });
    const again = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody() });
    expect(again.statusCode).toBe(200);
    expect(again.body).toMatchObject({ changed: false, state: "complete" });
  });

  it("only the toggled task moves — unrelated tasks stay untouched", async () => {
    await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ taskId: "t1" }) });
    const tasks = persistedTasks("job-active", "area-1", "roughIn");
    expect(tasks.t1).toBe("complete");
    expect(tasks.t2).toBeUndefined();
  });

  it("coerces malformed existing dwelling/task maps before writing", async () => {
    blob.set("jobs/job-active/data.json", {
      dwellings: {
        "area-1": {
          roughIn: { tasks: "not an object" },
          fitOff: "also not an object",
        },
        "area-corrupt": "not an object",
      },
    });

    const res = await call({
      userId: "u_field",
      role: "electrician",
      jobId: "job-active",
      body: validBody({ taskId: "t1", state: "complete" }),
    });

    expect(res.statusCode).toBe(200);
    expect(persistedTasks("job-active", "area-1", "roughIn")).toEqual({ t1: "complete" });
  });

  it("supports undo back to not_started", async () => {
    await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ state: "complete" }) });
    const undo = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ state: "not_started" }) });
    expect(undo.statusCode).toBe(200);
    expect(persistedTasks("job-active", "area-1", "roughIn")).toEqual({ t1: "not_started" });
  });

  it("admin (tier) can toggle on the active job", async () => {
    const res = await call({ userId: "u_admin", role: "admin", jobId: "job-active", body: validBody() });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/task-toggle — auth + role gates", () => {
  it("rejects a worker not assigned to the job (403)", async () => {
    const res = await call({ userId: "u_other", role: "electrician", jobId: "job-active", body: validBody() });
    expect(res.statusCode).toBe(403);
    expect(blob.has("jobs/job-active/data.json")).toBe(false);
  });

  it("rejects a client even when nominally assigned (403)", async () => {
    const res = await call({ userId: "u_client", role: "client", jobId: "job-active", body: validBody() });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = createRes();
    await handler({ method: "POST", query: { jobId: "job-active" }, body: validBody(), headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it("rejects non-POST methods (405)", async () => {
    const res = await call({ method: "GET", userId: "u_field", role: "electrician", jobId: "job-active", body: validBody() });
    expect(res.statusCode).toBe(405);
  });
});

describe("POST /api/task-toggle — draft / archived job rejection", () => {
  it("404s a field worker toggling a DRAFT job (office-only)", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-draft", body: validBody() });
    expect(res.statusCode).toBe(404);
    expect(blob.has("jobs/job-draft/data.json")).toBe(false);
  });

  it("404s a field worker toggling an ARCHIVED job", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-archived", body: validBody() });
    expect(res.statusCode).toBe(404);
    expect(blob.has("jobs/job-archived/data.json")).toBe(false);
  });

  it("admin (who can view drafts) CAN toggle a draft job — the gate is status+role, not structure", async () => {
    const res = await call({ userId: "u_admin", role: "admin", jobId: "job-draft", body: validBody() });
    expect(res.statusCode).toBe(200);
    expect(persistedTasks("job-draft", "area-1", "roughIn")).toEqual({ t1: "complete" });
  });
});

describe("POST /api/task-toggle — target must be field-visible", () => {
  it("404s an unknown task id", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ taskId: "ghost" }) });
    expect(res.statusCode).toBe(404);
  });

  it("404s an ARCHIVED task (matches effectiveTasks)", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ taskId: "t-arch" }) });
    expect(res.statusCode).toBe(404);
  });

  it("404s an unknown area id", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ areaId: "ghost" }) });
    expect(res.statusCode).toBe(404);
  });

  it("404s an ARCHIVED area (matches visibleAreaGroups)", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ areaId: "area-arch" }) });
    expect(res.statusCode).toBe(404);
  });

  it("404s an area inside an ARCHIVED group", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ areaId: "area-in-arch-group" }) });
    expect(res.statusCode).toBe(404);
  });

  it("404s an unknown job id", async () => {
    const res = await call({ userId: "u_admin", role: "admin", jobId: "job-nope", body: validBody() });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/task-toggle — body validation", () => {
  it("400s a missing jobId", async () => {
    const res = await call({ userId: "u_field", role: "electrician", body: validBody() });
    expect(res.statusCode).toBe(400);
  });
  it("400s an invalid stage", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ stage: "secondFix" }) });
    expect(res.statusCode).toBe(400);
  });
  it("400s an invalid state", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: validBody({ state: "kinda_done" }) });
    expect(res.statusCode).toBe(400);
  });
  it("400s a missing taskId", async () => {
    const res = await call({ userId: "u_field", role: "electrician", jobId: "job-active", body: { areaId: "area-1", stage: "roughIn", state: "complete" } });
    expect(res.statusCode).toBe(400);
  });
});
