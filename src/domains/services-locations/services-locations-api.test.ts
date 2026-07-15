import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * Integration tests for api/services-locations.js (#230). The real handler runs
 * against a mocked blob store + real HMAC sessions, mirroring the
 * snags-origin-api.test.ts harness.
 *
 * Covers: the role matrix (admin/LH/field write, client 403, PATCH/DELETE
 * admin+LH only), evidence-id-on-job validation, the photo URL denormalisation
 * (copy-at-link-time), caps (400s), audit emission, and the optional expectedRev
 * conflict surfaced as a 409 via the write guard.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const blobGuardsPath = requireFromHere.resolve("../../../api/_lib/blob-guards.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/services-locations.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");

let blob: Map<string, unknown>;
let writeBlobMock: Mock;
let auditAppendMock: Mock;

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

type Json = Record<string, unknown>;

async function call(
  method: string,
  who: { id: string; role: string },
  query: Json,
  body?: unknown,
) {
  const res = createRes();
  await handler(
    { method, query, body, headers: { cookie: cookieFor(who.id, who.role) } },
    res,
  );
  return res;
}

const ADMIN = { id: "u_admin", role: "admin" };
const LH = { id: "u_lh", role: "leadingHand" };
const FIELD = { id: "u_field", role: "tradie" };
const OTHER_FIELD = { id: "u_field2", role: "tradie" };
const CLIENT = { id: "u_client", role: "client" };

const JOB = "job-1";

function store(jobId: string): { locations: Json[] } {
  return (blob.get(`jobs/${jobId}/services-locations.json`) as { locations: Json[] }) ?? { locations: [] };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", name: "Bossy", role: "admin", assignedJobIds: [] },
          { id: "u_lh", username: "lead", name: "Leah", role: "leadingHand", assignedJobIds: ["job-1"] },
          { id: "u_field", username: "sam", name: "Sam", role: "tradie", assignedJobIds: ["job-1"] },
          { id: "u_field2", username: "dana", name: "Dana", role: "tradie", assignedJobIds: ["job-1"] },
          { id: "u_client", username: "client", name: "Client", role: "client", assignedJobIds: ["job-1"] },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-1", name: "Birdwood" }] }],
    [
      "jobs/job-1/data.json",
      {
        dwellings: {},
        snags: [],
        snagsV2: [],
        notes: [],
        // Evidence captured by Sam — a SECOND worker (Dana) would NOT see this via
        // /api/evidence (own-captures-only), which is exactly why we denormalise.
        evidence: [
          {
            id: "ev_board",
            jobId: "job-1",
            kind: "photo",
            photoId: "p_board",
            photoUrl: "https://blob/board.jpg",
            thumbnailUrl: "https://blob/board-thumb.jpg",
            capturedById: "u_field",
            capturedByName: "Sam",
            status: "submitted",
          },
        ],
      },
    ],
  ]);

  delete requireFromHere.cache[authPath];
  delete requireFromHere.cache[handlerPath];
  delete requireFromHere.cache[auditLogPath];

  writeBlobMock = vi.fn(async (key: string, data: unknown) => {
    blob.set(key, clone(data));
  });
  auditAppendMock = vi.fn(async () => ({ id: "al_1" }));

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

  // Stub the audit-log module so we can assert it was called without exercising
  // its own blob writes. The handler wraps the call in .catch, so a real one
  // would be harmless too — but the stub lets us assert the verb.
  requireFromHere.cache[auditLogPath] = {
    id: auditLogPath,
    filename: auditLogPath,
    loaded: true,
    exports: { append: auditAppendMock },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("api/services-locations.js — permissions", () => {
  it("401s an unauthenticated request", async () => {
    const res = createRes();
    await handler({ method: "GET", query: { jobId: JOB }, headers: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it("403s a client on every method", async () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const res = await call(method, CLIENT, { jobId: JOB }, { type: "meter", description: "x" });
      expect(res.statusCode).toBe(403);
    }
  });

  it("admin can add", async () => {
    const res = await call("POST", ADMIN, { jobId: JOB }, { type: "switchboard", description: "Garage." });
    expect(res.statusCode).toBe(201);
  });

  it("assigned field worker can add", async () => {
    const res = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "Front fence." });
    expect(res.statusCode).toBe(201);
  });

  it("assigned LH can add", async () => {
    const res = await call("POST", LH, { jobId: JOB }, { type: "pit", description: "Nature strip." });
    expect(res.statusCode).toBe(201);
  });

  it("now allows a field worker on any active job (all-jobs access)", async () => {
    const res = await call("POST", { id: "u_field", role: "tradie" }, { jobId: "job-other" }, { type: "meter", description: "x" });
    expect(res.statusCode).toBe(201);
  });

  it("a field worker cannot PATCH or DELETE (manage = admin + LH only)", async () => {
    const created = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "Front fence." });
    const id = (created.body as { location: Json }).location.id as string;

    const patch = await call("PATCH", FIELD, { jobId: JOB, id }, { type: "meter", description: "Moved." });
    expect(patch.statusCode).toBe(403);

    const del = await call("DELETE", FIELD, { jobId: JOB, id });
    expect(del.statusCode).toBe(403);
  });

  it("an LH CAN PATCH and DELETE (LH edit is intended)", async () => {
    const created = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "Front fence." });
    const id = (created.body as { location: Json }).location.id as string;

    const patch = await call("PATCH", LH, { jobId: JOB, id }, { type: "meter", description: "Moved to side gate." });
    expect(patch.statusCode).toBe(200);
    expect((patch.body as { location: Json }).location.description).toBe("Moved to side gate.");

    const del = await call("DELETE", LH, { jobId: JOB, id });
    expect(del.statusCode).toBe(200);
    expect(store(JOB).locations).toHaveLength(0);
  });
});

describe("api/services-locations.js — read scope (denormalisation)", () => {
  it("a SECOND worker sees the photo via the denormalised URL (not /api/evidence)", async () => {
    // Sam adds a board with his own photo.
    await call("POST", FIELD, { jobId: JOB }, {
      type: "switchboard",
      label: "Main board",
      description: "Garage, behind the door.",
      evidenceIds: ["ev_board"],
    });
    // Dana — who did NOT capture ev_board — lists and sees the photo URL.
    const res = await call("GET", OTHER_FIELD, { jobId: JOB });
    expect(res.statusCode).toBe(200);
    const locations = (res.body as { locations: Json[] }).locations;
    expect(locations).toHaveLength(1);
    const photos = locations[0]!.photos as Json[];
    expect(photos).toHaveLength(1);
    expect(photos[0]!.photoUrl).toBe("https://blob/board.jpg");
    expect(photos[0]!.thumbnailUrl).toBe("https://blob/board-thumb.jpg");
    expect(photos[0]!.capturedByName).toBe("Sam");
    expect(photos[0]!.evidenceId).toBe("ev_board");
  });

  it("text-only locations are allowed (no photos)", async () => {
    const res = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "Out the front." });
    expect(res.statusCode).toBe(201);
    expect((res.body as { location: Json }).location.photos).toEqual([]);
  });
});

describe("api/services-locations.js — validation + caps", () => {
  it("400s a missing/blank description (mandatory)", async () => {
    const a = await call("POST", FIELD, { jobId: JOB }, { type: "meter" });
    expect(a.statusCode).toBe(400);
    const b = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "   " });
    expect(b.statusCode).toBe(400);
  });

  it("400s an unknown type", async () => {
    const res = await call("POST", FIELD, { jobId: JOB }, { type: "transformer", description: "x" });
    expect(res.statusCode).toBe(400);
  });

  it("400s an evidenceId that isn't on this job", async () => {
    const res = await call("POST", FIELD, { jobId: JOB }, {
      type: "meter",
      description: "x",
      evidenceIds: ["ev_does_not_exist"],
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain("ev_does_not_exist");
  });

  it("400s a description over the 1000 cap", async () => {
    const res = await call("POST", FIELD, { jobId: JOB }, {
      type: "meter",
      description: "x".repeat(1001),
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a label over the 120 cap", async () => {
    const res = await call("POST", FIELD, { jobId: JOB }, {
      type: "meter",
      label: "x".repeat(121),
      description: "ok",
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s more than 5 photos on one location", async () => {
    const res = await call("POST", FIELD, { jobId: JOB }, {
      type: "meter",
      description: "ok",
      evidenceIds: ["a", "b", "c", "d", "e", "f"],
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s the 31st location on a job", async () => {
    blob.set(`jobs/${JOB}/services-locations.json`, {
      locations: Array.from({ length: 30 }, (_, i) => ({
        id: `sl_${i}`,
        type: "other",
        label: null,
        description: "x",
        photos: [],
        createdBy: "x",
        createdById: "x",
        createdAt: "2026-01-01",
        updatedBy: "x",
        updatedById: "x",
        updatedAt: "2026-01-01",
      })),
    });
    const res = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "one too many" });
    expect(res.statusCode).toBe(400);
  });
});

describe("api/services-locations.js — audit", () => {
  it("emits service_location.added on POST", async () => {
    await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "Front fence." });
    expect(auditAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "service_location.added",
        targetType: "service_location",
        jobId: JOB,
      }),
    );
  });

  it("emits service_location.updated on PATCH and service_location.removed on DELETE", async () => {
    const created = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "Front fence." });
    const id = (created.body as { location: Json }).location.id as string;
    auditAppendMock.mockClear();

    await call("PATCH", LH, { jobId: JOB, id }, { type: "meter", description: "Moved." });
    expect(auditAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service_location.updated" }),
    );
    auditAppendMock.mockClear();

    await call("DELETE", LH, { jobId: JOB, id });
    expect(auditAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service_location.removed" }),
    );
  });
});

describe("api/services-locations.js — optional expectedRev conflict", () => {
  it("maps a StaleWriteError thrown by writeBlob to a 409", async () => {
    // Force the next write to throw the typed stale-write error (as the real
    // write guard would when expectedRev no longer matches the stored __rev).
    const { StaleWriteError } = requireFromHere(blobGuardsPath);
    writeBlobMock.mockImplementationOnce(async () => {
      throw new StaleWriteError("jobs/job-1/services-locations.json", 1, 2);
    });
    const res = await call("POST", FIELD, { jobId: JOB }, { type: "meter", description: "x" });
    expect(res.statusCode).toBe(409);
    expect((res.body as { code?: string }).code).toBe("stale_write");
  });
});
