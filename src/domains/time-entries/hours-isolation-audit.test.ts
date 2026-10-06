import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cross-user isolation probes (lean-launch readiness audit, 2026-07).
 *
 * Drives the REAL handlers with hostile role/identity combinations to prove
 * the API enforces boundaries independently of any UI:
 *   - a field worker cannot read another worker's hours
 *   - a field worker cannot edit another worker's hours
 *   - a field worker cannot approve/reject anything (incl. own)
 *   - a field worker cannot see the approver queue
 *   - a field worker cannot log hours on behalf of another worker
 *   - an LH cannot approve another LH's entry
 *   - a non-owner admin cannot write feature flags; a field worker cannot
 *   - an ARCHIVED worker's still-valid session cookie is refused everywhere
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const teLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const entriesPath = requireFromHere.resolve("../../../api/time-entries.js");
const approvePath = requireFromHere.resolve("../../../api/time-entries-approve.js");
const rejectPath = requireFromHere.resolve("../../../api/time-entries-reject.js");
const ownerFlagsPath = requireFromHere.resolve("../../../api/owner-flags.js");
const auditLogPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const notifyPath = requireFromHere.resolve("../../../api/_lib/notify.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const hoursMirrorPath = requireFromHere.resolve("../../../api/_lib/hours-mirror.js");
const mirrorDriftPath = requireFromHere.resolve("../../../api/_lib/mirror-drift.js");
const hoursReadPath = requireFromHere.resolve("../../../api/_lib/hours-read.js");
const featureFlagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let entries: (req: unknown, res: unknown) => Promise<unknown>;
let approve: (req: unknown, res: unknown) => Promise<unknown>;
let reject: (req: unknown, res: unknown) => Promise<unknown>;
let ownerFlags: (req: unknown, res: unknown) => Promise<unknown>;

const TODAY = new Date().toISOString().slice(0, 10);

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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
function cookieFor(userId: string, role: string) {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(
  handler: (req: unknown, res: unknown) => Promise<unknown>,
  {
    method,
    userId,
    role,
    query = {},
    body,
  }: { method: string; userId: string; role: string; query?: Record<string, string>; body?: unknown },
) {
  const res = createRes();
  await handler({ method, query, body, headers: { cookie: cookieFor(userId, role) } }, res);
  return res;
}

function seedEntry(userId: string, status = "submitted") {
  return {
    id: `e_${userId}`,
    userId,
    userName: userId,
    userRole: "electrician",
    date: TODAY,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status,
    submittedAt: `${TODAY}T08:00:00.000Z`,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    allocations: [{ jobId: "job-a", hours: 8, notes: null, sortOrder: 0 }],
    createdAt: `${TODAY}T07:00:00.000Z`,
    updatedAt: `${TODAY}T08:00:00.000Z`,
    __rev: 1,
  };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.SUPABASE_DB_URL;

  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", assignedJobIds: ["job-a"] },
          { id: "u_lh1", username: "lead1", role: "lh", assignedJobIds: ["job-a"] },
          { id: "u_lh2", username: "lead2", role: "lh", assignedJobIds: ["job-a"] },
          { id: "wA", username: "alice", role: "electrician", assignedJobIds: ["job-a"] },
          { id: "wB", username: "bob", role: "tradie", assignedJobIds: ["job-a"] },
          {
            id: "wGone",
            username: "departed",
            role: "electrician",
            assignedJobIds: ["job-a"],
            archived: true,
          },
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-a", name: "Job A", status: "active" }] }],
    [`users/wB/time-entries/${TODAY}.json`, seedEntry("wB")],
    [`users/u_lh2/time-entries/${TODAY}.json`, seedEntry("u_lh2")],
  ]);

  for (const p of [
    authPath,
    teLibPath,
    entriesPath,
    approvePath,
    rejectPath,
    ownerFlagsPath,
    auditLogPath,
    notifyPath,
    activityPath,
    hoursMirrorPath,
    mirrorDriftPath,
    hoursReadPath,
    featureFlagsPath,
  ]) {
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
      deleteBlob: vi.fn(async (key: string) => {
        blob.delete(key);
      }),
      setNoCache: vi.fn(),
    },
  } as unknown as NodeJS.Module;

  auth = requireFromHere(authPath);
  entries = requireFromHere(entriesPath);
  approve = requireFromHere(approvePath);
  reject = requireFromHere(rejectPath);
  ownerFlags = requireFromHere(ownerFlagsPath);
});

describe("cross-user hours isolation (API-enforced, not UI-enforced)", () => {
  it("field worker cannot READ another worker's entries via ?userId", async () => {
    const res = await call(entries, {
      method: "GET",
      userId: "wA",
      role: "electrician",
      query: { userId: "wB" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("field worker cannot EDIT another worker's entry via PATCH ?userId", async () => {
    const res = await call(entries, {
      method: "PATCH",
      userId: "wA",
      role: "electrician",
      query: { date: TODAY, userId: "wB" },
      body: { totalHours: 1, ordinaryHours: 1, overtimeHours: 0, allocations: [{ jobId: "job-a", hours: 1 }] },
    });
    expect(res.statusCode).toBe(403);
    const stored = blob.get(`users/wB/time-entries/${TODAY}.json`) as { totalHours: number };
    expect(stored.totalHours).toBe(8); // untouched
  });

  it("field worker cannot APPROVE (any entry, incl. someone else's)", async () => {
    const res = await call(approve, {
      method: "POST",
      userId: "wA",
      role: "electrician",
      body: { userId: "wB", date: TODAY },
    });
    expect(res.statusCode).toBe(403);
  });

  it("field worker cannot REJECT", async () => {
    const res = await call(reject, {
      method: "POST",
      userId: "wA",
      role: "electrician",
      body: { userId: "wB", date: TODAY, reason: "nope" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("field worker cannot see the approver queue (scope=approver)", async () => {
    const res = await call(entries, {
      method: "GET",
      userId: "wA",
      role: "electrician",
      query: { scope: "approver" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("field worker cannot log hours ON BEHALF of another worker", async () => {
    const res = await call(entries, {
      method: "POST",
      userId: "wA",
      role: "electrician",
      body: {
        date: TODAY,
        targetUserId: "wB",
        totalHours: 8,
        ordinaryHours: 8,
        overtimeHours: 0,
        allocations: [{ jobId: "job-a", hours: 8 }],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a role claim in the cookie cannot beat the users.json role (fresh lookup wins)", async () => {
    // wA's stored role is electrician; the cookie CLAIMS admin. getCurrentUser
    // re-reads users.json, so the stored role must govern the approver gate.
    const res = await call(approve, {
      method: "POST",
      userId: "wA",
      role: "admin", // forged claim (session is HMAC-signed, but role comes from the store)
      body: { userId: "wB", date: TODAY },
    });
    expect(res.statusCode).toBe(403);
    const stored = blob.get(`users/wB/time-entries/${TODAY}.json`) as { status: string };
    expect(stored.status).toBe("submitted");
  });

  it("LH cannot approve another LH's entry", async () => {
    const res = await call(approve, {
      method: "POST",
      userId: "u_lh1",
      role: "lh",
      body: { userId: "u_lh2", date: TODAY },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin cannot approve their OWN hours", async () => {
    blob.set(`users/u_admin/time-entries/${TODAY}.json`, seedEntry("u_admin"));
    const res = await call(approve, {
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { userId: "u_admin", date: TODAY },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("owner-only feature-flag boundary", () => {
  it("field worker cannot toggle flags", async () => {
    const res = await call(ownerFlags, {
      method: "POST",
      userId: "wA",
      role: "electrician",
      body: { key: "snags", scope: "live", value: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it("plain admin (non-owner) cannot toggle flags", async () => {
    const res = await call(ownerFlags, {
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { key: "snags", scope: "live", value: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("archived worker — session refused everywhere", () => {
  it("archived worker's valid cookie gets 401 on read, create and approve", async () => {
    const read = await call(entries, { method: "GET", userId: "wGone", role: "electrician" });
    expect(read.statusCode).toBe(401);
    const create = await call(entries, {
      method: "POST",
      userId: "wGone",
      role: "electrician",
      body: {
        date: TODAY,
        totalHours: 8,
        ordinaryHours: 8,
        overtimeHours: 0,
        allocations: [{ jobId: "job-a", hours: 8 }],
      },
    });
    expect(create.statusCode).toBe(401);
    const app = await call(approve, {
      method: "POST",
      userId: "wGone",
      role: "electrician",
      body: { userId: "wB", date: TODAY },
    });
    expect(app.statusCode).toBe(401);
  });
});
