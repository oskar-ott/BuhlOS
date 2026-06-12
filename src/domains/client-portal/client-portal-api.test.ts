import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #386 — clients never see draft/archived jobs through the portal
 * endpoints. The v2 builder links clientUserId on DRAFTS, and both
 * api/client-jobs-summary.js (clientUserId-only filter) and
 * api/client-update.js (ownership-only gate) leaked their existence,
 * name, status and progress before publish.
 *
 * Real handlers, signed sessions, in-memory blob — the house harness.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const summaryPath = requireFromHere.resolve("../../../api/client-jobs-summary.js");
const updatePath = requireFromHere.resolve("../../../api/client-update.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let summaryHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let updateHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

async function call(
  handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>,
  userId: string,
  role: string,
  query: Record<string, string> = {},
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: "GET",
      query,
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
    },
    res,
  );
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["j_draft"], passwordHash: "$2a$10$x" },
      { id: "u_client", username: "builder", role: "client", passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", {
    jobs: [
      { id: "j_active", name: "Live build", status: "active", clientUserId: "u_client" },
      { id: "j_draft", name: "Secret draft", status: "draft", clientUserId: "u_client" },
      { id: "j_archived", name: "Old build", status: "archived", clientUserId: "u_client" },
    ],
  });

  for (const p of [authPath, summaryPath, updatePath]) delete requireFromHere.cache[p];
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
  summaryHandler = requireFromHere(summaryPath);
  updateHandler = requireFromHere(updatePath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client-jobs-summary (#386)", () => {
  it("a client sees ONLY their non-draft, non-archived jobs", async () => {
    const res = await call(summaryHandler, "u_client", "client");
    expect(res.statusCode).toBe(200);
    const jobs = (res.body as { jobs: Array<{ id: string }> }).jobs;
    expect(jobs.map((j) => j.id)).toEqual(["j_active"]);
    expect(JSON.stringify(res.body)).not.toContain("Secret draft");
  });

  it("admin tier still sees everything (unchanged)", async () => {
    const res = await call(summaryHandler, "u_admin", "office");
    const jobs = (res.body as { jobs: Array<{ id: string }> }).jobs;
    expect(jobs.map((j) => j.id).sort()).toEqual(["j_active", "j_archived", "j_draft"]);
  });

  it("leading hand scoping unchanged (assigned jobs)", async () => {
    const res = await call(summaryHandler, "u_lh", "lh");
    const jobs = (res.body as { jobs: Array<{ id: string }> }).jobs;
    expect(jobs.map((j) => j.id)).toEqual(["j_draft"]);
  });
});

describe("client-update (#386)", () => {
  it("a client's own ACTIVE job answers", async () => {
    const res = await call(updateHandler, "u_client", "client", { jobId: "j_active" });
    expect(res.statusCode).toBe(200);
  });

  it.each([["j_draft"], ["j_archived"]])(
    "a client's own %s job 404s — existence not confirmed",
    async (jobId) => {
      const res = await call(updateHandler, "u_client", "client", { jobId });
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Secret");
    },
  );

  it("admins still read draft updates (unchanged)", async () => {
    const res = await call(updateHandler, "u_admin", "office", { jobId: "j_draft" });
    expect(res.statusCode).toBe(200);
  });
});
