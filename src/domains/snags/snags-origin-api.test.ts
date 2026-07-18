import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Lean reset: snags are dark by default — these tests exercise the enabled behaviour.
beforeAll(() => {
  process.env.FLAG_SNAGS = "1";
});
afterAll(() => {
  delete process.env.FLAG_SNAGS;
});

/**
 * Integration tests for the #235 post-handover origin marker on api/snags.js
 * createSnag. The real handler runs against a mocked blob store + real HMAC
 * sessions, mirroring the snags-bulk-close-api.test.ts harness.
 *
 * A snag raised on or after a job's handoverDate is stamped origin:'post_handover'
 * at CREATE time and never recomputed on read — a later handover edit must not
 * rewrite the marker on existing snags.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/snags.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");

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
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function create(jobId: string, body: unknown) {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: { jobId },
      body,
      headers: { cookie: cookieFor("u_admin", "admin") },
    },
    res,
  );
  return res;
}

async function list(jobId: string) {
  const res = createRes();
  await handler(
    {
      method: "GET",
      query: { jobId },
      headers: { cookie: cookieFor("u_admin", "admin") },
    },
    res,
  );
  return res;
}

type Snag = Record<string, unknown>;
function snagsV2(jobId: string): Snag[] {
  return (blob.get(`jobs/${jobId}/data.json`) as { snagsV2: Snag[] }).snagsV2;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [{ id: "u_admin", username: "boss", name: "Bossy", role: "admin", assignedJobIds: [] }],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          // Handed over long ago → any snag raised today is post-handover.
          { id: "job-handed-over", name: "Riley House", handoverDate: "2020-01-01", defectPeriodEndsAt: "2099-12-31" },
          // Defect period already expired, but handover IS in the past → still
          // post_handover (raising after the period is allowed; label only).
          { id: "job-expired", name: "Old Job", handoverDate: "2020-01-01", defectPeriodEndsAt: "2020-03-01" },
          // No handover date → no marker (behaves exactly as today).
          { id: "job-no-dlp", name: "Live Job" },
          // Future handover → not handed over yet → no marker.
          { id: "job-future", name: "New Build", handoverDate: "2099-01-01", defectPeriodEndsAt: "2099-12-31" },
        ],
      },
    ],
    ["jobs/job-handed-over/data.json", { dwellings: {}, snags: [], snagsV2: [], evidence: [] }],
    ["jobs/job-expired/data.json", { dwellings: {}, snags: [], snagsV2: [], evidence: [] }],
    ["jobs/job-no-dlp/data.json", { dwellings: {}, snags: [], snagsV2: [], evidence: [] }],
    ["jobs/job-future/data.json", { dwellings: {}, snags: [], snagsV2: [], evidence: [] }],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  delete requireFromHere.cache[auditLogPath];
  writeBlobMock = vi.fn(async (key: string, data: unknown) => {
    blob.set(key, clone(data));
  });
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
      writeBlob: writeBlobMock,
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("#235 post-handover origin marker on snag creation", () => {
  it("stamps origin:'post_handover' when the job was handed over (in-DLP)", async () => {
    const res = await create("job-handed-over", { title: "Cracked GPO faceplate" });
    expect(res.statusCode).toBe(201);
    expect((res.body as { snagItem: Snag }).snagItem.origin).toBe("post_handover");
    expect(snagsV2("job-handed-over")[0]!.origin).toBe("post_handover");
  });

  it("stamps origin:'post_handover' even after the defect period has expired", async () => {
    const res = await create("job-expired", { title: "Late callback defect" });
    expect(res.statusCode).toBe(201);
    expect((res.body as { snagItem: Snag }).snagItem.origin).toBe("post_handover");
  });

  it("leaves origin null on a job with no handover date", async () => {
    const res = await create("job-no-dlp", { title: "Mid-build snag" });
    expect(res.statusCode).toBe(201);
    expect((res.body as { snagItem: Snag }).snagItem.origin).toBeNull();
    expect(snagsV2("job-no-dlp")[0]!.origin).toBeNull();
  });

  it("leaves origin null when handover is still in the future", async () => {
    const res = await create("job-future", { title: "Pre-handover snag" });
    expect(res.statusCode).toBe(201);
    expect((res.body as { snagItem: Snag }).snagItem.origin).toBeNull();
  });

  it("does NOT recompute the marker on read — a later handover edit can't rewrite history", async () => {
    // Create on a not-yet-handed-over job → origin null.
    await create("job-no-dlp", { title: "Raised before handover" });
    expect(snagsV2("job-no-dlp")[0]!.origin).toBeNull();

    // Office later sets a handover date in the past. The existing snag's
    // marker must NOT change on read — it records creation-time truth.
    const jobs = blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> };
    jobs.jobs.find((j) => j.id === "job-no-dlp")!.handoverDate = "2020-01-01";
    blob.set("jobs.json", jobs);

    const after = await list("job-no-dlp");
    expect(after.statusCode).toBe(200);
    const got = (after.body as { snags: Snag[] }).snags.find((s) => s.title === "Raised before handover")!;
    expect(got.origin ?? null).toBeNull();
  });
});
