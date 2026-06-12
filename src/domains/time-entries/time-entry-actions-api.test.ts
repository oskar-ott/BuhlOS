import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the dedicated time-entry approval actions. These
 * handlers are deliberately tested separately from the generic CRUD route:
 * payroll trust depends on aliases taking the same scoped path as
 * `leadingHand`, and on every actor being unable to approve or reject themself.
 */
const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const timeEntriesLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
// #162: the approve/bulk-approve handlers now push via the notify() engine,
// which require()s push.js underneath. Evict notify + its router each test so a
// freshly-loaded engine binds to the freshly-mocked push.js (the cache is
// process-global across test files — a stale notify would hold the real push).
const notifyPath = requireFromHere.resolve("../../../api/_lib/notify.js");
const notifyRoutingPath = requireFromHere.resolve("../../../api/_lib/notify-routing.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const approvePath = requireFromHere.resolve("../../../api/time-entries-approve.js");
const rejectPath = requireFromHere.resolve("../../../api/time-entries-reject.js");
const bulkApprovePath = requireFromHere.resolve("../../../api/time-entries-bulk-approve.js");
const bulkRejectPath = requireFromHere.resolve("../../../api/time-entries-bulk-reject.js");
const exportPath = requireFromHere.resolve("../../../api/time-entries-export.js");

const TODAY = new Date().toISOString().slice(0, 10);
const ENTRY_PATH = (userId: string) => `users/${userId}/time-entries/${TODAY}.json`;

type Handler = (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let approve: Handler;
let reject: Handler;
let bulkApprove: Handler;
let bulkReject: Handler;
let exportEntries: Handler;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function user(id: string, role: string, assignedJobIds: string[] = []) {
  return { id, username: id, role, assignedJobIds };
}

function entry(userId: string, userRole: string, jobId: string) {
  return {
    id: `entry_${userId}`,
    userId,
    userName: userId,
    userRole,
    date: TODAY,
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    submittedAt: `${TODAY}T08:00:00.000Z`,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    allocations: [{ jobId, hours: 8, notes: null, sortOrder: 0 }],
    createdAt: `${TODAY}T07:00:00.000Z`,
    updatedAt: `${TODAY}T08:00:00.000Z`,
  };
}

function setEntry(userId: string, userRole: string, jobId: string) {
  blob.set(ENTRY_PATH(userId), entry(userId, userRole, jobId));
}

function stored(userId: string) {
  return blob.get(ENTRY_PATH(userId)) as { status: string; approvedBy?: string; rejectedBy?: string };
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
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

async function call(
  handler: Handler,
  userId: string,
  role: string,
  body: unknown,
  query: Record<string, string> = {}
) {
  const res = createRes();
  await handler(
    { method: "POST", body, query, headers: { cookie: cookieFor(userId, role) } },
    res
  );
  return res;
}

async function exportJson(userId = "u_office", role = "office") {
  const res = createRes();
  await exportEntries(
    {
      method: "GET",
      query: { format: "json", dryRun: "1", fromDate: TODAY, toDate: TODAY },
      headers: { cookie: cookieFor(userId, role) },
    },
    res
  );
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          user("u_admin", "admin"),
          user("u_office", "office"),
          user("u_lh", "lh", ["job-x"]),
          user("u_leadinghand", "leadinghand", ["job-x"]),
          user("u_canonical", "leadingHand", ["job-x"]),
          user("u_field", "tradie", ["job-x"]),
          user("u_other", "tradie", ["job-y"]),
        ],
      },
    ],
    ["jobs.json", { jobs: [{ id: "job-x", name: "Job X" }, { id: "job-y", name: "Job Y" }] }],
  ]);
  setEntry("u_lh", "lh", "job-x");
  setEntry("u_leadinghand", "leadinghand", "job-x");
  setEntry("u_canonical", "leadingHand", "job-x");
  setEntry("u_field", "tradie", "job-x");
  setEntry("u_other", "tradie", "job-y");

  for (const modulePath of [
    blobSdkPath,
    blobPath,
    authPath,
    timeEntriesLibPath,
    pushPath,
    notifyPath,
    notifyRoutingPath,
    activityPath,
    approvePath,
    rejectPath,
    bulkApprovePath,
    bulkRejectPath,
    exportPath,
  ]) {
    delete requireFromHere.cache[modulePath];
  }

  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: {
      list: vi.fn(async () => ({
        blobs: [...blob.keys()]
          .filter((key) => key.includes("/time-entries/"))
          .map((pathname) => ({ pathname, url: `https://blob.test/${encodeURIComponent(pathname)}` })),
      })),
      put: vi.fn(),
      del: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
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
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { sendPushToUserId: vi.fn(async () => {}) },
  } as NodeJS.Module;
  requireFromHere.cache[activityPath] = {
    id: activityPath,
    filename: activityPath,
    loaded: true,
    exports: { appendActivity: vi.fn(async () => {}) },
  } as NodeJS.Module;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const pathname = decodeURIComponent(new URL(url).pathname.slice(1));
      const value = blob.get(pathname);
      return { ok: value !== undefined, json: async () => clone(value) };
    })
  );

  auth = requireFromHere(authPath);
  approve = requireFromHere(approvePath);
  reject = requireFromHere(rejectPath);
  bulkApprove = requireFromHere(bulkApprovePath);
  bulkReject = requireFromHere(bulkRejectPath);
  exportEntries = requireFromHere(exportPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("single approve/reject actions", () => {
  it("blocks every LH spelling from approving or rejecting its own entry", async () => {
    for (const [userId, role] of [
      ["u_lh", "lh"],
      ["u_leadinghand", "leadinghand"],
      ["u_canonical", "leadingHand"],
    ] as const) {
      const approved = await call(approve, userId, role, { userId, date: TODAY });
      expect(approved.statusCode).toBe(403);
      expect(stored(userId).status).toBe("submitted");

      const rejected = await call(reject, userId, role, {
        userId,
        date: TODAY,
        reason: "not allowed",
      });
      expect(rejected.statusCode).toBe(403);
      expect(stored(userId).status).toBe("submitted");
    }
  });

  it("scopes LH aliases to their jobs while preserving permitted subordinate actions", async () => {
    const unrelatedApprove = await call(approve, "u_lh", "lh", {
      userId: "u_other",
      date: TODAY,
    });
    expect(unrelatedApprove.statusCode).toBe(403);
    expect(stored("u_other").status).toBe("submitted");

    const allowedApprove = await call(approve, "u_lh", "lh", {
      userId: "u_field",
      date: TODAY,
    });
    expect(allowedApprove.statusCode).toBe(200);
    expect(stored("u_field").status).toBe("approved");

    setEntry("u_field", "tradie", "job-x");
    const allowedReject = await call(reject, "u_leadinghand", "leadinghand", {
      userId: "u_field",
      date: TODAY,
      reason: "Fix allocation",
    });
    expect(allowedReject.statusCode).toBe(200);
    expect(stored("u_field").status).toBe("rejected");
  });

  it("preserves office-tier approval and rejection flows", async () => {
    const approved = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(approved.statusCode).toBe(200);
    expect(stored("u_field").approvedBy).toBe("u_office");

    setEntry("u_field", "tradie", "job-x");
    const rejected = await call(reject, "u_office", "office", {
      userId: "u_field",
      date: TODAY,
      reason: "Fix allocation",
    });
    expect(rejected.statusCode).toBe(200);
    expect(stored("u_field").rejectedBy).toBe("u_office");
  });
});

describe("bulk approve/reject actions", () => {
  it("skips LH-alias self-owned and unrelated-job entries while processing permitted crew", async () => {
    const approved = await call(bulkApprove, "u_lh", "lh", {
      entries: [
        { userId: "u_lh", date: TODAY },
        { userId: "u_field", date: TODAY },
        { userId: "u_other", date: TODAY },
      ],
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.body).toMatchObject({ approvedCount: 1, failedCount: 2 });
    expect(stored("u_lh").status).toBe("submitted");
    expect(stored("u_field").status).toBe("approved");
    expect(stored("u_other").status).toBe("submitted");

    setEntry("u_field", "tradie", "job-x");
    const rejected = await call(bulkReject, "u_lh", "lh", {
      defaultReason: "Fix allocation",
      entries: [
        { userId: "u_lh", date: TODAY },
        { userId: "u_field", date: TODAY },
        { userId: "u_other", date: TODAY },
      ],
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.body).toMatchObject({ rejectedCount: 1, failedCount: 2 });
    expect(stored("u_lh").status).toBe("submitted");
    expect(stored("u_field").status).toBe("rejected");
    expect(stored("u_other").status).toBe("submitted");
  });

  it("preserves office-tier bulk approval and rejection", async () => {
    const approved = await call(bulkApprove, "u_office", "office", {
      entries: [{ userId: "u_field", date: TODAY }, { userId: "u_other", date: TODAY }],
    });
    expect(approved.body).toMatchObject({ approvedCount: 2, failedCount: 0 });

    setEntry("u_field", "tradie", "job-x");
    setEntry("u_other", "tradie", "job-y");
    const rejected = await call(bulkReject, "u_office", "office", {
      defaultReason: "Fix allocation",
      entries: [{ userId: "u_field", date: TODAY }, { userId: "u_other", date: TODAY }],
    });
    expect(rejected.body).toMatchObject({ rejectedCount: 2, failedCount: 0 });
  });
});

describe("worker push deep links land on the live Phil surface", () => {
  function pushMock() {
    return (requireFromHere.cache[pushPath] as NodeJS.Module).exports
      .sendPushToUserId as ReturnType<typeof vi.fn>;
  }

  it("reject pushes carry the /phil/my-day?fixDate= deep link (one tap to the fix sheet)", async () => {
    const res = await call(reject, "u_office", "office", {
      userId: "u_field",
      date: TODAY,
      reason: "Wrong job",
    });
    expect(res.statusCode).toBe(200);
    expect(pushMock()).toHaveBeenCalledWith(
      "u_field",
      expect.objectContaining({ url: `/phil/my-day?fixDate=${TODAY}` })
    );
  });

  it("bulk reject pushes carry the same fixDate deep link", async () => {
    const res = await call(bulkReject, "u_office", "office", {
      defaultReason: "Fix allocation",
      entries: [{ userId: "u_field", date: TODAY }],
    });
    expect(res.statusCode).toBe(200);
    expect(pushMock()).toHaveBeenCalledWith(
      "u_field",
      expect.objectContaining({ url: `/phil/my-day?fixDate=${TODAY}` })
    );
  });

  it("approve pushes land on /phil/my-day (status visible on the week strip)", async () => {
    const res = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(res.statusCode).toBe(200);
    expect(pushMock()).toHaveBeenCalledWith(
      "u_field",
      expect.objectContaining({ url: "/phil/my-day" })
    );
  });
});

describe("payroll export eligibility", () => {
  it("excludes denied self-approval but exports a legitimate office-approved entry", async () => {
    const denied = await call(approve, "u_lh", "lh", { userId: "u_lh", date: TODAY });
    expect(denied.statusCode).toBe(403);
    const before = await exportJson();
    expect((before.body as { rows: unknown[] }).rows).toHaveLength(0);

    const allowed = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(allowed.statusCode).toBe(200);
    const after = await exportJson();
    expect((after.body as { rows: Array<{ workerId: string }> }).rows.map((row) => row.workerId)).toEqual([
      "u_field",
    ]);
  });
});
