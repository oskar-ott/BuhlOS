import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API contract: job attribution on POST /api/time-entries.
 *
 * A FIELD worker logging their own hours may only attribute a non-null
 * allocation jobId to a job they are assigned to that is active (not draft /
 * archived). Arbitrary, unassigned, draft or archived jobIds are rejected
 * (403). A null jobId is still accepted server-side for backward
 * compatibility (legacy submissions / overhead) — the Phil UI is what blocks
 * a null jobId when the worker has active assigned jobs.
 *
 * Admin/LH and on-behalf flows keep their existing latitude (the check is
 * scoped to non-delegated field submissions), and PR #64 approval/PATCH
 * protections are unaffected (covered by time-entries-api.test.ts).
 *
 * Harness mirrors time-entries-api.test.ts: real auth + time-entries libs,
 * an in-memory blob Map injected into the require cache.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const teLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const handlerPath = requireFromHere.resolve("../../../api/time-entries.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

const TODAY = new Date().toISOString().slice(0, 10);

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

async function post(
  userId: string,
  role: string,
  body: unknown,
  query: Record<string, string> = {},
) {
  const res = createRes();
  await handler(
    { method: "POST", query, body, headers: { cookie: cookieFor(userId, role) } },
    res,
  );
  return res;
}

function entryFor(jobId: string | null) {
  return {
    date: TODAY,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    allocations: [{ jobId, hours: 8 }],
  };
}

function storedFor(userId: string) {
  return blob.get(`users/${userId}/time-entries/${TODAY}.json`) as
    | { allocations: Array<{ jobId: string | null }> }
    | undefined;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          // field worker assigned to active + archived + draft jobs (NOT job-unassigned)
          {
            id: "u_field",
            username: "sparky",
            role: "electrician",
            assignedJobIds: ["job-active", "job-archived", "job-draft"],
          },
          { id: "u_office", username: "office", role: "office", assignedJobIds: [] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "job-active", name: "Active Job", status: "active" },
          { id: "job-archived", name: "Old Job", status: "archived" },
          { id: "job-draft", name: "Draft Job", status: "draft" },
          { id: "job-unassigned", name: "Someone Else's Job", status: "active" },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[teLibPath];
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
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/time-entries — field job attribution", () => {
  it("accepts an active job the worker is assigned to", async () => {
    const res = await post("u_field", "electrician", entryFor("job-active"));
    expect(res.statusCode).toBe(201);
    expect(storedFor("u_field")?.allocations[0]?.jobId).toBe("job-active");
  });

  it("rejects an ARCHIVED job (assigned but not active)", async () => {
    const res = await post("u_field", "electrician", entryFor("job-archived"));
    expect(res.statusCode).toBe(403);
    expect(storedFor("u_field")).toBeUndefined();
  });

  it("rejects a DRAFT job (assigned but not active)", async () => {
    const res = await post("u_field", "electrician", entryFor("job-draft"));
    expect(res.statusCode).toBe(403);
  });

  it("rejects a job the worker is NOT assigned to", async () => {
    const res = await post("u_field", "electrician", entryFor("job-unassigned"));
    expect(res.statusCode).toBe(403);
  });

  it("rejects an arbitrary / unknown jobId", async () => {
    const res = await post("u_field", "electrician", entryFor("job-does-not-exist"));
    expect(res.statusCode).toBe(403);
  });

  it("still accepts a null jobId from the field (backward-compat; UI blocks it)", async () => {
    const res = await post("u_field", "electrician", entryFor(null));
    expect(res.statusCode).toBe(201);
    expect(storedFor("u_field")?.allocations[0]?.jobId).toBeNull();
  });
});

describe("POST /api/time-entries — admin/on-behalf latitude preserved", () => {
  it("lets office log on behalf of the worker against the worker's active job", async () => {
    const res = await post("u_office", "office", entryFor("job-active"), {
      userId: "u_field",
    });
    expect(res.statusCode).toBe(201);
    expect(storedFor("u_field")?.allocations[0]?.jobId).toBe("job-active");
  });

  it("does not apply the field attribution gate to office on-behalf (job-unassigned allowed)", async () => {
    // The hours belong to the worker, but the office actor keeps latitude to
    // attribute — the field gate is intentionally scoped to non-delegated
    // field self-submissions only.
    const res = await post("u_office", "office", entryFor("job-unassigned"), {
      userId: "u_field",
    });
    expect(res.statusCode).toBe(201);
  });
});
