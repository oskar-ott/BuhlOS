import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Lean reset: the defects register is dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_DEFECTS = "1";
});
afterAll(() => {
  delete process.env.FLAG_DEFECTS;
});

/**
 * Integration tests for api/snags-bulk-close.js (#414) — the real
 * handler against a mocked blob store and real HMAC sessions, mirroring
 * the observations-api.test.ts harness.
 *
 * #414 taught the endpoint to close BOTH stores: each requested id is
 * resolved against snagsV2[] first, then the legacy snags[] array, and
 * closed with the correct semantics for its store (v2: the
 * applyTransition('closed') stamps from api/snags.js; legacy: the
 * original Closed/updatedBy shape). The per-job + canManageJob +
 * 100-cap + one-atomic-write contract is unchanged.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/snags-bulk-close.js");

let blob: Map<string, unknown>;
let writeBlobMock: Mock;

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
  jobId?: string;
  body?: unknown;
  anon?: boolean;
  method?: string;
}) {
  const res = createRes();
  const req = {
    method: opts.method || "POST",
    query: opts.jobId === undefined ? { jobId: "job-1" } : opts.jobId ? { jobId: opts.jobId } : {},
    body: opts.body,
    headers: opts.anon ? {} : { cookie: cookieFor(opts.userId || "u_admin", opts.role || "boss") },
  };
  await handler(req, res);
  return res;
}

type Snag = Record<string, unknown>;
function jobData(jobId = "job-1"): { snags: Snag[]; snagsV2: Snag[] } {
  return blob.get(`jobs/${jobId}/data.json`) as { snags: Snag[]; snagsV2: Snag[] };
}
function findV2(id: string): Snag {
  return jobData().snagsV2.find((s) => s.id === id)!;
}
function findLegacy(id: string): Snag {
  return jobData().snags.find((s) => s.id === id)!;
}

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
    [
      "jobs.json",
      { jobs: [{ id: "job-1", name: "Birdwood" }, { id: "job-2", name: "Harbour" }] },
    ],
    [
      "jobs/job-1/data.json",
      {
        dwellings: {},
        snags: [
          { id: "lg_open", desc: "Cracked plate", priority: "High", status: "Open" },
          { id: "lg_closed", desc: "Old one", status: "Closed" },
        ],
        snagsV2: [
          { id: "sn_open", title: "GPO hanging", status: "open", priority: "urgent" },
          { id: "sn_verified", title: "Verified one", status: "verified", priority: "normal" },
          { id: "sn_closed", title: "Done one", status: "closed", priority: "normal" },
          {
            id: "sn_rejected",
            title: "Not a defect",
            status: "rejected",
            rejectionReason: "by design",
          },
        ],
      },
    ],
    [
      "jobs/job-2/data.json",
      { dwellings: {}, snags: [{ id: "lg_j2", desc: "x", status: "Open" }], snagsV2: [] },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  writeBlobMock = vi.fn(async (key: string, data: unknown) => {
    blob.set(key, clone(data));
  });
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
      writeBlob: writeBlobMock,
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("POST /api/snags-bulk-close — both stores (#414)", () => {
  it("closes v2 ids with the api/snags.js closed-state stamps (status, closedAt/ById/ByName, updatedAt)", async () => {
    const res = await call({ body: { snagIds: ["sn_open", "sn_verified"] } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ jobId: "job-1", closedCount: 2, failedCount: 0 });

    for (const id of ["sn_open", "sn_verified"]) {
      const s = findV2(id);
      expect(s.status).toBe("closed");
      expect(typeof s.closedAt).toBe("string");
      expect(s.closedById).toBe("u_admin");
      expect(s.closedByName).toBe("Bossy"); // name preferred over username
      expect(s.updatedAt).toBe(s.closedAt);
    }
    const closed = (res.body as { closed: Snag[] }).closed;
    expect(closed).toEqual([
      { snagId: "sn_open", source: "v2", desc: "GPO hanging" },
      { snagId: "sn_verified", source: "v2", desc: "Verified one" },
    ]);
  });

  it("closes legacy ids with the original legacy semantics (Closed + updatedBy username)", async () => {
    const res = await call({ body: { snagIds: ["lg_open"], note: "verified on walkthrough" } });
    expect(res.statusCode).toBe(200);
    const s = findLegacy("lg_open");
    expect(s.status).toBe("Closed");
    expect(typeof s.closedAt).toBe("string");
    expect(s.updatedBy).toBe("boss");
    expect(s.closeNote).toBe("verified on walkthrough");
    expect((res.body as { closed: Snag[] }).closed).toEqual([
      { snagId: "lg_open", source: "legacy", desc: "Cracked plate" },
    ]);
  });

  it("mixed batch lands in ONE atomic write of the job's data.json", async () => {
    const res = await call({ body: { snagIds: ["sn_open", "lg_open"], note: "handover" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ closedCount: 2, failedCount: 0 });
    expect(writeBlobMock).toHaveBeenCalledTimes(1);
    expect(writeBlobMock).toHaveBeenCalledWith("jobs/job-1/data.json", expect.anything());
    expect(findV2("sn_open").status).toBe("closed");
    expect(findV2("sn_open").closeNote).toBe("handover");
    expect(findLegacy("lg_open").status).toBe("Closed");
    expect(findLegacy("lg_open").closeNote).toBe("handover");
  });

  it("reports unknown / already-closed / rejected ids per-snag — never fatal for the rest", async () => {
    const res = await call({
      body: { snagIds: ["ghost", "sn_closed", "lg_closed", "sn_rejected", "sn_open"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ closedCount: 1, failedCount: 4 });
    expect((res.body as { failed: Snag[] }).failed).toEqual([
      { snagId: "ghost", error: "not found" },
      { snagId: "sn_closed", error: "already closed" },
      { snagId: "lg_closed", error: "already closed" },
      { snagId: "sn_rejected", error: "rejected — reopen it first" },
    ]);
    expect(findV2("sn_open").status).toBe("closed");
    // The rejected snag keeps its ruling untouched.
    expect(findV2("sn_rejected").status).toBe("rejected");
  });

  it("does not write at all when nothing closed", async () => {
    const res = await call({ body: { snagIds: ["ghost", "sn_closed"] } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ closedCount: 0, failedCount: 2 });
    expect(writeBlobMock).not.toHaveBeenCalled();
  });

  it("refuses non-staff: field worker and client 403, anonymous 401", async () => {
    expect(
      (await call({ userId: "u_field", role: "electrician", body: { snagIds: ["sn_open"] } }))
        .statusCode
    ).toBe(403);
    expect(
      (await call({ userId: "u_client", role: "client", body: { snagIds: ["sn_open"] } }))
        .statusCode
    ).toBe(403);
    expect((await call({ anon: true, body: { snagIds: ["sn_open"] } })).statusCode).toBe(401);
  });

  it("LH can close on an assigned job but is refused on an unmanaged one (canManageJob)", async () => {
    const ok = await call({
      userId: "u_lh",
      role: "leadingHand",
      body: { snagIds: ["sn_open"] },
    });
    expect(ok.statusCode).toBe(200);
    expect(findV2("sn_open").closedById).toBe("u_lh");
    expect(findV2("sn_open").closedByName).toBe("lead"); // no name → username

    const refused = await call({
      userId: "u_lh",
      role: "leadingHand",
      jobId: "job-2",
      body: { snagIds: ["lg_j2"] },
    });
    expect(refused.statusCode).toBe(403);
    expect((refused.body as { error: string }).error).toBe("no access to job");
  });

  it("validates the request: jobId required, snagIds non-empty array, 100-cap", async () => {
    expect((await call({ jobId: "", body: { snagIds: ["sn_open"] } })).statusCode).toBe(400);
    expect((await call({ body: {} })).statusCode).toBe(400);
    expect((await call({ body: { snagIds: [] } })).statusCode).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => `s${i}`);
    const res = await call({ body: { snagIds: tooMany } });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toContain("max 100");
  });
});
