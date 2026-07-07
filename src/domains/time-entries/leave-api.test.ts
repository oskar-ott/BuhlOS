import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * API contract: /api/leave (#333) — leave requests that exempt missing-day
 * detection.
 *
 * The promises these tests pin:
 *   - a worker can request leave (pending) and cancel it while pending;
 *   - overlapping pending/approved leave is refused (409) — one source of
 *     truth per day; declined/cancelled rows never block;
 *   - only admins decide, decide is pending-only (409 after), and the worker
 *     is pushed either way;
 *   - admin record-on-behalf auto-approves (the "called in sick yesterday"
 *     reality) and is admin-only;
 *   - leave applies to hours-tracked workers (field tier + LH) — never
 *     clients, never office accounts that missing-day detection ignores;
 *   - GET scoping: ?mine=1 for any worker, the full register admin-only.
 *
 * Harness mirrors time-entries-overview-api.test.ts: real auth + handler via
 * require-cache injection, in-memory blob Map, push mocked for assertions.
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const leaveLibPath = requireFromHere.resolve("../../../api/_lib/leave.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const handlerPath = requireFromHere.resolve("../../../api/leave.js");

type Res = ReturnType<typeof createRes>;
type Handler = (req: Record<string, unknown>, res: Res) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: Handler;
let pushMock: ReturnType<typeof vi.fn>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function user(id: string, role: string, extra = {}) {
  return { id, username: id, role, assignedJobIds: [], ...extra };
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
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(
  viewerId: string,
  viewerRole: string,
  opts: {
    method?: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {}
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: opts.method ?? "GET",
      query: opts.query ?? {},
      body: opts.body,
      headers: { cookie: cookieFor(viewerId, viewerRole) },
    },
    res
  );
  return res;
}

function requestOf(res: Res): Record<string, unknown> {
  return (res.body as { request: Record<string, unknown> }).request;
}

function storedRequests(): Array<Record<string, unknown>> {
  return (blob.get("leave-requests.json") as { requests: Array<Record<string, unknown>> })
    ?.requests ?? [];
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          user("u_admin", "admin"),
          user("u_office", "office"),
          user("u_elec", "electrician"),
          user("u_tradie", "tradie"),
          user("u_lh", "leadingHand"),
          user("u_client", "client"),
        ],
      },
    ],
  ]);

  for (const modulePath of [blobSdkPath, blobPath, authPath, leaveLibPath, pushPath, handlerPath]) {
    delete requireFromHere.cache[modulePath];
  }

  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: { list: vi.fn(async () => ({ blobs: [] })), put: vi.fn(), del: vi.fn() },
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
  pushMock = vi.fn(async () => ({ sent: 1 }));
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { getWebPush: vi.fn(() => null), sendPushToUserId: pushMock },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Leave requests must start today-or-later, so hardcoded fixture dates rot
// as the calendar advances (this suite went red the day DAY_A passed).
// Derive the window from "now" instead; +1 day keeps the base clearly in the
// future across server-timezone offsets. The 2020 dates below stay literal —
// they deliberately test past-date rejection.
const futureDay = (offset: number) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const DAY_A = futureDay(1); // was 2026-07-06
const DAY_B = futureDay(3); // was 2026-07-08
const DAY_C = futureDay(4); // was 2026-07-09
const DAY_D = futureDay(5); // was 2026-07-10
const DAY_E = futureDay(6); // was 2026-07-11
const DAY_INSIDE = futureDay(2); // was 2026-07-07 (inside DAY_A..DAY_D)
const DAY_OUTSIDE = futureDay(30); // was 2026-07-20 (outside every range)

describe("POST /api/leave — worker self-request", () => {
  it("creates a pending request for the signed-in worker", async () => {
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: DAY_A, toDate: DAY_D, note: "Fishing" },
    });
    expect(res.statusCode).toBe(201);
    const r = requestOf(res);
    expect(r.userId).toBe("u_elec");
    expect(r.status).toBe("pending");
    expect(r.type).toBe("annual");
    expect(r.note).toBe("Fishing");
    expect(storedRequests()).toHaveLength(1);
  });

  it("validates type and dates", async () => {
    const badType = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "holiday", fromDate: DAY_A, toDate: DAY_A },
    });
    expect(badType.statusCode).toBe(400);
    const badDate = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: "6 July", toDate: DAY_A },
    });
    expect(badDate.statusCode).toBe(400);
    const inverted = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: DAY_D, toDate: DAY_A },
    });
    expect(inverted.statusCode).toBe(400);
  });

  it("rejects a worker self-request that starts in the past (H15)", async () => {
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: "2020-01-01", toDate: "2020-01-02" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/past/i);
    expect(storedRequests()).toHaveLength(0);
  });

  it("409s when the range overlaps an existing pending/approved request", async () => {
    blob.set("leave-requests.json", {
      requests: [
        {
          id: "lv_existing",
          userId: "u_elec",
          userName: "u_elec",
          type: "annual",
          fromDate: DAY_B,
          toDate: DAY_C,
          status: "pending",
        },
      ],
    });
    const overlapping = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "sick", fromDate: DAY_C, toDate: DAY_E },
    });
    expect(overlapping.statusCode).toBe(409);
    // Adjacent-but-not-overlapping is fine.
    const adjacent = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "sick", fromDate: DAY_D, toDate: DAY_E },
    });
    expect(adjacent.statusCode).toBe(201);
  });

  it("declined and cancelled rows never block a new request", async () => {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_d", userId: "u_elec", type: "annual", fromDate: DAY_B, toDate: DAY_C, status: "declined" },
        { id: "lv_c", userId: "u_elec", type: "annual", fromDate: DAY_B, toDate: DAY_C, status: "cancelled" },
      ],
    });
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: DAY_B, toDate: DAY_C },
    });
    expect(res.statusCode).toBe(201);
  });

  it("another worker's overlapping leave does not block mine", async () => {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_t", userId: "u_tradie", type: "annual", fromDate: DAY_B, toDate: DAY_C, status: "approved" },
      ],
    });
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: DAY_B, toDate: DAY_C },
    });
    expect(res.statusCode).toBe(201);
  });

  it("400s for a worker the hours pipeline does not track (office self-request)", async () => {
    const res = await call("u_office", "office", {
      method: "POST",
      body: { type: "annual", fromDate: DAY_A, toDate: DAY_A },
    });
    // Office accounts are invisible to missing-day detection, so leave for
    // them would be a silent no-op — refuse instead of pretending.
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/leave — admin record on behalf", () => {
  it("auto-approves with the admin stamped as decider", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: DAY_A, toDate: DAY_A, userId: "u_tradie" },
    });
    expect(res.statusCode).toBe(201);
    const r = requestOf(res);
    expect(r.userId).toBe("u_tradie");
    expect(r.status).toBe("approved");
    expect(r.decidedBy).toBe("u_admin");
    expect(r.requestedBy).toBe("u_admin");
  });

  it("CAN back-date on a worker's behalf (retroactive sick) — the past-date guard is worker-self only (H15)", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: "2020-01-01", toDate: "2020-01-01", userId: "u_tradie" },
    });
    expect(res.statusCode).toBe(201);
    expect(requestOf(res).status).toBe("approved");
  });

  it("403s a non-admin recording for someone else", async () => {
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "sick", fromDate: DAY_A, toDate: DAY_A, userId: "u_tradie" },
    });
    expect(res.statusCode).toBe(403);
    expect(storedRequests()).toHaveLength(0);
  });

  it("404s an unknown target worker", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: DAY_A, toDate: DAY_A, userId: "u_ghost" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s recording leave for an untracked office account", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: DAY_A, toDate: DAY_A, userId: "u_office" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/leave?action=decide", () => {
  function seedPending() {
    blob.set("leave-requests.json", {
      requests: [
        {
          id: "lv_1",
          userId: "u_elec",
          userName: "u_elec",
          type: "annual",
          fromDate: DAY_A,
          toDate: DAY_D,
          status: "pending",
        },
      ],
    });
  }

  it("admin approves → status approved + push to the worker", async () => {
    seedPending();
    const res = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_1", approve: true },
    });
    expect(res.statusCode).toBe(200);
    expect(requestOf(res).status).toBe("approved");
    expect(requestOf(res).decidedBy).toBe("u_admin");
    expect(storedRequests()[0]!.status).toBe("approved");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0]![0]).toBe("u_elec");
    expect(pushMock.mock.calls[0]![1]).toMatchObject({ url: "/phil/leave", tag: "buhl-leave" });
  });

  it("admin declines with a note the worker sees", async () => {
    seedPending();
    const res = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_1", approve: false, note: "Both crews on the hospital job that week" },
    });
    expect(res.statusCode).toBe(200);
    expect(requestOf(res).status).toBe("declined");
    expect(requestOf(res).decisionNote).toBe("Both crews on the hospital job that week");
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("non-admins cannot decide", async () => {
    seedPending();
    const res = await call("u_lh", "leadingHand", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_1", approve: true },
    });
    expect(res.statusCode).toBe(403);
    expect(storedRequests()[0]!.status).toBe("pending");
  });

  it("409s deciding an already-decided request", async () => {
    seedPending();
    await call("u_admin", "admin", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_1", approve: true },
    });
    const again = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_1", approve: false },
    });
    expect(again.statusCode).toBe(409);
    expect(storedRequests()[0]!.status).toBe("approved");
  });

  it("404s an unknown id and validates approve", async () => {
    const missing = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_nope", approve: true },
    });
    expect(missing.statusCode).toBe(404);
    seedPending();
    const badApprove = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_1", approve: "yes" },
    });
    expect(badApprove.statusCode).toBe(400);
  });
});

describe("POST /api/leave?action=cancel", () => {
  function seed(status: string, userId = "u_elec") {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_1", userId, userName: userId, type: "annual", fromDate: DAY_A, toDate: DAY_D, status },
      ],
    });
  }

  it("worker cancels their own pending request", async () => {
    seed("pending");
    const res = await call("u_elec", "electrician", {
      method: "POST",
      query: { action: "cancel" },
      body: { id: "lv_1" },
    });
    expect(res.statusCode).toBe(200);
    expect(storedRequests()[0]!.status).toBe("cancelled");
  });

  it("cannot cancel someone else's request", async () => {
    seed("pending", "u_tradie");
    const res = await call("u_elec", "electrician", {
      method: "POST",
      query: { action: "cancel" },
      body: { id: "lv_1" },
    });
    expect(res.statusCode).toBe(403);
    expect(storedRequests()[0]!.status).toBe("pending");
  });

  it("409s cancelling once approved — that's the office's call now", async () => {
    seed("approved");
    const res = await call("u_elec", "electrician", {
      method: "POST",
      query: { action: "cancel" },
      body: { id: "lv_1" },
    });
    expect(res.statusCode).toBe(409);
    expect(storedRequests()[0]!.status).toBe("approved");
  });
});

describe("POST /api/leave?action=clear — office undo by worker+date (#127)", () => {
  function seedApproved(userId = "u_elec", from = DAY_A, to = DAY_B) {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_1", userId, userName: userId, type: "sick", fromDate: from, toDate: to, status: "approved" },
      ],
    });
  }

  it("admin clears the approved leave covering that day → cancelled + audited", async () => {
    seedApproved();
    const res = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "clear" },
      body: { userId: "u_elec", date: DAY_INSIDE }, // inside the range
    });
    expect(res.statusCode).toBe(200);
    expect(storedRequests()[0]!.status).toBe("cancelled");
    const auditKeys = [...blob.keys()].filter((k) => k.startsWith("audit/"));
    expect(auditKeys.length).toBeGreaterThan(0);
    const entries = (blob.get(auditKeys[0]!) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries.some((e) => e.action === "leave.cancelled" && e.targetType === "leave")).toBe(true);
  });

  it("404s when no leave covers that day; non-admin 403s", async () => {
    seedApproved();
    const miss = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "clear" },
      body: { userId: "u_elec", date: DAY_OUTSIDE }, // outside range
    });
    expect(miss.statusCode).toBe(404);
    const field = await call("u_elec", "electrician", {
      method: "POST",
      query: { action: "clear" },
      body: { userId: "u_elec", date: DAY_INSIDE },
    });
    expect(field.statusCode).toBe(403);
  });
});

describe("audit trail on office leave actions (#127)", () => {
  it("recording on behalf writes a leave.recorded audit row", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "annual", fromDate: DAY_A, toDate: DAY_A, userId: "u_tradie" },
    });
    expect(res.statusCode).toBe(201);
    const auditKeys = [...blob.keys()].filter((k) => k.startsWith("audit/"));
    const entries = (blob.get(auditKeys[0]!) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries.some((e) => e.action === "leave.recorded" && e.actorId === "u_admin")).toBe(true);
  });
});

describe("GET /api/leave — scoping", () => {
  beforeEach(() => {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_a", userId: "u_elec", type: "annual", fromDate: DAY_A, toDate: DAY_A, status: "pending" },
        { id: "lv_b", userId: "u_tradie", type: "sick", fromDate: DAY_INSIDE, toDate: DAY_INSIDE, status: "approved" },
      ],
    });
  });

  it("?mine=1 returns only the caller's requests", async () => {
    const res = await call("u_elec", "electrician", { query: { mine: "1" } });
    expect(res.statusCode).toBe(200);
    const ids = (res.body as { requests: Array<{ id: string }> }).requests.map((r) => r.id);
    expect(ids).toEqual(["lv_a"]);
  });

  it("the full register is admin-only", async () => {
    const admin = await call("u_admin", "admin", {});
    expect(admin.statusCode).toBe(200);
    expect((admin.body as { requests: unknown[] }).requests).toHaveLength(2);
    const worker = await call("u_elec", "electrician", {});
    expect(worker.statusCode).toBe(403);
  });

  it("clients are locked out entirely", async () => {
    const res = await call("u_client", "client", { query: { mine: "1" } });
    expect(res.statusCode).toBe(403);
  });
});
