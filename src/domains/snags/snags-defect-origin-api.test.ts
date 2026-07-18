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
 * Integration tests for the #520 raised-from origin pointers on api/snags.js
 * createSnag: a snag raised straight off a failed ITP point carries
 * itpInstanceId + itpPointId; one raised off a failed TestRecord circuit
 * carries testRecordId. The real handler runs against a mocked blob store +
 * real HMAC sessions — the same harness as snags-origin-api.test.ts.
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
        jobs: [{ id: "job-1", name: "Riley House" }],
      },
    ],
    ["jobs/job-1/data.json", { dwellings: {}, snags: [], snagsV2: [], evidence: [] }],
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

describe("#520 raised-from origin pointers on snag creation", () => {
  it("persists itpInstanceId + itpPointId from a failed ITP point", async () => {
    const res = await create("job-1", {
      title: "Failed: Insulation resistance",
      description: "Reading: 0.4 MΩ. Pass: ≥ 1 MΩ.",
      itpInstanceId: "itp_abc123",
      itpPointId: "pt_1",
    });
    expect(res.statusCode).toBe(201);
    const item = (res.body as { snagItem: Snag }).snagItem;
    expect(item.itpInstanceId).toBe("itp_abc123");
    expect(item.itpPointId).toBe("pt_1");
    expect(item.testRecordId).toBeNull();
    const stored = snagsV2("job-1")[0]!;
    expect(stored.itpInstanceId).toBe("itp_abc123");
    expect(stored.itpPointId).toBe("pt_1");
  });

  it("persists testRecordId from a failed test circuit", async () => {
    const res = await create("job-1", {
      title: "Failed test: Ring final — kitchen",
      testRecordId: "tr_xyz789",
    });
    expect(res.statusCode).toBe(201);
    const item = (res.body as { snagItem: Snag }).snagItem;
    expect(item.testRecordId).toBe("tr_xyz789");
    expect(item.itpInstanceId).toBeNull();
    expect(item.itpPointId).toBeNull();
    expect(snagsV2("job-1")[0]!.testRecordId).toBe("tr_xyz789");
  });

  it("leaves all origin pointers null on a plain snag", async () => {
    const res = await create("job-1", { title: "Cracked GPO faceplate" });
    expect(res.statusCode).toBe(201);
    const item = (res.body as { snagItem: Snag }).snagItem;
    expect(item.itpInstanceId).toBeNull();
    expect(item.itpPointId).toBeNull();
    expect(item.testRecordId).toBeNull();
  });

  it("400s an itpPointId without its itpInstanceId", async () => {
    const res = await create("job-1", { title: "x", itpPointId: "pt_1" });
    expect(res.statusCode).toBe(400);
    expect(snagsV2("job-1")).toHaveLength(0);
  });

  it("400s origin ids over the junk-guard cap", async () => {
    const junk = "x".repeat(81);
    for (const key of ["itpInstanceId", "itpPointId", "testRecordId"]) {
      const res = await create("job-1", { title: "x", itpInstanceId: "ok", [key]: junk });
      expect(res.statusCode).toBe(400);
    }
    expect(snagsV2("job-1")).toHaveLength(0);
  });

  it("400s a non-string origin id", async () => {
    const res = await create("job-1", { title: "x", testRecordId: 42 });
    expect(res.statusCode).toBe(400);
  });
});
