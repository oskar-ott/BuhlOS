import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration coverage for the platform notify() engine (#162) THROUGH the
 * migrated production call-sites. Same require.cache harness as
 * time-entry-actions-api.test.ts: the blob store, auth and api/_lib/push.js are
 * replaced with in-memory fakes, and the REAL handlers + REAL notify() engine +
 * REAL router run on top.
 *
 * The bar for this PR is regression-freedom — every migrated push must reach
 * the SAME recipient with the SAME payload as the pre-engine direct
 * sendPushToUserId call, for the default (untouched) prefs. The new behaviour
 * is purely additive: a muted pref now suppresses that one user.
 *
 * What this pins (issue #162 ACs):
 *   1. migrated call-sites push the same recipients + payload for default prefs
 *      (approve, bulk-approve, snag-quick-raise, snag-notify, stale-snags cron);
 *   2. a muted key verifiably suppresses that event for that user ONLY;
 *   3. missing prefs default to true (the recipient notices zero change);
 *   4. a push failure never fails the business response;
 *   5. prune behaviour is preserved (the engine forwards push.js's counts).
 */
const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const timeEntriesLibPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");
const activityPath = requireFromHere.resolve("../../../api/_lib/activity.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const cronAuthPath = requireFromHere.resolve("../../../api/_lib/cron-auth.js");
const notifyRoutingPath = requireFromHere.resolve("../../../api/_lib/notify-routing.js");
const notifyPath = requireFromHere.resolve("../../../api/_lib/notify.js");
const approvePath = requireFromHere.resolve("../../../api/time-entries-approve.js");
const bulkApprovePath = requireFromHere.resolve("../../../api/time-entries-bulk-approve.js");
const snagQuickRaisePath = requireFromHere.resolve("../../../api/snag-quick-raise.js");
const snagNotifyPath = requireFromHere.resolve("../../../api/snag-notify.js");
const notificationsPath = requireFromHere.resolve("../../../api/notifications.js");

const TODAY = new Date().toISOString().slice(0, 10);
const ENTRY_PATH = (userId: string) => `users/${userId}/time-entries/${TODAY}.json`;

type Payload = { title: string; body: string; url: string; tag: string };
type PushCall = { userId: string; payload: Payload };
type Handler = (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

let blob: Map<string, unknown>;
let pushCalls: PushCall[];
let pushImpl: (userId: string, payload: Payload) => Promise<{ sent: number; pruned: number; skipped: string | null }>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let approve: Handler;
let bulkApprove: Handler;
let snagQuickRaise: Handler;
let snagNotify: Handler;
let notifications: Handler;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

const SUB = [{ endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } }];

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
  query: Record<string, string> = {},
) {
  const res = createRes();
  await handler({ method: "POST", body, query, headers: { cookie: cookieFor(userId, role) } }, res);
  return res;
}

function entry(userId: string, userRole: string, jobId: string) {
  return {
    id: `entry_${userId}`,
    userId,
    userName: userId,
    userRole,
    date: TODAY,
    totalHours: 8,
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

function setUsers(extra: Array<Record<string, unknown>> = []) {
  blob.set("users.json", {
    users: [
      { id: "u_office", username: "office", role: "office", pushSubscriptions: SUB },
      { id: "u_field", username: "sam", role: "tradie", assignedJobIds: ["job-x"], pushSubscriptions: SUB },
      { id: "u_field2", username: "riley", role: "tradie", assignedJobIds: ["job-x"], pushSubscriptions: SUB },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["job-x"], pushSubscriptions: SUB },
      ...extra,
    ],
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  delete process.env.CRON_SECRET; // cron calls allowed in the harness

  blob = new Map<string, unknown>();
  pushCalls = [];
  // Default push impl: one subscription delivered, nothing pruned.
  pushImpl = async () => ({ sent: 1, pruned: 0, skipped: null });

  setUsers();
  blob.set("jobs.json", {
    jobs: [
      {
        id: "job-x",
        name: "Job X",
        areaGroups: [{ areas: [{ id: "dw-1", name: "Unit 1" }] }],
      },
    ],
  });
  setEntry("u_field", "tradie", "job-x");
  setEntry("u_field2", "tradie", "job-x");

  for (const modulePath of [
    blobSdkPath,
    blobPath,
    authPath,
    timeEntriesLibPath,
    activityPath,
    pushPath,
    cronAuthPath,
    notifyRoutingPath,
    notifyPath,
    approvePath,
    bulkApprovePath,
    snagQuickRaisePath,
    snagNotifyPath,
    notificationsPath,
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
  } as NodeJS.Module;
  // The REAL push.js boundary, faked: notify() requires this module, so the
  // mock proves the engine forwards the same userId + payload + counts.
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: {
      sendPushToUserId: vi.fn(async (userId: string, payload: Payload) => {
        pushCalls.push({ userId, payload });
        return pushImpl(userId, payload);
      }),
      getWebPush: vi.fn(() => ({})), // non-null → crons proceed past the VAPID guard
    },
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
    }),
  );

  auth = requireFromHere(authPath);
  approve = requireFromHere(approvePath);
  bulkApprove = requireFromHere(bulkApprovePath);
  snagQuickRaise = requireFromHere(snagQuickRaisePath);
  snagNotify = requireFromHere(snagNotifyPath);
  notifications = requireFromHere(notificationsPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. Same recipients + payload as before, for default prefs ─────────

describe("migrated call-sites push the same recipients + payload (default prefs)", () => {
  it("approve → /phil/my-day to the worker, byte-identical payload", async () => {
    const res = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(res.statusCode).toBe(200);
    expect(pushCalls).toEqual([
      {
        userId: "u_field",
        payload: {
          title: "Hours approved",
          body: `8.0 hrs on ${TODAY} approved by office.`,
          url: "/phil/my-day",
          tag: `buhl-hours-approved-${TODAY}`,
        },
      },
    ]);
  });

  it("bulk-approve → one push per entry, per-recipient (not per-batch)", async () => {
    const res = await call(bulkApprove, "u_office", "office", {
      entries: [
        { userId: "u_field", date: TODAY },
        { userId: "u_field2", date: TODAY },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { approvedCount: number }).approvedCount).toBe(2);
    expect(pushCalls.map((c) => c.userId).sort()).toEqual(["u_field", "u_field2"]);
    expect(pushCalls.find((c) => c.userId === "u_field")!.payload.url).toBe("/phil/my-day");
  });

  it("snag-quick-raise → assignee push on /phil/jobs/<id>#phil-job-snags", async () => {
    const res = await call(
      snagQuickRaise,
      "u_office",
      "office",
      { dwelling: "dw-1", desc: "Loose RCD", priority: "High", assignedToUserId: "u_field" },
      { jobId: "job-x" },
    );
    expect(res.statusCode).toBe(201);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toMatchObject({
      userId: "u_field",
      payload: {
        title: "⚠ HIGH · Snag assigned to you",
        url: "/phil/jobs/job-x#phil-job-snags",
      },
    });
    expect(pushCalls[0]!.payload.body).toBe("[Job X] Loose RCD");
  });

  it("snag-notify (assigned) routes through the engine to the assignee", async () => {
    const res = await call(snagNotify, "u_office", "office", {
      userId: "u_field",
      kind: "assigned",
      jobId: "job-x",
      snag: { id: "s1", desc: "Cracked tile", priority: "Medium", jobName: "Job X" },
    });
    expect(res.statusCode).toBe(200);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toMatchObject({
      userId: "u_field",
      payload: { title: "Snag assigned to you", url: "/phil/jobs/job-x#phil-job-snags" },
    });
  });

  it("stale-snags cron fans out to admin-tier subscribers with the unchanged payload", async () => {
    // One open High snag, aged well past its 3-day threshold.
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    blob.set("jobs/job-x/data.json", {
      snags: [{ id: "s_old", status: "Open", priority: "High", createdAt: oldIso }],
    });
    const res = createRes();
    await notifications(
      { method: "GET", query: { action: "send-stale-snags" }, headers: {}, body: undefined },
      res,
    );
    expect(res.statusCode).toBe(200);
    // Only the office admin-tier user has a subscription + is unarchived here.
    expect(pushCalls.map((c) => c.userId)).toEqual(["u_office"]);
    expect(pushCalls[0]!.payload).toMatchObject({ title: "Snags need triage", url: "/command-centre" });
    expect((res.body as { sent: number }).sent).toBe(1);
  });
});

// ── 2 + 3. Muting suppresses one user only; missing prefs default true ─

describe("a muted pref suppresses that event for that user only", () => {
  it("approve: muting hoursApproved on the recipient suppresses the push entirely", async () => {
    setUsers([]);
    // Re-point u_field with the type muted.
    const users = blob.get("users.json") as { users: Array<Record<string, unknown>> };
    users.users.find((u) => u.id === "u_field")!.notificationPrefs = { hoursApproved: false };
    blob.set("users.json", users);

    const res = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(res.statusCode).toBe(200); // business flow still succeeds
    expect((res.body as { entry: { status: string } }).entry.status).toBe("approved");
    expect(pushCalls).toHaveLength(0); // …but no push
  });

  it("bulk-approve: a muted recipient is suppressed while an unmuted one still fires", async () => {
    const users = blob.get("users.json") as { users: Array<Record<string, unknown>> };
    users.users.find((u) => u.id === "u_field")!.notificationPrefs = { hoursApproved: false };
    blob.set("users.json", users);

    const res = await call(bulkApprove, "u_office", "office", {
      entries: [
        { userId: "u_field", date: TODAY }, // muted
        { userId: "u_field2", date: TODAY }, // default → still pushed
      ],
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { approvedCount: number }).approvedCount).toBe(2); // both approved
    expect(pushCalls.map((c) => c.userId)).toEqual(["u_field2"]); // only the unmuted push
  });

  it("stale-snags: a muted admin is suppressed while an unmuted admin still receives", async () => {
    // Add a second admin who muted staleSnags.
    setUsers([
      { id: "u_admin2", username: "boss", role: "admin", pushSubscriptions: SUB, notificationPrefs: { staleSnags: false } },
    ]);
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    blob.set("jobs/job-x/data.json", {
      snags: [{ id: "s_old", status: "Open", priority: "High", createdAt: oldIso }],
    });
    const res = createRes();
    await notifications(
      { method: "GET", query: { action: "send-stale-snags" }, headers: {}, body: undefined },
      res,
    );
    expect(res.statusCode).toBe(200);
    // u_office (default) receives; u_admin2 (muted) does not.
    expect(pushCalls.map((c) => c.userId)).toEqual(["u_office"]);
  });

  it("missing prefs object defaults to true — the recipient still gets the push", async () => {
    // u_field has NO notificationPrefs at all in the default fixture.
    const res = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(res.statusCode).toBe(200);
    expect(pushCalls.map((c) => c.userId)).toEqual(["u_field"]);
  });

  it("muting a DIFFERENT type does not suppress this one", async () => {
    const users = blob.get("users.json") as { users: Array<Record<string, unknown>> };
    users.users.find((u) => u.id === "u_field")!.notificationPrefs = { snagAssigned: false };
    blob.set("users.json", users);
    const res = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(res.statusCode).toBe(200);
    expect(pushCalls.map((c) => c.userId)).toEqual(["u_field"]); // hoursApproved still on
  });
});

// ── 4 + 5. Push failure never fails the business flow; prune preserved ─

describe("best-effort delivery + prune passthrough", () => {
  it("a throwing push never fails the approval response", async () => {
    pushImpl = async () => {
      throw new Error("push service down");
    };
    const res = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(res.statusCode).toBe(200);
    expect((res.body as { entry: { status: string } }).entry.status).toBe("approved");
  });

  it("a push that prunes a dead subscription is reflected in the cron's counts", async () => {
    pushImpl = async () => ({ sent: 0, pruned: 1, skipped: null });
    const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    blob.set("jobs/job-x/data.json", {
      snags: [{ id: "s_old", status: "Open", priority: "High", createdAt: oldIso }],
    });
    const res = createRes();
    await notifications(
      { method: "GET", query: { action: "send-stale-snags" }, headers: {}, body: undefined },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sent: 0, pruned: 1 });
  });

  it("a recipient with no subscriptions is skipped, not an error (approve still 200)", async () => {
    pushImpl = async () => ({ sent: 0, pruned: 0, skipped: "no subscriptions" });
    const res = await call(approve, "u_office", "office", { userId: "u_field", date: TODAY });
    expect(res.statusCode).toBe(200);
    // The engine still attempted delivery (push.js decides "no subs" internally).
    expect(pushCalls.map((c) => c.userId)).toEqual(["u_field"]);
  });
});
