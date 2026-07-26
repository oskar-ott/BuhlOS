import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #271 — client portal foundation: strict data-isolation proof.
 *
 * The security invariant of the portal is that a client sees ONLY their own
 * active jobs, through a sanitised allowlist projection — never another
 * client's job, never a draft/archived job, never the raw job payload, and
 * never internal fields (money, notes, crew, ref, dwellings, snags). These
 * tests exercise the REAL handlers (api/portal-jobs.js, api/portal-job.js)
 * with signed sessions and an in-memory blob — the house harness.
 *
 * Field allowlist under test (api/_lib/portal-projection.js):
 *   id, name, siteAddress, status, progressPct, stageLabel — and nothing else.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const jobTasksPath = requireFromHere.resolve("../../../api/_lib/job-tasks.js");
const projectionPath = requireFromHere.resolve("../../../api/_lib/portal-projection.js");
const jobsHandlerPath = requireFromHere.resolve("../../../api/portal-jobs.js");
const jobHandlerPath = requireFromHere.resolve("../../../api/portal-job.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let jobsHandler: Handler;
let jobHandler: Handler;

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
  handler: Handler,
  session: { userId: string; role: string } | null,
  query: Record<string, string> = {},
): Promise<Res> {
  const res = createRes();
  const headers: Record<string, string> = {};
  if (session) {
    headers.cookie = `buhl_session=${auth.signSession({ ...session, exp: Date.now() + 60_000 })}`;
  }
  await handler({ method: "GET", query, headers }, res);
  return res;
}

// A job with a rough-in checklist and a data blob so progress is a real number.
function jobWithProgress(id: string, clientUserId: string, complete: number) {
  return {
    id,
    name: `Job ${id}`,
    siteAddress: `${id} Example St`,
    status: "active",
    clientUserId,
    // Internal fields that must NEVER surface through the projection.
    ref: `REF-${id}`,
    contractValue: 250000,
    marginPct: 18,
    internalNotes: "watch the margin on this one",
    accessNotes: "key under the mat",
    roughInTasks: [
      { id: "t1", name: "Rough-in A" },
      { id: "t2", name: "Rough-in B" },
    ],
    areaGroups: [{ id: "g1", areas: [{ id: "a1", name: "Unit 1" }] }],
    _complete: complete,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_field", username: "spark", role: "tradie", assignedJobIds: ["j_a1"], passwordHash: "$2a$10$x" },
      { id: "u_clientA", username: "clientA", role: "client", assignedJobIds: ["j_a1", "j_a2"], passwordHash: "$2a$10$x" },
      { id: "u_clientB", username: "clientB", role: "client", assignedJobIds: ["j_b1"], passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("jobs.json", {
    jobs: [
      jobWithProgress("j_a1", "u_clientA", 1), // 1 of 2 → 50%
      jobWithProgress("j_a2", "u_clientA", 0), // 0 of 2 → 0%
      jobWithProgress("j_b1", "u_clientB", 2), // client B's job
      // Draft + archived + complete jobs linked to client A must NEVER appear.
      { ...jobWithProgress("j_draft", "u_clientA", 0), status: "draft", name: "Secret draft" },
      { ...jobWithProgress("j_arch", "u_clientA", 0), status: "archived", name: "Old build" },
      { ...jobWithProgress("j_done", "u_clientA", 2), status: "complete", name: "Closed build" },
    ],
  });
  // Per-job data blobs: mark `_complete` rough-in tasks complete.
  for (const j of (blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> }).jobs) {
    const complete = (j._complete as number) || 0;
    const tasks: Record<string, string> = {};
    if (complete >= 1) tasks.t1 = "complete";
    if (complete >= 2) tasks.t2 = "complete";
    blob.set(`jobs/${j.id}/data.json`, { dwellings: { a1: { roughIn: { tasks } } }, snags: [] });
  }

  for (const p of [authPath, projectionPath, jobsHandlerPath, jobHandlerPath]) {
    delete requireFromHere.cache[p];
  }
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
  // job-tasks is a real dependency of the projection — leave it un-mocked so the
  // canonical progress math is what's actually exercised.
  void jobTasksPath;

  auth = requireFromHere(authPath);
  jobsHandler = requireFromHere(jobsHandlerPath);
  jobHandler = requireFromHere(jobHandlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The exact, whole allowlist the portal may serve.
const ALLOWED_KEYS = ["id", "name", "siteAddress", "status", "progressPct", "stageLabel"].sort();
// Substrings that must NEVER appear anywhere in a portal response body.
const FORBIDDEN_SUBSTRINGS = [
  "REF-", // job.ref
  "contractValue",
  "marginPct",
  "internalNotes",
  "watch the margin",
  "accessNotes",
  "key under the mat",
  "clientUserId",
  "roughInTasks",
  "areaGroups",
  "dwellings",
  "assignedJobIds",
];

function assertNoLeaks(res: Res) {
  const s = JSON.stringify(res.body);
  for (const bad of FORBIDDEN_SUBSTRINGS) {
    expect(s, `leaked "${bad}"`).not.toContain(bad);
  }
}

describe("GET /api/portal-jobs — scoped own-jobs list", () => {
  it("client A sees ONLY their own active jobs (not B's, not draft/archived/complete)", async () => {
    const res = await call(jobsHandler, { userId: "u_clientA", role: "client" });
    expect(res.statusCode).toBe(200);
    const body = res.body as { count: number; jobs: Array<{ id: string }> };
    expect(body.jobs.map((j) => j.id).sort()).toEqual(["j_a1", "j_a2"]);
    expect(body.count).toBe(2);
    // No sign of client B's job, nor the hidden-status jobs.
    const s = JSON.stringify(res.body);
    expect(s).not.toContain("j_b1");
    expect(s).not.toContain("Secret draft");
    expect(s).not.toContain("Old build");
    expect(s).not.toContain("Closed build");
  });

  it("client B sees only their own job — never client A's", async () => {
    const res = await call(jobsHandler, { userId: "u_clientB", role: "client" });
    const body = res.body as { jobs: Array<{ id: string }> };
    expect(body.jobs.map((j) => j.id)).toEqual(["j_b1"]);
    expect(JSON.stringify(res.body)).not.toContain("j_a1");
  });

  it("each job carries EXACTLY the allowlist keys — nothing internal", async () => {
    const res = await call(jobsHandler, { userId: "u_clientA", role: "client" });
    const body = res.body as { jobs: Array<Record<string, unknown>> };
    for (const job of body.jobs) {
      expect(Object.keys(job).sort()).toEqual(ALLOWED_KEYS);
    }
    assertNoLeaks(res);
  });

  it("progress is the canonical pooled-count %", async () => {
    const res = await call(jobsHandler, { userId: "u_clientA", role: "client" });
    const body = res.body as { jobs: Array<{ id: string; progressPct: number; stageLabel: string }> };
    const a1 = body.jobs.find((j) => j.id === "j_a1")!;
    const a2 = body.jobs.find((j) => j.id === "j_a2")!;
    expect(a1.progressPct).toBe(50);
    expect(a1.stageLabel).toBe("In progress");
    expect(a2.progressPct).toBe(0);
    expect(a2.stageLabel).toBe("Not started");
  });

  it("a non-client role is refused (403) — the portal is the client surface", async () => {
    for (const role of [
      { userId: "u_admin", role: "office" },
      { userId: "u_field", role: "tradie" },
    ]) {
      const res = await call(jobsHandler, role);
      expect(res.statusCode).toBe(403);
    }
  });

  it("an anonymous request is refused (401)", async () => {
    const res = await call(jobsHandler, null);
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/portal-job — single sanitised job", () => {
  it("client A opens their own active job", async () => {
    const res = await call(jobHandler, { userId: "u_clientA", role: "client" }, { jobId: "j_a1" });
    expect(res.statusCode).toBe(200);
    const job = (res.body as { job: Record<string, unknown> }).job;
    expect(job.id).toBe("j_a1");
    expect(Object.keys(job).sort()).toEqual(ALLOWED_KEYS);
    assertNoLeaks(res);
  });

  it("client A CANNOT open client B's job — 404, existence not confirmed", async () => {
    const res = await call(jobHandler, { userId: "u_clientA", role: "client" }, { jobId: "j_b1" });
    expect(res.statusCode).toBe(404);
    // No leak of B's data, and no 403 that would confirm the id is real.
    expect(JSON.stringify(res.body)).not.toContain("j_b1");
    expect(JSON.stringify(res.body)).not.toContain("Example St");
  });

  it("a guessed / non-existent id → 404", async () => {
    const res = await call(jobHandler, { userId: "u_clientA", role: "client" }, { jobId: "j_nope" });
    expect(res.statusCode).toBe(404);
  });

  it.each([["j_draft"], ["j_arch"], ["j_done"]])(
    "client A's own %s job → 404 (draft/archived/complete never served)",
    async (jobId) => {
      const res = await call(jobHandler, { userId: "u_clientA", role: "client" }, { jobId });
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Secret");
      expect(JSON.stringify(res.body)).not.toContain("Old build");
      expect(JSON.stringify(res.body)).not.toContain("Closed build");
    },
  );

  it("a non-client role is refused (403)", async () => {
    const res = await call(jobHandler, { userId: "u_admin", role: "office" }, { jobId: "j_a1" });
    expect(res.statusCode).toBe(403);
  });

  it("an anonymous request is refused (401)", async () => {
    const res = await call(jobHandler, null, { jobId: "j_a1" });
    expect(res.statusCode).toBe(401);
  });

  it("missing jobId → 400", async () => {
    const res = await call(jobHandler, { userId: "u_clientA", role: "client" });
    expect(res.statusCode).toBe(400);
  });
});
