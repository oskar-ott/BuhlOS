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
// Loaded once at file scope (NEVER cache-evicted below) so the class identity
// matches the one api/_lib/leave.js catches with instanceof.
const { StaleWriteError } = requireFromHere("../../../api/_lib/blob-guards.js");
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

/** Merged view of the store: per-request files (leave-requests/<id>.json, the
 *  #127 layout) win over rows in the read-only legacy aggregate. */
function storedRequests(): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const legacy = blob.get("leave-requests.json") as
    | { requests?: Array<Record<string, unknown>> }
    | undefined;
  for (const r of legacy?.requests ?? []) byId.set(String(r.id), r);
  for (const [k, v] of blob) {
    if (String(k).startsWith("leave-requests/")) {
      const doc = v as Record<string, unknown>;
      byId.set(String(doc.id), doc);
    }
  }
  return [...byId.values()];
}

/**
 * today+N days as YYYY-MM-DD in the BUSINESS timezone — the same clock the
 * handler's "a worker's own leave can't start in the past" guard uses. The
 * suite used to hardcode near-future dates ("2026-07-06"), which became past
 * dates overnight and time-bombed CI (the audit-log flake pattern). Offsets
 * start at +1 so a run straddling midnight can't flip a valid date stale.
 * Deliberately-past cases keep their explicit 2020 dates.
 */
function d(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
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
    exports: {
      // Serve the in-memory store so the per-request file listing works
      // (leave lib lists leave-requests/<id>.json since the #127 split).
      list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
        blobs: [...blob.keys()]
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((k) => ({ pathname: k, url: `memory://${k}` })),
      })),
      put: vi.fn(),
      del: vi.fn(),
    },
  } as NodeJS.Module;
  // The write mock mirrors the real guard semantics: every write stamps
  // __rev, and a caller passing expectedRev gets a StaleWriteError when the
  // document has moved on — same-request edit conflicts stay exercised.
  const readImpl = async (key: string, fallback: unknown) =>
    blob.has(key) ? clone(blob.get(key)) : fallback;
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(readImpl),
      readBlobFresh: vi.fn(readImpl),
      writeBlob: vi.fn(
        async (key: string, data: Record<string, unknown>, opts: { expectedRev?: number } = {}) => {
          const current = blob.get(key) as { __rev?: number } | undefined;
          const currentRev =
            current && Number.isFinite(current.__rev) ? (current.__rev as number) : 0;
          if (opts.expectedRev !== undefined && opts.expectedRev !== null) {
            if (Number(opts.expectedRev) !== currentRev) {
              throw new StaleWriteError(key, Number(opts.expectedRev), currentRev);
            }
          }
          blob.set(key, clone({ ...data, __rev: currentRev + 1 }));
        }
      ),
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

describe("POST /api/leave — worker self-request", () => {
  it("creates a pending request for the signed-in worker", async () => {
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: d(1), toDate: d(4), note: "Fishing" },
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
      body: { type: "holiday", fromDate: d(1), toDate: d(1) },
    });
    expect(badType.statusCode).toBe(400);
    const badDate = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: "6 July", toDate: d(1) },
    });
    expect(badDate.statusCode).toBe(400);
    const inverted = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: d(4), toDate: d(1) },
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
          fromDate: d(2),
          toDate: d(3),
          status: "pending",
        },
      ],
    });
    const overlapping = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "sick", fromDate: d(3), toDate: d(5) },
    });
    expect(overlapping.statusCode).toBe(409);
    // Adjacent-but-not-overlapping is fine.
    const adjacent = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "sick", fromDate: d(4), toDate: d(5) },
    });
    expect(adjacent.statusCode).toBe(201);
  });

  it("declined and cancelled rows never block a new request", async () => {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_d", userId: "u_elec", type: "annual", fromDate: d(2), toDate: d(3), status: "declined" },
        { id: "lv_c", userId: "u_elec", type: "annual", fromDate: d(2), toDate: d(3), status: "cancelled" },
      ],
    });
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: d(2), toDate: d(3) },
    });
    expect(res.statusCode).toBe(201);
  });

  it("another worker's overlapping leave does not block mine", async () => {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_t", userId: "u_tradie", type: "annual", fromDate: d(2), toDate: d(3), status: "approved" },
      ],
    });
    const res = await call("u_elec", "electrician", {
      method: "POST",
      body: { type: "annual", fromDate: d(2), toDate: d(3) },
    });
    expect(res.statusCode).toBe(201);
  });

  it("400s for a worker the hours pipeline does not track (office self-request)", async () => {
    const res = await call("u_office", "office", {
      method: "POST",
      body: { type: "annual", fromDate: d(1), toDate: d(1) },
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
      body: { type: "sick", fromDate: d(1), toDate: d(1), userId: "u_tradie" },
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
      body: { type: "sick", fromDate: d(1), toDate: d(1), userId: "u_tradie" },
    });
    expect(res.statusCode).toBe(403);
    expect(storedRequests()).toHaveLength(0);
  });

  it("404s an unknown target worker", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: d(1), toDate: d(1), userId: "u_ghost" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s recording leave for an untracked office account", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: d(1), toDate: d(1), userId: "u_office" },
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
          fromDate: d(1),
          toDate: d(4),
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
        { id: "lv_1", userId, userName: userId, type: "annual", fromDate: d(1), toDate: d(4), status },
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
  function seedApproved(userId = "u_elec", from = d(1), to = d(2)) {
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
      body: { userId: "u_elec", date: d(1) }, // inside the seeded d(1)–d(2) range
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
      body: { userId: "u_elec", date: d(20) }, // outside range
    });
    expect(miss.statusCode).toBe(404);
    const field = await call("u_elec", "electrician", {
      method: "POST",
      query: { action: "clear" },
      body: { userId: "u_elec", date: d(1) },
    });
    expect(field.statusCode).toBe(403);
  });
});

describe("audit trail on office leave actions (#127)", () => {
  it("recording on behalf writes a leave.recorded audit row", async () => {
    const res = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "annual", fromDate: d(1), toDate: d(1), userId: "u_tradie" },
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
        { id: "lv_a", userId: "u_elec", type: "annual", fromDate: d(1), toDate: d(1), status: "pending" },
        { id: "lv_b", userId: "u_tradie", type: "sick", fromDate: d(2), toDate: d(2), status: "approved" },
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

describe("per-request documents — the weekly-board lost-write fix (#127)", () => {
  it("every create writes its OWN document, never the shared aggregate", async () => {
    const first = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "annual", fromDate: d(1), toDate: d(1), userId: "u_tradie" },
    });
    const second = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "annual", fromDate: d(2), toDate: d(2), userId: "u_tradie" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    // Both days exist as separate leave-requests/<id>.json documents; the
    // legacy aggregate was never written. This is what makes rapid marking
    // race-free BY CONSTRUCTION: there is no shared doc a stale read-modify-
    // write could erase (the CAS approach still lost writes live — Vercel
    // Blob's CDN can serve consistently stale bodies for 10+s after an
    // overwrite, defeating any read-check-write on one shared document).
    const fileKeys = [...blob.keys()].filter((k) => String(k).startsWith("leave-requests/"));
    expect(fileKeys).toHaveLength(2);
    expect(blob.has("leave-requests.json")).toBe(false);
    const dates = storedRequests().map((r) => r.fromDate).sort();
    expect(dates).toEqual([d(1), d(2)]);
  });

  it("rows in the legacy aggregate still read, and a mutation migrates to a per-request file", async () => {
    blob.set("leave-requests.json", {
      requests: [
        { id: "lv_old", userId: "u_elec", userName: "u_elec", type: "annual", fromDate: d(5), toDate: d(5), status: "pending", requestedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    // Legacy row is visible…
    const listRes = await call("u_admin", "admin", {});
    expect((listRes.body as { requests: Array<{ id: string }> }).requests.map((r) => r.id)).toContain("lv_old");
    // …and deciding it writes leave-requests/lv_old.json (migrate-on-write),
    // leaving the read-only aggregate untouched.
    const decide = await call("u_admin", "admin", {
      method: "POST",
      query: { action: "decide" },
      body: { id: "lv_old", approve: true },
    });
    expect(decide.statusCode).toBe(200);
    const file = blob.get("leave-requests/lv_old.json") as { status: string };
    expect(file.status).toBe("approved");
    const legacy = blob.get("leave-requests.json") as { requests: Array<{ status: string }> };
    expect(legacy.requests[0]!.status).toBe("pending"); // aggregate never rewritten
    // Merged read prefers the per-file version.
    expect(storedRequests().find((r) => r.id === "lv_old")!.status).toBe("approved");
  });

  it("the per-file version wins over a stale legacy copy of the same request", async () => {
    blob.set("leave-requests.json", {
      requests: [{ id: "lv_x", userId: "u_tradie", type: "annual", fromDate: d(3), toDate: d(3), status: "pending" }],
    });
    blob.set("leave-requests/lv_x.json", {
      id: "lv_x", userId: "u_tradie", type: "annual", fromDate: d(3), toDate: d(3), status: "cancelled",
    });
    const res = await call("u_admin", "admin", {});
    const row = (res.body as { requests: Array<{ id: string; status: string }> }).requests.find((r) => r.id === "lv_x")!;
    expect(row.status).toBe("cancelled");
  });

  it("overlap is still refused across BOTH layouts (per-file + legacy rows)", async () => {
    blob.set("leave-requests.json", {
      requests: [{ id: "lv_leg", userId: "u_tradie", type: "annual", fromDate: d(6), toDate: d(6), status: "approved" }],
    });
    const clashLegacy = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: d(6), toDate: d(6), userId: "u_tradie" },
    });
    expect(clashLegacy.statusCode).toBe(409);

    const ok = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "sick", fromDate: d(7), toDate: d(7), userId: "u_tradie" },
    });
    expect(ok.statusCode).toBe(201);
    const clashFile = await call("u_admin", "admin", {
      method: "POST",
      body: { type: "annual", fromDate: d(7), toDate: d(7), userId: "u_tradie" },
    });
    expect(clashFile.statusCode).toBe(409);
  });
});
