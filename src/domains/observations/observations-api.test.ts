import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for api/observations.js — the real serverless handler,
 * exercised against a mocked Vercel Blob store and real HMAC sessions.
 * Mirrors the legacy-api-auth.test.ts pattern (mock blob, sign a session,
 * call the handler). Covers create/list/update + the PR-2 permission tiers.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const obsPath = requireFromHere.resolve("../../../api/observations.js");

// Stateful in-memory blob store keyed like the real one.
let blob: Map<string, unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

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
  const token = auth.signSession({ userId, role, exp: Date.now() + 60_000 });
  return `buhl_session=${token}`;
}

async function call(opts: {
  method: string;
  role: string;
  userId?: string;
  query?: Record<string, string>;
  body?: unknown;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method,
    query: opts.query || {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_field", opts.role) },
  };
  await handler(req, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_boss", username: "boss", role: "boss", assignedJobIds: [] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-1", name: "Birdwood", areaGroups: [] }] }],
    ["jobs/job-1/data.json", { evidence: [{ id: "ev_1" }], snagsV2: [] }],
    ["observations.json", { observations: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[obsPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(obsPath);
});

describe("POST /api/observations (create)", () => {
  it("a field worker on an assigned job creates one (status new, source phil)", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-1" },
      body: { type: "blocker", title: "Cable path blocked" },
    });
    expect(res.statusCode).toBe(201);
    const obs = (res.body as { observation: Record<string, unknown> }).observation;
    expect(obs.status).toBe("new");
    expect(obs.source).toBe("phil");
    expect(obs.requiresAction).toBe(true); // blocker
    expect(obs.jobId).toBe("job-1");
    expect((blob.get("observations.json") as { observations: unknown[] }).observations).toHaveLength(1);
  });

  it("infers requiresAction=false for a plain note", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      query: { jobId: "job-1" },
      body: { type: "note", title: "Tidied up the board" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.body as { observation: { requiresAction: boolean } }).observation.requiresAction).toBe(false);
  });

  it("rejects an invalid type (400)", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      query: { jobId: "job-1" },
      body: { type: "nope", title: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing title (400)", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      query: { jobId: "job-1" },
      body: { type: "note" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("validates linkedEvidenceId against the job (400 when missing)", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      query: { jobId: "job-1" },
      body: { type: "defect", title: "x", linkedEvidenceId: "ev_missing" },
    });
    expect(res.statusCode).toBe(400);
    const ok = await call({
      method: "POST",
      role: "electrician",
      query: { jobId: "job-1" },
      body: { type: "defect", title: "x", linkedEvidenceId: "ev_1" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("403s a client", async () => {
    const res = await call({
      method: "POST",
      role: "client",
      userId: "u_client",
      query: { jobId: "job-1" },
      body: { type: "note", title: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a field worker on a job they are not assigned to", async () => {
    blob.set("jobs.json", { jobs: [{ id: "job-2", name: "Other", areaGroups: [] }] });
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-2" },
      body: { type: "note", title: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s when jobId is missing", async () => {
    const res = await call({ method: "POST", role: "boss", body: { type: "note", title: "x" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/observations", () => {
  beforeEach(() => {
    blob.set("observations.json", {
      observations: [
        { id: "o1", jobId: "job-1", type: "blocker", status: "new", priority: "high", requiresAction: true, createdAt: "2026-05-02T00:00:00Z" },
        { id: "o2", jobId: "job-2", type: "note", status: "resolved", priority: "low", requiresAction: false, createdAt: "2026-05-01T00:00:00Z" },
      ],
    });
  });

  it("cross-job inbox returns all for an admin-tier user", async () => {
    const res = await call({ method: "GET", role: "boss", userId: "u_boss" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { observations: unknown[] }).observations).toHaveLength(2);
  });

  it("cross-job inbox 403s a field worker", async () => {
    const res = await call({ method: "GET", role: "electrician", userId: "u_field" });
    expect(res.statusCode).toBe(403);
  });

  it("cross-job inbox 401s an anonymous request", async () => {
    const res = await call({ method: "GET", role: "boss", anon: true });
    expect(res.statusCode).toBe(401);
  });

  it("filters the inbox by status", async () => {
    const res = await call({ method: "GET", role: "boss", userId: "u_boss", query: { status: "new" } });
    expect((res.body as { observations: { id: string }[] }).observations.map((o) => o.id)).toEqual(["o1"]);
  });

  it("job-scoped GET returns only that job's rows for an assigned field worker", async () => {
    const res = await call({
      method: "GET",
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-1" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { observations: { id: string }[] }).observations.map((o) => o.id)).toEqual(["o1"]);
  });
});

describe("PATCH /api/observations (triage)", () => {
  beforeEach(() => {
    blob.set("observations.json", {
      observations: [
        { id: "o1", jobId: "job-1", type: "blocker", status: "new", priority: "normal", requiresAction: true, createdAt: "2026-05-02T00:00:00Z", updatedAt: "2026-05-02T00:00:00Z" },
      ],
    });
  });

  it("an admin-tier user resolves an observation (stamps resolvedBy)", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "o1", status: "resolved", resolutionNote: "Builder confirmed height" },
    });
    expect(res.statusCode).toBe(200);
    const obs = (res.body as { observation: Record<string, unknown> }).observation;
    expect(obs.status).toBe("resolved");
    expect(obs.resolvedById).toBe("u_boss");
    expect(obs.resolutionNote).toBe("Builder confirmed height");
  });

  it("conversion intent flips status to converted and stamps the actor", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "o1", convertedTo: "rfi" },
    });
    expect(res.statusCode).toBe(200);
    const obs = (res.body as { observation: Record<string, unknown> }).observation;
    expect(obs.convertedTo).toBe("rfi");
    expect(obs.status).toBe("converted");
    expect(obs.convertedById).toBe("u_boss");
  });

  it("403s a field worker trying to triage", async () => {
    const res = await call({
      method: "PATCH",
      role: "electrician",
      userId: "u_field",
      body: { id: "o1", status: "resolved" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown observation id", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "missing", status: "resolved" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s an invalid status", async () => {
    const res = await call({
      method: "PATCH",
      role: "boss",
      userId: "u_boss",
      body: { id: "o1", status: "bogus" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/observations?action=convert-to-snag (PR 6)", () => {
  beforeEach(() => {
    blob.set("observations.json", {
      observations: [
        {
          id: "od1",
          jobId: "job-1",
          jobName: "Birdwood",
          type: "defect",
          title: "Damaged light fitting at riser",
          description: "broken on arrival; needs replacement",
          status: "new",
          priority: "high",
          source: "phil",
          requiresAction: true,
          photoUrls: [],
          linkedEvidenceId: "ev_1",
          areaId: "ar_1",
          areaName: "Riser",
          stage: "fitOff",
          taskId: null,
          taskName: null,
          assignedToId: null,
          assignedToName: null,
          createdById: "u_field",
          createdByName: "Sparky",
          createdByRole: "electrician",
          createdAt: "2026-05-02T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
        },
        {
          id: "on1",
          jobId: "job-1",
          type: "note",
          title: "Tidied up the board",
          status: "new",
          priority: "low",
          source: "phil",
          requiresAction: false,
          photoUrls: [],
          createdById: "u_field",
          createdByName: "Sparky",
          createdAt: "2026-05-02T00:00:00Z",
          updatedAt: "2026-05-02T00:00:00Z",
        },
      ],
    });
  });

  it("admin converts a defect observation into a real snag and links them", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { action: "convert-to-snag" },
      body: { id: "od1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.body as {
      observation: Record<string, unknown>;
      snag: Record<string, unknown>;
    };
    expect(body.observation.linkedSnagId).toBe(body.snag.id);
    expect(body.observation.convertedTo).toBe("snag");
    expect(body.observation.convertedTargetId).toBe(body.snag.id);
    expect(body.observation.status).toBe("converted");
    expect(body.observation.convertedById).toBe("u_boss");
    expect(body.snag.title).toBe("Damaged light fitting at riser");
    expect(body.snag.status).toBe("open");
    expect(body.snag.source).toBe("admin");
    expect(body.snag.evidenceIds).toEqual(["ev_1"]);
    // Snag was actually persisted to the job's data.json.
    const data = blob.get("jobs/job-1/data.json") as { snagsV2: { id: string }[] };
    expect(data.snagsV2.map((s) => s.id)).toEqual([body.snag.id]);
  });

  it("409s a second conversion attempt (idempotent)", async () => {
    const first = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { action: "convert-to-snag" },
      body: { id: "od1" },
    });
    expect(first.statusCode).toBe(201);
    const second = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { action: "convert-to-snag" },
      body: { id: "od1" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("400s a non-default type (note) without force=true", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { action: "convert-to-snag" },
      body: { id: "on1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("201s a non-default type (note) when force=true", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { action: "convert-to-snag" },
      body: { id: "on1", force: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.body as { observation: { status: string; linkedSnagId: string } };
    expect(body.observation.status).toBe("converted");
    expect(body.observation.linkedSnagId).toMatch(/^sn_/);
  });

  it("403s a field worker trying to convert", async () => {
    const res = await call({
      method: "POST",
      role: "electrician",
      userId: "u_field",
      query: { action: "convert-to-snag" },
      body: { id: "od1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown observation id", async () => {
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { action: "convert-to-snag" },
      body: { id: "missing" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when linkedEvidenceId has been deleted from the job", async () => {
    // Simulate the evidence row vanishing between create and convert.
    const data = clone(blob.get("jobs/job-1/data.json")) as {
      evidence: { id: string }[];
      snagsV2: unknown[];
    };
    data.evidence = data.evidence.filter((e) => e.id !== "ev_1");
    blob.set("jobs/job-1/data.json", data);
    const res = await call({
      method: "POST",
      role: "boss",
      userId: "u_boss",
      query: { action: "convert-to-snag" },
      body: { id: "od1" },
    });
    expect(res.statusCode).toBe(400);
  });
});
