import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normaliseLegacySnag, normaliseV2Snag } from "./register";

// Lean reset: the defects register is dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_DEFECTS = "1";
});
afterAll(() => {
  delete process.env.FLAG_DEFECTS;
});

/**
 * Integration tests for api/snags-all.js (#414) — the real serverless
 * handler against a mocked Vercel Blob store and real HMAC sessions.
 * Mirrors the observations-api.test.ts harness pattern.
 *
 * The register's TS mappers (src/domains/snags/register.ts) are used as
 * the ORACLE: every row the handler serves must equal what
 * normaliseLegacySnag / normaliseV2Snag produce for the same raw store
 * rows, so the CJS copy of the mapping inside the handler cannot drift
 * from the domain contract without failing here.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/snags-all.js");

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
  role?: string;
  userId?: string;
  query?: Record<string, string>;
  method?: string;
  anon?: boolean;
}) {
  const res = createRes();
  const req = {
    method: opts.method || "GET",
    query: opts.query || {},
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_admin", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}

// ── Fixtures: two jobs, BOTH stores populated on each ─────────────────

const LEGACY_OPEN = {
  id: "lg_open",
  desc: "Cracked plate",
  priority: "High",
  status: "Open",
  dwelling: "d1",
  by: "phil",
  createdAt: "2026-01-02T00:00:00.000Z",
  photos: [{ url: "a" }, { url: "b" }],
};
const LEGACY_CLOSED = {
  id: "lg_closed",
  desc: "Old one",
  priority: "Medium",
  status: "Closed",
  createdAt: "2025-11-01T00:00:00.000Z",
};
const V2_OPEN = {
  id: "sn_open",
  jobId: "job-1",
  title: "GPO hanging off wall",
  status: "open",
  priority: "urgent",
  areaName: "Kitchen",
  assignedToName: null,
  evidenceIds: ["ev_1"],
  createdAt: "2026-02-03T00:00:00.000Z",
};
const V2_CLOSED = {
  id: "sn_closed",
  jobId: "job-1",
  title: "Done one",
  status: "closed",
  priority: "normal",
  evidenceIds: [],
  createdAt: "2026-01-10T00:00:00.000Z",
};
const V2_REJECTED = {
  id: "sn_rejected",
  jobId: "job-1",
  title: "Not a defect",
  status: "rejected",
  priority: "low",
  rejectionReason: "by design",
  evidenceIds: [],
  createdAt: "2026-01-11T00:00:00.000Z",
};
const LEGACY_J2 = {
  id: "lg_j2",
  desc: "Loose conduit",
  priority: "Low",
  status: "Open",
  assignedToUserId: "u_field",
  assignedToName: "Sparky",
  createdAt: "2026-01-05T00:00:00.000Z",
  photos: [],
};
const V2_J2 = {
  id: "sn_j2",
  jobId: "job-2",
  title: "Switchboard label missing",
  status: "resolved",
  priority: "normal",
  assignedToId: "u_field",
  assignedToName: "Sparky",
  evidenceIds: [],
  createdAt: "2026-01-20T00:00:00.000Z",
};

const JOB_1 = {
  id: "job-1",
  name: "Birdwood",
  status: "active",
  areaGroups: [{ id: "g1", areas: [{ id: "d1", name: "Unit 1" }] }],
};
const JOB_2 = { id: "job-2", name: "Harbour" }; // no status → 'active' default

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", name: "Bossy", role: "boss", assignedJobIds: [] },
          { id: "u_lh", username: "lead", role: "leadingHand", assignedJobIds: ["job-1"] },
          { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: ["job-1"] },
          { id: "u_client", username: "client", role: "client", assignedJobIds: [] },
        ],
      },
    ],
    ["jobs.json", { jobs: [JOB_1, JOB_2] }],
    [
      "jobs/job-1/data.json",
      {
        dwellings: {},
        snags: [LEGACY_OPEN, LEGACY_CLOSED],
        snagsV2: [V2_OPEN, V2_CLOSED, V2_REJECTED],
      },
    ],
    ["jobs/job-2/data.json", { dwellings: {}, snags: [LEGACY_J2], snagsV2: [V2_J2] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
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
  handler = requireFromHere(handlerPath);
});

type Row = { id: string; [k: string]: unknown };
function ids(res: { body: unknown }): string[] {
  return ((res.body as { snags: Row[] }).snags || []).map((s) => s.id);
}

const CTX_J1 = {
  jobId: "job-1",
  jobName: "Birdwood",
  jobStatus: "active",
  areaNameById: { d1: "Unit 1" },
};
const CTX_J2 = { jobId: "job-2", jobName: "Harbour", jobStatus: "active", areaNameById: {} };

describe("GET /api/snags-all — both stores, normalised (#414)", () => {
  it("admin default view: active statuses only, both stores, both jobs — rows equal the register oracle", async () => {
    const res = await call({});
    expect(res.statusCode).toBe(200);
    // Active = open/in_progress/resolved (the domain's isActive set).
    // Sorted: priority urgent→low, then oldest createdAt first.
    expect(ids(res)).toEqual(["sn_open", "lg_open", "sn_j2", "lg_j2"]);

    const rows = (res.body as { snags: Row[] }).snags;
    expect(rows[0]).toEqual(normaliseV2Snag(V2_OPEN, CTX_J1));
    expect(rows[1]).toEqual(normaliseLegacySnag(LEGACY_OPEN, CTX_J1));
    expect(rows[2]).toEqual(normaliseV2Snag(V2_J2, CTX_J2));
    expect(rows[3]).toEqual(normaliseLegacySnag(LEGACY_J2, CTX_J2));

    // Legacy mapping spot-checks on the wire shape itself.
    expect(rows[1]).toMatchObject({
      source: "legacy",
      title: "Cracked plate",
      status: "open",
      priority: "high",
      areaName: "Unit 1",
      evidenceCount: 2,
    });
    expect((res.body as { jobs: Row[] }).jobs).toEqual([
      { id: "job-1", name: "Birdwood" },
      { id: "job-2", name: "Harbour" },
    ]);
  });

  it("?status=all serves every row including closed + rejected, active rows first", async () => {
    const res = await call({ query: { status: "all" } });
    expect(ids(res)).toEqual([
      "sn_open",
      "lg_open",
      "sn_j2",
      "lg_j2",
      // inactive tail: priority order then oldest (lg_closed predates sn_closed)
      "lg_closed",
      "sn_closed",
      "sn_rejected",
    ]);
  });

  it("?status=Closed (pre-#414 caller spelling) maps into the normalised vocabulary across both stores", async () => {
    const res = await call({ query: { status: "Closed" } });
    expect(ids(res)).toEqual(["lg_closed", "sn_closed"]);
  });

  it("?status=rejected serves the v2-only branch; unknown status falls back to the default view", async () => {
    expect(ids(await call({ query: { status: "rejected" } }))).toEqual(["sn_rejected"]);
    expect(ids(await call({ query: { status: "bogus" } }))).toEqual(
      ids(await call({}))
    );
  });

  it("?priority= filters on the normalised vocabulary (legacy Medium answers to normal)", async () => {
    expect(ids(await call({ query: { priority: "urgent" } }))).toEqual(["sn_open"]);
    expect(ids(await call({ query: { status: "all", priority: "Medium" } }))).toEqual([
      "sn_j2",
      "lg_closed",
      "sn_closed",
    ]);
  });

  it("?jobId= restricts to one job (and the jobs list with it)", async () => {
    const res = await call({ query: { jobId: "job-2" } });
    expect(ids(res)).toEqual(["sn_j2", "lg_j2"]);
    expect((res.body as { jobs: Row[] }).jobs).toEqual([{ id: "job-2", name: "Harbour" }]);
  });

  it("?assignedToUserId= matches the store-specific id fields; 'unassigned' inverts", async () => {
    expect(ids(await call({ query: { assignedToUserId: "u_field" } }))).toEqual([
      "sn_j2",
      "lg_j2",
    ]);
    expect(ids(await call({ query: { assignedToUserId: "unassigned" } }))).toEqual([
      "sn_open",
      "lg_open",
    ]);
  });

  it("LH scoping: only assignedJobIds — job-2 rows and the job itself never appear", async () => {
    const res = await call({ userId: "u_lh", role: "leadingHand", query: { status: "all" } });
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual(["sn_open", "lg_open", "lg_closed", "sn_closed", "sn_rejected"]);
    expect((res.body as { jobs: Row[] }).jobs).toEqual([{ id: "job-1", name: "Birdwood" }]);
  });

  it("refuses non-staff: field worker and client get 403, anonymous 401", async () => {
    expect((await call({ userId: "u_field", role: "electrician" })).statusCode).toBe(403);
    expect((await call({ userId: "u_client", role: "client" })).statusCode).toBe(403);
    expect((await call({ anon: true })).statusCode).toBe(401);
  });

  it("rejects non-GET methods", async () => {
    expect((await call({ method: "POST" })).statusCode).toBe(405);
  });
});
