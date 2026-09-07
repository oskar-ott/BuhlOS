import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the PR 9 per-job activity mode of /api/audit-log.
 * Mirrors the legacy-api-auth.test.ts shape: stateful in-memory blob mock,
 * real session signing, real handler. Only the new ?scope=job branch is
 * covered here — the original row-history mode has been live since D5.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditApiPath = requireFromHere.resolve("../../../api/audit-log.js");

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

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
  method?: string;
  role: string;
  userId?: string;
  query?: Record<string, string>;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method || "GET",
    query: opts.query || {},
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_user", opts.role) },
  };
  await handler(req, res);
  return res;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // The handler reads the last N monthly blobs from Date.now(); the fixtures
  // below live in 2026-05, so the clock must stay pinned inside that window —
  // unpinned, the suite starts failing the moment the calendar rolls past June.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  // Two months of entries covering each surface, on two different jobs.
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_field", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_lh", role: "leadingHand", assignedJobIds: ["job-1"] },
          { id: "u_boss", role: "boss", assignedJobIds: [] },
          { id: "u_client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    [
      "audit/2026-05.json",
      {
        entries: [
          {
            id: "a1",
            ts: "2026-05-28T10:00:00.000Z",
            action: "evidence.captured",
            actorId: "u_field",
            actorName: "Sparky",
            actorRole: "electrician",
            jobId: "job-1",
            targetType: "evidence",
            targetId: "ev_1",
            summary: "captured rough-in",
          },
          {
            id: "a2",
            ts: "2026-05-28T11:00:00.000Z",
            action: "snag.created",
            actorId: "u_field",
            actorName: "Sparky",
            actorRole: "electrician",
            jobId: "job-1",
            targetType: "snag",
            targetId: "sn_1",
            summary: "raised damaged fitting",
          },
          {
            id: "a3",
            ts: "2026-05-29T00:00:00.000Z",
            action: "observation.converted_to_snag",
            actorId: "u_boss",
            actorName: "Boss",
            actorRole: "boss",
            jobId: "job-1",
            targetType: "observation",
            targetId: "ob_1",
            summary: "converted plan mismatch",
          },
          {
            id: "a4",
            ts: "2026-05-15T00:00:00.000Z",
            action: "evidence.captured",
            actorId: "u_field",
            actorName: "Sparky",
            actorRole: "electrician",
            jobId: "job-2",
            targetType: "evidence",
            targetId: "ev_other",
            summary: "different job",
          },
          // A job-target commercial entry (materials spend) authored by the office.
          {
            id: "a5",
            ts: "2026-05-30T00:00:00.000Z",
            action: "job.material_spend_added",
            actorId: "u_boss",
            actorName: "Boss",
            actorRole: "boss",
            jobId: "job-1",
            targetType: "job",
            targetId: "job-1",
            summary: "recorded materials spend from L&H",
            metadata: { supplier: "L&H", date: "2026-05-30" },
          },
          // A job-target entry the field worker themselves authored (their own action).
          {
            id: "a6",
            ts: "2026-05-30T01:00:00.000Z",
            action: "job.reopened",
            actorId: "u_field",
            actorName: "Sparky",
            actorRole: "electrician",
            jobId: "job-1",
            targetType: "job",
            targetId: "job-1",
            summary: "reopened",
          },
        ],
      },
    ],
  ]);
  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[auditApiPath];
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
  handler = requireFromHere(auditApiPath);
});

describe("GET /api/audit-log?scope=job (PR 9 per-job feed)", () => {
  it("admin sees every entry on the requested job, newest-first", async () => {
    const res = await call({
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", scope: "job" },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.body as { entries: { id: string; jobId: string }[] }).entries.map((e) => e.id);
    expect(ids).toEqual(["a6", "a5", "a3", "a2", "a1"]); // newest first; a6/a5 are the new job-target entries, a4 is on job-2
  });

  it("leading hand assigned to the job gets the same feed", async () => {
    const res = await call({
      role: "leadingHand",
      userId: "u_lh",
      query: { jobId: "job-1", scope: "job" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { entries: unknown[] }).entries).toHaveLength(5);
  });

  it("403s a field worker — the per-job feed is admin/LH only", async () => {
    const res = await call({
      role: "electrician",
      userId: "u_field",
      query: { jobId: "job-1", scope: "job" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a client", async () => {
    const res = await call({
      role: "client",
      userId: "u_client",
      query: { jobId: "job-1", scope: "job" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("401s an unauthenticated request", async () => {
    const res = await call({ role: "boss", anon: true, query: { jobId: "job-1", scope: "job" } });
    expect(res.statusCode).toBe(401);
  });

  it("400s a request missing jobId", async () => {
    const res = await call({ role: "boss", userId: "u_boss", query: { scope: "job" } });
    expect(res.statusCode).toBe(400);
  });

  it("filters by targetType via the types csv", async () => {
    const res = await call({
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-1", scope: "job", types: "evidence,snag" },
    });
    expect(res.statusCode).toBe(200);
    const types = (res.body as { entries: { targetType: string }[] }).entries.map(
      (e) => e.targetType
    );
    expect(types.sort()).toEqual(["evidence", "snag"]);
  });

  it("does not leak entries from other jobs", async () => {
    const res = await call({
      role: "boss",
      userId: "u_boss",
      query: { jobId: "job-2", scope: "job" },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.body as { entries: { id: string }[] }).entries.map((e) => e.id);
    expect(ids).toEqual(["a4"]);
  });

  it("the row-history mode still rejects unsupported targetTypes (unchanged)", async () => {
    const res = await call({
      role: "boss",
      userId: "u_boss",
      query: { targetType: "rfi", targetId: "rfi_1", jobId: "job-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("the row-history mode now ACCEPTS targetType=observation (PR 6 gap fix)", async () => {
    const res = await call({
      role: "boss",
      userId: "u_boss",
      query: { targetType: "observation", targetId: "ob_1", jobId: "job-1" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["a3"]);
  });

  // 2026-08-24 market-readiness (security finding A): the row-history field-role
  // narrowing used to be evidence-ONLY, so a field worker could read a JOB-target
  // feed carrying job.material_spend_added entries (supplier + date). Now a field
  // worker sees only entries on a non-evidence target where they were the actor.
  it("a field worker gets ONLY their own actions on a job-target feed — never the office's materials spend", async () => {
    const res = await call({
      role: "electrician",
      userId: "u_field",
      query: { targetType: "job", targetId: "job-1", jobId: "job-1" },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.body as { entries: { id: string }[] }).entries.map((e) => e.id);
    expect(ids).toEqual(["a6"]); // their own reopen; a5 (boss materials spend) is filtered out
  });

  it("admin still sees the full job-target feed (materials spend included)", async () => {
    const res = await call({
      role: "boss",
      userId: "u_boss",
      query: { targetType: "job", targetId: "job-1", jobId: "job-1" },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.body as { entries: { id: string }[] }).entries.map((e) => e.id);
    expect(ids).toEqual(["a6", "a5"]); // newest-first; nothing filtered for the office
  });
});

describe("GET /api/audit-log?scope=all (#220 cross-job feed)", () => {
  it("admin tier sees every job's entries, newest-first", async () => {
    const res = await call({
      role: "boss",
      userId: "u_boss",
      query: { scope: "all", months: "12" },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.body as { entries: { id: string }[] }).entries.map((e) => e.id);
    expect(ids).toEqual(["a6", "a5", "a3", "a2", "a1", "a4"]); // a6/a5 (new job-target entries) included; newest-first
  });

  it("403s a leading hand and a field worker (admin-only cross-job tool)", async () => {
    expect(
      (await call({ role: "leadingHand", userId: "u_lh", query: { scope: "all" } })).statusCode
    ).toBe(403);
    expect(
      (await call({ role: "electrician", userId: "u_field", query: { scope: "all" } })).statusCode
    ).toBe(403);
  });

  it("401s an unauthenticated request", async () => {
    expect((await call({ role: "boss", anon: true, query: { scope: "all" } })).statusCode).toBe(
      401
    );
  });

  it("filters by job, type, and actor", async () => {
    const byJob = await call({
      role: "boss",
      userId: "u_boss",
      query: { scope: "all", months: "12", jobId: "job-2" },
    });
    expect((byJob.body as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["a4"]);
    const byType = await call({
      role: "boss",
      userId: "u_boss",
      query: { scope: "all", months: "12", types: "snag" },
    });
    expect((byType.body as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual(["a2"]);
    const byActor = await call({
      role: "boss",
      userId: "u_boss",
      query: { scope: "all", months: "12", actorId: "u_boss" },
    });
    expect((byActor.body as { entries: { id: string }[] }).entries.map((e) => e.id)).toEqual([
      "a5",
      "a3",
    ]);
  });
});
