import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/jobs.js. These exercise the real serverless
 * handler with signed sessions and an in-memory Vercel Blob replacement.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const jobsPath = requireFromHere.resolve("../../../api/jobs.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

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
}) {
  const res = createRes();
  await handler(
    {
      method,
      query,
      body,
      headers: { cookie: cookieFor(userId, role) },
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
          { id: "u_admin", username: "admin", role: "admin", assignedJobIds: [] },
          {
            id: "u_field",
            username: "sparky",
            role: "electrician",
            assignedJobIds: ["job-active", "job-draft", "job-archived"],
          },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-active", name: "Active", status: "active" },
          { id: "job-draft", name: "Draft", status: "draft" },
          { id: "job-archived", name: "Archived", status: "archived" },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[jobsPath];
  delete requireFromHere.cache[auditPath];
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

  auth = requireFromHere(authPath);
  handler = requireFromHere(jobsPath);
});

describe("GET /api/jobs field visibility", () => {
  it("returns active jobs but hides draft and archived jobs from field lists", async () => {
    const res = await call({ method: "GET", userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { jobs: Array<{ id: string }> }).jobs.map((job) => job.id)).toEqual([
      "job-active",
    ]);
  });

  it("returns 404 for field reads of draft or archived jobs", async () => {
    for (const id of ["job-draft", "job-archived"]) {
      const res = await call({
        method: "GET",
        userId: "u_field",
        role: "electrician",
        query: { id },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("POST and PUT /api/jobs", () => {
  it("creates an office-only draft, updates it, publishes it, and parks it as draft", async () => {
    const created = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "SMOKE_TEST_api_job", status: "draft" },
    });
    expect(created.statusCode).toBe(200);
    expect((created.body as { job: { status: string } }).job.status).toBe("draft");

    const updated = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      body: { id: "smoke-test-api-job", siteAddress: "1 Test Rd" },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.body as { job: { siteAddress: string } }).job.siteAddress).toBe("1 Test Rd");

    for (const status of ["active", "draft"] as const) {
      const res = await call({
        method: "PUT",
        userId: "u_admin",
        role: "admin",
        body: { id: "smoke-test-api-job", status },
      });
      expect(res.statusCode).toBe(200);
      expect((res.body as { job: { status: string } }).job.status).toBe(status);
    }
  });

  it("blocks field users from mutating builder data", async () => {
    const res = await call({
      method: "PUT",
      userId: "u_field",
      role: "electrician",
      body: { id: "job-active", name: "Not allowed" },
    });
    expect(res.statusCode).toBe(403);
  });
});
