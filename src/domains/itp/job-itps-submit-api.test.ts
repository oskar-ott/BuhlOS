import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Lean reset: ITP / QA is dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_ITP = "1";
});
afterAll(() => {
  delete process.env.FLAG_ITP;
});

/**
 * Integration tests for POST /api/job-itps?action=submit against the REAL
 * handler — the explicit "Submit for review" step that replaced the
 * implicit in-progress → witnessed auto-advance.
 *
 * Same harness as job-itps-attach-api.test.ts: signed sessions +
 * in-memory blob via require.cache injection.
 *
 * Pins the contract the Phil + admin buttons build on:
 *   - canWrite parity: field workers + LH on the job + admin can submit;
 *     clients 403.
 *   - state machine: only an in-progress instance with EVERY required
 *     point recorded reaches witnessed; pending / witnessed / signed-off /
 *     archived / incomplete all 409 (or the documented 4xx).
 *   - only the target instance changes; the persisted payload stays valid.
 *   - record NO LONGER auto-witnesses (the behavioural change this slice
 *     introduces): recording the last required point leaves status
 *     in-progress until an explicit submit.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/job-itps.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

const RESULT = (byUserId = "u_field") => ({
  value: true,
  note: "",
  byUserId,
  byUsername: "sparky",
  at: "2026-06-17T09:00:00.000Z",
});

/** Seed one instance on jobs/j1/itps.json with the given status + results. */
function seedInstance(
  over: Record<string, unknown> = {},
  results: Record<string, unknown> = {},
) {
  blob.set("jobs/j1/itps.json", {
    instances: [
      {
        id: "itp_1",
        templateId: "tpl_x",
        status: "in-progress",
        archived: false,
        results,
        templateSnapshot: {
          name: "Rough-in QA",
          points: [
            { id: "p1", label: "Cables supported", type: "signoff", required: true },
            { id: "p2", label: "Penetrations sealed", type: "signoff", required: true },
            { id: "p3", label: "Site notes", type: "note", required: false },
          ],
        },
        createdAt: "2026-06-17T08:00:00.000Z",
        createdBy: "boss",
        updatedAt: "2026-06-17T08:30:00.000Z",
        ...over,
      },
      // A second, untouched instance to assert isolation.
      {
        id: "itp_other",
        templateId: "tpl_y",
        status: "pending",
        archived: false,
        results: {},
        templateSnapshot: { name: "Other", points: [{ id: "q1", label: "x", type: "signoff", required: true }] },
        createdAt: "2026-06-17T08:00:00.000Z",
        createdBy: "boss",
        updatedAt: "2026-06-17T08:00:00.000Z",
      },
    ],
  });
}

async function call(
  action: string,
  userId: string,
  role: string,
  body: Record<string, unknown>,
  jobId = "j1",
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId, action },
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
      body,
    },
    res,
  );
  return res;
}

const submit = (userId: string, role: string, body: Record<string, unknown>, jobId?: string) =>
  call("submit", userId, role, body, jobId);

function storedInstance(id: string): Record<string, unknown> | undefined {
  const store = blob.get("jobs/j1/itps.json") as { instances: Array<{ id: string }> };
  return store.instances.find((i) => i.id === id) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["j1"], passwordHash: "$2a$10$x" },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["j1"], passwordHash: "$2a$10$x" },
      { id: "u_client", username: "owner", role: "client", passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside", clientUserId: "u_client" }] });

  for (const p of [authPath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/job-itps?action=submit", () => {
  it("rejects a missing instanceId (400)", async () => {
    seedInstance({}, { p1: RESULT(), p2: RESULT() });
    const res = await submit("u_admin", "office", {});
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-existent instance (404)", async () => {
    seedInstance({}, { p1: RESULT(), p2: RESULT() });
    const res = await submit("u_admin", "office", { instanceId: "itp_nope" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects when required points are incomplete (409)", async () => {
    seedInstance({}, { p1: RESULT() }); // p2 still open
    const res = await submit("u_field", "electrician", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("complete all required");
    expect(storedInstance("itp_1")!.status).toBe("in-progress"); // unchanged
  });

  it("accepts a complete in-progress instance → witnessed (field worker)", async () => {
    seedInstance({}, { p1: RESULT(), p2: RESULT() });
    const res = await submit("u_field", "electrician", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { instance: { status: string } }).instance.status).toBe("witnessed");
    expect(storedInstance("itp_1")!.status).toBe("witnessed");
    // Only the target changed.
    expect(storedInstance("itp_other")!.status).toBe("pending");
  });

  it("a leading hand and the office can also submit", async () => {
    seedInstance({}, { p1: RESULT(), p2: RESULT() });
    const lh = await submit("u_lh", "lh", { instanceId: "itp_1" });
    expect(lh.statusCode).toBe(200);

    seedInstance({}, { p1: RESULT(), p2: RESULT() });
    const office = await submit("u_admin", "office", { instanceId: "itp_1" });
    expect(office.statusCode).toBe(200);
  });

  it("rejects submit from a pending instance (409 wrong status)", async () => {
    seedInstance({ status: "pending" }, {});
    const res = await submit("u_field", "electrician", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("in-progress");
  });

  it("rejects a second submit — already witnessed (409)", async () => {
    seedInstance({ status: "witnessed" }, { p1: RESULT(), p2: RESULT() });
    const res = await submit("u_admin", "office", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(409);
  });

  it("rejects submit on an archived instance (409)", async () => {
    seedInstance({ archived: true }, { p1: RESULT(), p2: RESULT() });
    const res = await submit("u_admin", "office", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("archived");
  });

  it("forbids a client from submitting (403)", async () => {
    seedInstance({}, { p1: RESULT(), p2: RESULT() });
    const res = await submit("u_client", "client", { instanceId: "itp_1" });
    expect(res.statusCode).toBe(403);
    expect(storedInstance("itp_1")!.status).toBe("in-progress"); // untouched
  });

  it("persists a schema-valid witnessed payload (stamps updatedAt, keeps results)", async () => {
    seedInstance({}, { p1: RESULT(), p2: RESULT() });
    await submit("u_admin", "office", { instanceId: "itp_1" });
    const inst = storedInstance("itp_1")!;
    expect(inst.status).toBe("witnessed");
    expect(Object.keys(inst.results as object)).toEqual(["p1", "p2"]); // results preserved
    expect(typeof inst.updatedAt).toBe("string");
    // No sign-off stamps leak in on submit.
    expect(inst.signedOffBy).toBeUndefined();
    expect(inst.signedOffAt).toBeUndefined();
  });
});

describe("record no longer auto-advances to witnessed", () => {
  it("recording the last required point leaves status in-progress (explicit submit now required)", async () => {
    seedInstance({}, { p1: RESULT() }); // p2 open, status in-progress
    const res = await call("record", "u_field", "electrician", {
      instanceId: "itp_1",
      pointId: "p2",
      value: true,
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { instance: { status: string } }).instance.status).toBe("in-progress");
    expect(storedInstance("itp_1")!.status).toBe("in-progress");
  });

  it("recording the first point still auto-advances pending → in-progress", async () => {
    seedInstance({ status: "pending" }, {});
    const res = await call("record", "u_field", "electrician", {
      instanceId: "itp_1",
      pointId: "p1",
      value: true,
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { instance: { status: string } }).instance.status).toBe("in-progress");
  });
});
